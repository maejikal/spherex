"""Orchestrates the blink viewer: source discovery, cutout extraction, display rendering, caching.

FastAPI runs the (synchronous) handlers in a thread pool, so every method here may be called from several
threads at once. A single lock guards the caches and also serialises the CPU-bound work, which keeps peak
memory predictable and makes the JSON request and the two image requests that follow it share one result.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from pathlib import Path

from ..config import Settings
from ..models.errors import FitsNoCoverage, FitsUnavailable, InvalidParameters
from ..utils.ttl_cache import TTLCache
from .fits_cutout import CutoutSet, FitsFrameInfo, extract_cutouts, inspect_fits
from .fits_display import DisplayParameters, render_frames

log = logging.getLogger("skyexplorer.blink")

WAVELENGTH_WARNING_UM = 0.05
COORDINATE_DECIMALS = 6


@dataclass(frozen=True)
class BlinkResult:
    cutouts: CutoutSet
    images: dict[str, bytes]  # frame id -> PNG
    display: DisplayParameters
    common_coverage_fraction: float
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class LocalBlinkProfile:
    id: str
    label: str
    files: tuple[Path, ...]


class BlinkService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._lock = threading.Lock()
        self._infos: dict[Path, FitsFrameInfo] = {}
        self._results: TTLCache[BlinkResult] = TTLCache(settings.blink_cache_entries, settings.blink_cache_ttl_seconds)
        self._profiles = {
            "default": LocalBlinkProfile(
                id="default",
                label="Local demo (real SPHEREx)",
                files=tuple(Path(path).expanduser() for path in settings.blink_fits_files),
            )
        }
        for profile in settings.blink_local_profiles:
            self._profiles[profile.id] = LocalBlinkProfile(
                id=profile.id,
                label=profile.label,
                files=tuple(Path(path).expanduser() for path in profile.files),
            )

    def available_profiles(self) -> list[dict[str, str]]:
        """Return only named pairs whose fixed server-side files are present."""
        return [
            {"id": profile.id, "label": profile.label}
            for profile in self._profiles.values()
            if len(profile.files) >= 2 and all(path.is_file() for path in profile.files)
        ]

    # -- sources ---------------------------------------------------------------------------------

    def _sources(self, profile_id: str) -> list[FitsFrameInfo]:
        """Validated exposures in observation order. Re-validated whenever a file changes on disk."""
        profile = self._profiles.get(profile_id)
        if profile is None:
            raise InvalidParameters("Unknown local FITS profile.")
        paths = profile.files
        if len(paths) < 2:
            raise FitsUnavailable("The blink viewer needs two SPHEREx FITS files; set SKY_BLINK_FITS_FILES.")
        infos: list[FitsFrameInfo] = []
        for path in paths:
            cached = self._infos.get(path)
            if cached is not None:
                try:
                    stat = path.stat()
                    if (stat.st_mtime_ns, stat.st_size) == cached.signature:
                        infos.append(cached)
                        continue
                except OSError:
                    pass  # fall through: inspect_fits raises a clear FitsUnavailable
            info = inspect_fits(path)
            self._infos[path] = info
            infos.append(info)
        infos.sort(key=lambda i: i.mjd)
        if len({i.frame_id for i in infos}) != len(infos):
            raise FitsUnavailable("The configured FITS files were observed in the same month; expected two epochs.")
        return infos

    # -- public API ------------------------------------------------------------------------------

    def cutouts(self, ra: float, dec: float, size: int | None, profile_id: str = "default") -> BlinkResult:
        size = self._validate_size(size)
        ra, dec = round(ra, COORDINATE_DECIMALS), round(dec, COORDINATE_DECIMALS)
        with self._lock:
            infos = self._sources(profile_id)
            key = f"{profile_id}|{ra:.{COORDINATE_DECIMALS}f}|{dec:.{COORDINATE_DECIMALS}f}|{size}|" + "|".join(
                f"{i.path}:{i.signature[0]}:{i.signature[1]}" for i in infos
            )
            cached = self._results.get(key)
            if cached is not None:
                return cached
            result = self._compute(infos, ra, dec, size)
            self._results.set(key, result)
            return result

    def select_cutouts(self, ra: float, dec: float, size: int | None) -> tuple[str, BlinkResult]:
        """First usable local pair in configuration order, using real WCS/valid-pixel coverage.

        Explicit profile requests remain supported. Image URLs pin the chosen profile, so
        subsequent image fetches never repeat selection or mix observations.
        """
        size = self._validate_size(size)
        profiles = self.available_profiles()
        if not profiles:
            # Preserve the actionable missing-file/configuration error.
            return "default", self.cutouts(ra, dec, size)
        unavailable: FitsUnavailable | None = None
        for profile in profiles:
            try:
                return profile["id"], self.cutouts(ra, dec, size, profile["id"])
            except FitsNoCoverage:
                continue
            except FitsUnavailable as error:
                unavailable = error
        if unavailable is not None:
            # A broken pair may cover this target; do not misreport that as no coverage.
            raise unavailable
        raise FitsNoCoverage(
            "No usable SPHEREx observations are available for this selected region. "
            "Local files cover only limited areas of sky."
        )

    def image(self, ra: float, dec: float, size: int | None, frame_id: str, profile_id: str = "default") -> bytes:
        result = self.cutouts(ra, dec, size, profile_id)
        try:
            return result.images[frame_id]
        except KeyError:
            raise InvalidParameters(f"Unknown frame '{frame_id}'.") from None

    # -- internals -------------------------------------------------------------------------------

    def _validate_size(self, size: int | None) -> int:
        s = self._settings
        size = s.blink_default_size if size is None else size
        if not s.blink_min_size <= size <= s.blink_max_size:
            raise InvalidParameters(f"size must be between {s.blink_min_size} and {s.blink_max_size} pixels.")
        return size

    def _compute(self, infos: list[FitsFrameInfo], ra: float, dec: float, size: int) -> BlinkResult:
        s = self._settings
        cutouts = extract_cutouts(infos, ra, dec, size, s.blink_pixel_scale_arcsec)
        unusable = [f for f in cutouts.frames if f.coverage_fraction < s.blink_min_coverage_fraction]
        if unusable:
            raise FitsNoCoverage(self._no_coverage_message(infos))

        images, display = render_frames(cutouts.frames)
        common = cutouts.frames[0].valid.copy()
        for frame in cutouts.frames[1:]:
            common &= frame.valid
        return BlinkResult(
            cutouts=cutouts,
            images={f.info.frame_id: png for f, png in zip(cutouts.frames, images)},
            display=display,
            common_coverage_fraction=float(common.mean()),
            warnings=tuple(self._warnings(cutouts)),
        )

    @staticmethod
    def _no_coverage_message(infos: list[FitsFrameInfo]) -> str:
        ra = sum(i.centre[0] for i in infos) / len(infos)
        dec = sum(i.centre[1] for i in infos) / len(infos)
        return (
            "No usable SPHEREx observations are available for this selected region. "
            f"The two local exposures cover only a small area around RA {ra:.2f}°, Dec {dec:+.2f}°."
        )

    def _warnings(self, cutouts: CutoutSet) -> list[str]:
        full = self._settings.blink_full_coverage_fraction
        notes: list[str] = []
        for frame in cutouts.frames:
            if frame.coverage_fraction < full:
                notes.append(
                    f"Partial coverage: {frame.info.label} has usable data for {frame.coverage_fraction:.0%} of this "
                    "field. Uncovered or flagged areas are transparent."
                )
        waves = [(f.info.label, f.wavelength_um) for f in cutouts.frames]
        if all(w is not None for _, w in waves):
            means = [w[2] for _, w in waves if w is not None]
            if max(means) - min(means) >= WAVELENGTH_WARNING_UM:
                detail = " vs ".join(f"{label} {w[2]:.2f} µm" for label, w in waves if w is not None)
                notes.append(
                    f"The two exposures sampled different wavelengths at this position ({detail}), "
                    "so brightness differences may be spectral rather than real variability."
                )
        return notes
