"""NASA/IPAC IRSA SPHEREx HiPS cube: metadata provider.

Verified live (2026-11-14, ``<hips>/properties``):

* ``dataproduct_type = cube``, ``hips_cube_depth = 102``, 512 px 8-bit PNG tiles, orders 0-5, all-sky
  MOC (``moc_sky_fraction = 1``), ``access-control-allow-origin: *``.
* One tile file per cube frame: ``Norder<N>/Dir<D>/Npix<P>_<frame>.png`` with a **0-based** frame.
* ``data_cube_crval3_arr`` lists the wavelength (um) of every frame; frames 50 and 51 (band 3
  channel 17, band 4 channel 1, the dichroic channels) are documented as blank and have no tiles.

Aladin Lite fetches tiles directly in the browser; this provider only reads the descriptive metadata.
"""

from __future__ import annotations

import math
import re

from ..config import Settings
from ..models.errors import UpstreamInvalidResponse
from ..utils.ttl_cache import TTLCache
from .base import SpectralChannel, SurveyInfo
from .http import UpstreamClient

CHANNELS_PER_BAND = 17
SURVEY_ID = "spherex"


def parse_properties(text: str) -> dict[str, str]:
    """Parse a HiPS ``properties`` document (``key = value`` lines, ``#`` comments)."""
    result: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip():
            result[key.strip()] = value.strip()
    return result


def parse_blank_frames(description: str, depth: int) -> list[int]:
    """Frames the service documents as blank ("Frames 50 and 51 (...) are blank"), same 0-based index."""
    sentence = re.search(r"Frames?\s+((?:\d+\s*(?:,|and|&)?\s*)+)[^.]*?\bare\s+blank", description, re.IGNORECASE)
    if not sentence:
        return []
    return sorted({n for n in map(int, re.findall(r"\d+", sentence.group(1))) if 0 <= n < depth})


def _number(props: dict[str, str], key: str) -> float:
    try:
        value = float(props[key])
    except (KeyError, ValueError) as exc:
        raise UpstreamInvalidResponse(f"SPHEREx HiPS property '{key}' is missing or not numeric.") from exc
    if not math.isfinite(value):
        raise UpstreamInvalidResponse(f"SPHEREx HiPS property '{key}' is not finite.")
    return value


def build_survey_info(props: dict[str, str], hips_url: str) -> SurveyInfo:
    """Validate that the document is the SPHEREx cube and convert it. Raises on anything unexpected."""
    if "SPHEREx" not in props.get("creator_did", "") and "SPHEREx" not in props.get("obs_collection", ""):
        raise UpstreamInvalidResponse("HiPS properties do not identify a SPHEREx dataset.")
    if props.get("dataproduct_type") != "cube":
        raise UpstreamInvalidResponse("SPHEREx HiPS is not a spectral cube.")
    if props.get("hips_frame") != "equatorial":
        raise UpstreamInvalidResponse("SPHEREx HiPS uses an unsupported coordinate frame.")
    depth = int(_number(props, "hips_cube_depth"))
    try:
        wavelengths = [float(v) for v in props.get("data_cube_crval3_arr", "").split()]
    except ValueError as exc:
        raise UpstreamInvalidResponse("SPHEREx wavelength table is not numeric.") from exc
    if len(wavelengths) != depth or depth < 1 or any(not math.isfinite(w) or w <= 0 for w in wavelengths):
        raise UpstreamInvalidResponse("SPHEREx wavelength table does not match the cube depth.")
    if props.get("data_cube_bunit3") != "um":
        raise UpstreamInvalidResponse("SPHEREx wavelength table has an unexpected unit.")

    blank = set(parse_blank_frames(props.get("obs_description", ""), depth))
    channels = tuple(
        SpectralChannel(
            frame=i,
            band=i // CHANNELS_PER_BAND + 1,
            band_channel=i % CHANNELS_PER_BAND + 1,
            wavelength_um=w,
            has_data=i not in blank,
        )
        for i, w in enumerate(wavelengths)
    )
    window = None
    if "t_min" in props and "t_max" in props:
        try:
            window = (float(props["t_min"]), float(props["t_max"]))
        except ValueError:
            window = None
    sky_fraction = None
    try:
        sky_fraction = float(props["moc_sky_fraction"])
    except (KeyError, ValueError):
        pass
    return SurveyInfo(
        id=SURVEY_ID,
        name=props.get("obs_title", "SPHEREx all-sky data cube"),
        release=props.get("obs_collection", "SPHEREx").replace("SPHEREx ", "") or "DR1",
        available=True,
        description=props.get("obs_description", ""),
        data_source="NASA/IPAC Infrared Science Archive (IRSA)",
        hips_url=hips_url,
        tile_format=props.get("hips_tile_format", "").split()[0] or None,
        tile_width=int(_number(props, "hips_tile_width")),
        max_order=int(_number(props, "hips_order")),
        coordinate_frame="ICRS (HiPS frame: equatorial)",
        sky_fraction=sky_fraction,
        observation_window_mjd=window,
        channels=channels,
    )


class SphereXHiPSProvider:
    survey_id = SURVEY_ID

    def __init__(self, upstream: UpstreamClient, settings: Settings) -> None:
        self._upstream = upstream
        self._settings = settings
        self._cache: TTLCache[SurveyInfo] = TTLCache(1, settings.survey_cache_ttl_seconds)

    @property
    def hips_url(self) -> str:
        return self._settings.spherex_hips_url.rstrip("/")

    async def describe(self) -> SurveyInfo:
        cached = self._cache.get("info")
        if cached is not None:
            return cached
        response = await self._upstream.get(
            f"{self.hips_url}/properties",
            max_bytes=self._settings.max_upstream_text_bytes,
            accept="text/plain, */*",
        )
        if response.status != 200:
            raise UpstreamInvalidResponse(f"SPHEREx HiPS service returned HTTP {response.status}.")
        try:
            text = response.body.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise UpstreamInvalidResponse("SPHEREx HiPS properties are not valid text.") from exc
        info = build_survey_info(parse_properties(text), self.hips_url)
        self._cache.set("info", info)
        return info

    def tile_url(self, order: int, npix: int, frame: int) -> str:
        """Tile URL for one cube frame (used by verification tooling; browsers use Aladin Lite)."""
        directory = (npix // 10000) * 10000
        return f"{self.hips_url}/Norder{order}/Dir{directory}/Npix{npix}_{frame}.png"
