"""NASA/IPAC IRSA access for the dynamic blink viewer: SIA2 discovery and on-demand FITS cutouts.

Both are synchronous (they run in FastAPI's thread pool next to the CPU-bound FITS work). The archive is
known to answer HTTP 502 intermittently, so every call has bounded retries with exponential backoff and
jitter, explicit connect/read timeouts, and raises a clear typed error when it gives up.
"""

from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import random
import threading
import time
import uuid
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar
from urllib.parse import urlencode, urlparse

import httpx
import numpy as np
from astropy.io import fits
from astropy.io.votable import parse_single_table
from astropy.wcs import WCS

from ..config import Settings
from ..models.errors import UpstreamInvalidResponse, UpstreamTimeout, UpstreamUnavailable
from ..utils.ttl_cache import TTLCache
from .pair_selection import SiaObservation, observations_from_table

log = logging.getLogger("skyexplorer.irsa")
T = TypeVar("T")

RETRY_STATUS = frozenset({429, 500, 502, 503, 504})
MAX_SIA_BYTES = 25 * 1024 * 1024
PROCESSING_VERSION = "1"  # bump to invalidate cached cutouts if how they are requested/validated changes
SIA_RADIUS_DEG = 0.001
REQUIRED_EXTENSIONS = ("IMAGE", "FLAGS", "VARIANCE", "WCS-WAVE")
HEADER_RANGE_SIZES = (96 * 1024, 512 * 1024)  # bytes requested from the start of a full file; the IMAGE header is ~25 KB
_BLOCK, _CARD = 2880, 80


class CutoutCorrupt(ValueError):
    """A downloaded file is not a usable SPHEREx cutout."""


class HeaderIncomplete(ValueError):
    """The bytes received do not yet contain the whole IMAGE header."""


def parse_image_header(data: bytes) -> fits.Header:
    """The IMAGE (second HDU) header from the first bytes of a SPHEREx FITS file (primary HDU has no data)."""
    text = data.decode("latin-1")
    cards = [text[i : i + _CARD] for i in range(0, len(text) - _CARD + 1, _CARD)]
    per_block = _BLOCK // _CARD
    first_end = next((i for i, c in enumerate(cards) if c.startswith("END     ")), None)
    if first_end is None or not cards[0].startswith("SIMPLE"):
        raise HeaderIncomplete("not the start of a FITS file")
    start = -(-(first_end + 1) // per_block) * per_block  # the next header begins on a block boundary
    second_end = next((i for i in range(start, len(cards)) if cards[i].startswith("END     ")), None)
    if second_end is None:
        raise HeaderIncomplete("IMAGE header continues past the bytes received")
    header = fits.Header.fromstring("".join(cards[start : second_end + 1]), sep="")
    if str(header.get("XTENSION", "")).strip() != "IMAGE" or header.get("NAXIS") != 2:
        raise CutoutCorrupt("second HDU is not a two-dimensional IMAGE")
    return header


def _with_retries(operation: Callable[[], T], *, retries: int, backoff: float, sleep: Callable[[float], None], what: str) -> T:
    attempt = 0
    while True:
        try:
            return operation()
        except (httpx.TransportError, _Retryable) as exc:
            if attempt >= retries:
                if isinstance(exc, httpx.TimeoutException):
                    raise UpstreamTimeout(f"NASA/IPAC IRSA timed out during {what}. Try again shortly.") from exc
                detail = f" (HTTP {exc.status})" if isinstance(exc, _Retryable) else ""
                raise UpstreamUnavailable(f"NASA/IPAC IRSA is currently unavailable during {what}{detail}. Try again shortly.") from exc
            sleep(backoff * (2**attempt) * (0.5 + random.random()))
            attempt += 1


class _Retryable(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"retryable status {status}")
        self.status = status


class IrsaClient:
    def __init__(self, settings: Settings, client: httpx.Client | None = None, sleep: Callable[[float], None] = time.sleep) -> None:
        self._s = settings
        self._sleep = sleep
        self._injected = client
        self._made: httpx.Client | None = None
        self._make_lock = threading.Lock()
        self._sia_cache: TTLCache[tuple[list[SiaObservation], list[str]]] = TTLCache(settings.sia_cache_entries, settings.sia_cache_ttl_seconds)
        self._cache_lock = threading.Lock()
        self._inflight: dict[str, threading.Lock] = {}

    @property
    def _client(self) -> httpx.Client:
        """Created on first use (building the TLS context is slow and most processes never reach the archive)."""
        if self._injected is not None:
            return self._injected
        with self._make_lock:
            if self._made is None:
                self._made = httpx.Client(
                    timeout=httpx.Timeout(connect=self._s.irsa_connect_timeout, read=self._s.irsa_sia_read_timeout, write=10.0, pool=10.0),
                    headers={"User-Agent": self._s.user_agent},
                    follow_redirects=False,
                    limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
                )
            return self._made

    def close(self) -> None:
        if self._made is not None:
            self._made.close()

    # -- SIA2 -------------------------------------------------------------------------------------
    def search(self, ra: float, dec: float) -> tuple[list[SiaObservation], list[str]]:
        """Observations whose footprint contains (ra, dec), with per-record problems. Cached per position."""
        key = f"{ra:.4f}|{dec:.4f}|{self._s.irsa_collection}"
        with self._cache_lock:
            hit = self._sia_cache.get(key)
            gate = self._inflight.setdefault(key, threading.Lock())
        if hit is not None:
            return hit
        with gate:  # concurrent identical searches share one archive round-trip
            with self._cache_lock:
                hit = self._sia_cache.get(key)
            if hit is not None:
                return hit
            result = self._search_uncached(ra, dec)
            with self._cache_lock:
                self._sia_cache.set(key, result)
            return result

    def _search_uncached(self, ra: float, dec: float) -> tuple[list[SiaObservation], list[str]]:
        params = {"COLLECTION": self._s.irsa_collection, "POS": f"CIRCLE {ra:.6f} {dec:.6f} {SIA_RADIUS_DEG}"}

        def once() -> bytes:
            response = self._client.get(self._s.irsa_sia_url, params=params)
            if response.status_code in RETRY_STATUS:
                raise _Retryable(response.status_code)
            if response.status_code != 200:
                raise UpstreamInvalidResponse(f"IRSA SIA returned HTTP {response.status_code}.")
            if len(response.content) > MAX_SIA_BYTES:
                raise UpstreamInvalidResponse("IRSA SIA response is unexpectedly large.")
            return response.content

        content = _with_retries(once, retries=self._s.irsa_max_retries, backoff=self._s.irsa_backoff_base, sleep=self._sleep, what="the observation search")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                table = parse_single_table(io.BytesIO(content)).to_table(use_names_over_ids=True)
        except Exception as exc:  # astropy raises several XML/votable exception types
            raise UpstreamInvalidResponse("IRSA SIA returned a response that is not a VOTable.") from exc
        rows = [{name: row[name] for name in table.colnames} for row in table]
        observations, problems = observations_from_table(rows)
        allowed = {h.lower() for h in self._s.irsa_allowed_hosts}
        kept = []
        for obs in observations:
            if (urlparse(obs.access_url).hostname or "").lower() in allowed:
                kept.append(obs)
            else:
                problems.append(f"{obs.obs_id}: access_url host not allowed")
        if problems:
            log.info("SIA: %d record problem(s), first: %s", len(problems), problems[0])
        return kept, problems

    # -- headers ----------------------------------------------------------------------------------
    def read_prefix(self, url: str, size: int) -> bytes:
        """The first ``size`` bytes of a file (HTTP Range; if the server ignores it, the stream is simply cut short)."""
        parsed = urlparse(url)
        if parsed.scheme != "https" or (parsed.hostname or "").lower() not in {h.lower() for h in self._s.irsa_allowed_hosts}:
            raise UpstreamInvalidResponse("Refusing to read from a host that is not on the IRSA allow-list.")
        timeout = httpx.Timeout(connect=self._s.irsa_connect_timeout, read=self._s.irsa_sia_read_timeout, write=10.0, pool=10.0)

        def once() -> bytes:
            with self._client.stream("GET", url, headers={"Range": f"bytes=0-{size - 1}"}, timeout=timeout) as response:
                if response.status_code in RETRY_STATUS:
                    raise _Retryable(response.status_code)
                if response.status_code not in (200, 206):
                    raise UpstreamInvalidResponse(f"IRSA returned HTTP {response.status_code} for the file header.")
                chunks, got = [], 0
                for chunk in response.iter_bytes(1 << 15):
                    chunks.append(chunk)
                    got += len(chunk)
                    if got >= size:
                        break
                return b"".join(chunks)[:size]

        return _with_retries(once, retries=self._s.irsa_max_retries, backoff=self._s.irsa_backoff_base, sleep=self._sleep, what="the FITS header request")

    def fetch_image_header(self, url: str) -> fits.Header:
        return _fetch_header_once(self, url.split("?")[0])

    # -- downloads --------------------------------------------------------------------------------
    def download(self, url: str, destination: Path) -> None:
        """Stream ``url`` to ``destination`` (restricted to the allow-listed IRSA hosts, size-capped)."""
        parsed = urlparse(url)
        if parsed.scheme != "https" or (parsed.hostname or "").lower() not in {h.lower() for h in self._s.irsa_allowed_hosts}:
            raise UpstreamInvalidResponse("Refusing to download from a host that is not on the IRSA allow-list.")
        timeout = httpx.Timeout(connect=self._s.irsa_connect_timeout, read=self._s.irsa_download_read_timeout, write=10.0, pool=10.0)

        def once() -> None:
            with self._client.stream("GET", url, timeout=timeout) as response:
                if response.status_code in RETRY_STATUS:
                    raise _Retryable(response.status_code)
                if response.status_code != 200:
                    raise UpstreamInvalidResponse(f"IRSA returned HTTP {response.status_code} for the cutout.")
                size = 0
                with destination.open("wb") as fh:
                    for chunk in response.iter_bytes(1 << 16):
                        size += len(chunk)
                        if size > self._s.irsa_max_download_bytes:
                            raise UpstreamInvalidResponse("IRSA cutout exceeds the download size limit.")
                        fh.write(chunk)

        _with_retries(once, retries=self._s.irsa_max_retries, backoff=self._s.irsa_backoff_base, sleep=self._sleep, what="the FITS download")


def _fetch_header_once(irsa: "IrsaClient", url: str) -> fits.Header:
    for size in HEADER_RANGE_SIZES:
        data = irsa.read_prefix(url, size)
        try:
            return parse_image_header(data)
        except HeaderIncomplete:
            continue
    raise UpstreamInvalidResponse("Could not read the archive FITS header.")


def validate_cutout(path: Path) -> None:
    """Raise CutoutCorrupt unless ``path`` is a complete SPHEREx cutout with every extension we rely on."""
    try:
        with fits.open(path, memmap=False) as hdul:
            names = [str(h.name).upper() for h in hdul]
            missing = [n for n in REQUIRED_EXTENSIONS if n not in names]
            if missing:
                raise CutoutCorrupt(f"missing extension(s): {', '.join(missing)}")
            shapes = {n: np.shape(hdul[n].data) for n in ("IMAGE", "FLAGS", "VARIANCE")}
            if len(shapes["IMAGE"]) != 2 or min(shapes["IMAGE"]) < 2 or len(set(shapes.values())) != 1:
                raise CutoutCorrupt(f"inconsistent image shapes {shapes}")
            if not WCS(hdul["IMAGE"].header).has_celestial:
                raise CutoutCorrupt("IMAGE has no celestial WCS")
    except CutoutCorrupt:
        raise
    except Exception as exc:  # truncated or non-FITS content surfaces as many types
        raise CutoutCorrupt(f"not a readable FITS file ({type(exc).__name__}: {exc})") from exc


class CutoutStore:
    """Disk cache of IRSA cutouts, keyed by everything that determines their content.

    The key covers observation, archive URL, release, position, size, overscan and the processing version,
    so different coordinates can never reuse each other's file. Files are written to a unique temporary
    name, validated, and moved into place atomically; concurrent requests for one key share one download;
    total size is bounded and the least recently used files are evicted.
    """

    def __init__(self, settings: Settings, irsa: IrsaClient) -> None:
        self._s = settings
        self._irsa = irsa
        self._dir = Path(settings.blink_cache_dir).expanduser() / "cutouts"
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    @staticmethod
    def cache_key(obs: SiaObservation, ra: float, dec: float, size_deg: float, overscan: float) -> str:
        payload = json.dumps({
            "obs": obs.obs_id, "det": obs.detector, "url": obs.access_url.split("?")[0], "release": obs.release,
            "ra": round(ra, 6), "dec": round(dec, 6), "size": round(size_deg, 6), "overscan": round(overscan, 4), "v": PROCESSING_VERSION,
        }, sort_keys=True)
        return hashlib.sha256(payload.encode()).hexdigest()[:24]

    def path_for(self, obs: SiaObservation, ra: float, dec: float, size_deg: float, overscan: float) -> Path:
        return self._dir / f"{obs.obs_id}_{obs.detector}_{self.cache_key(obs, ra, dec, size_deg, overscan)}.fits"

    def get(self, obs: SiaObservation, ra: float, dec: float, size_deg: float, overscan: float | None = None) -> Path:
        """A validated local cutout of ``size_deg * overscan`` degrees (downloading it if needed)."""
        overscan = self._s.dynamic_overscan if overscan is None else overscan
        target = self.path_for(obs, ra, dec, size_deg, overscan)
        with self._guard:
            lock = self._locks.setdefault(target.name, threading.Lock())
        with lock:
            if target.exists():
                try:
                    validate_cutout(target)
                    os.utime(target)  # LRU: mark as recently used
                    return target
                except CutoutCorrupt:
                    log.warning("discarding corrupt cached cutout %s", target.name)
                    target.unlink(missing_ok=True)
            self._dir.mkdir(parents=True, exist_ok=True)
            query = urlencode({"center": f"{ra:.6f},{dec:.6f}d", "size": f"{size_deg * overscan:.6f}"})
            tmp = target.with_name(f"{target.name}.{uuid.uuid4().hex}.part")
            try:
                self._irsa.download(f"{obs.access_url.split('?')[0]}?{query}", tmp)
                try:
                    validate_cutout(tmp)
                except CutoutCorrupt as exc:
                    raise UpstreamInvalidResponse(f"IRSA returned an unusable cutout for {obs.obs_id}: {exc}") from exc
                os.replace(tmp, target)
            finally:
                tmp.unlink(missing_ok=True)
        self._evict(keep=target)
        return target

    def _evict(self, keep: Path) -> None:
        try:
            now = time.time()
            files = []
            for p in self._dir.iterdir():
                try:
                    st = p.stat()
                except OSError:
                    continue
                if p.suffix == ".part" and now - st.st_mtime > 3600:
                    p.unlink(missing_ok=True)  # stale partial download from a crashed request
                elif p.suffix == ".fits":
                    files.append((st.st_mtime, st.st_size, p))
            total = sum(size for _, size, _ in files)
            for _, size, p in sorted(files, key=lambda t: t[0]):
                if total <= self._s.blink_cache_max_bytes:
                    break
                if p != keep:
                    p.unlink(missing_ok=True)
                    total -= size
        except OSError as exc:
            log.warning("cutout cache eviction failed: %s", exc)


class FullHeaderStore:
    """The IMAGE header of each *full* detector image, fetched with a small HTTP range request and cached.

    It supplies what a cutout does not record: the original CRPIX and WCS (which differ between normal and
    reprocessed "retry" images), so cutout pixels can be mapped to the full-detector coordinates the
    wavelength calibration is defined in.
    """

    def __init__(self, settings: Settings, irsa: IrsaClient) -> None:
        self._irsa = irsa
        self._dir = Path(settings.blink_cache_dir).expanduser() / "headers"
        self._memory: dict[str, fits.Header] = {}
        self._lock = threading.Lock()
        self._gates: dict[str, threading.Lock] = {}

    def _path(self, url: str) -> Path:
        return self._dir / f"{hashlib.sha256(url.split('?')[0].encode()).hexdigest()[:32]}.hdr"

    def get(self, obs: SiaObservation) -> fits.Header:
        url = obs.access_url.split("?")[0]
        with self._lock:
            hit = self._memory.get(url)
            gate = self._gates.setdefault(url, threading.Lock())
        if hit is not None:
            return hit.copy()
        with gate:
            with self._lock:
                hit = self._memory.get(url)
            if hit is None:
                hit = self._read_disk(url) or self._fetch_and_store(url)
                with self._lock:
                    self._memory[url] = hit
        return hit.copy()

    def _read_disk(self, url: str) -> fits.Header | None:
        path = self._path(url)
        try:
            header = fits.Header.fromstring(path.read_text(encoding="latin-1"), sep="\n")
            return header if header.get("NAXIS") == 2 and "CRPIX1" in header else None
        except (OSError, ValueError):
            return None

    def _fetch_and_store(self, url: str) -> fits.Header:
        header = self._irsa.fetch_image_header(url)
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            path = self._path(url)
            tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.part")
            tmp.write_text(header.tostring(sep="\n"), encoding="latin-1")
            os.replace(tmp, path)
        except OSError as exc:
            log.warning("could not cache header: %s", exc)
        return header
