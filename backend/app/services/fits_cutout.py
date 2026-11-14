"""Scientific core of the blink viewer: real SPHEREx FITS in, aligned float32 cutouts out.

This module knows nothing about HTTP or PNG. It

* validates a SPHEREx Level-2 detector image (IMAGE HDU, celestial TAN(-SIP) WCS in ICRS, ``MJy / sr``),
* builds a shared north-up TAN grid centred on a requested sky position, and
* resamples each exposure onto that grid through its own full SIP-aware WCS.

Both exposures of a field are generally rotated relative to each other (the spacecraft's roll differs),
so raw pixel arrays must never be compared directly; only the resampled arrays returned here are
position-matched.

Resampling is bilinear interpolation of the calibrated surface brightness (MJy/sr). It is *not*
flux-conserving reprojection: at the native pixel scale it slightly smooths the data and correlates the
noise between neighbouring pixels. The arrays keep their original units (no background subtraction or
stretch) so a later difference-imaging step can reuse them.
"""

from __future__ import annotations

import calendar
import logging
import math
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS
from astropy.wcs.wcs import NoConvergence, SingularMatrixError

from ..models.errors import FitsProcessingError, FitsUnavailable

log = logging.getLogger("skyexplorer.fits")

SUPPORTED_UNITS = frozenset({"MJy / sr", "MJy/sr"})

# Quality-flag policy. The FLAGS header of the real files names every bit plane (MSKN####), so the
# policy is expressed by *name* and resolved against each file. Only planes whose header description
# says the pixel value is lost or unreliable are masked. Notably NOT masked:
#   SOURCE   - "mapped to a known source": ~31 % of pixels, i.e. the stars we want to see;
#   TRANSIENT, HALO, OUTLIER, COLD, PERSIST, CROSSTALK, GHOST*, DICHROIC, FULLSAMPLE, PHANMISS -
#              informational or soft; masking them would remove most of the frame and hide real objects.
# If a file has no FLAGS HDU, or none of these names, only non-finite pixels are masked.
BAD_FLAG_NAMES = frozenset({
    "OVERFLOW", "SUR_ERROR", "NONFUNC", "MISSING_DATA", "HOT", "NONLINEAR", "STREAK", "BLOOM", "SNOWBALL",
})

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
_SAMPLE_STRIDE = 32


@dataclass(frozen=True)
class WaveGrid:
    """Per-pixel central wavelength (µm) sampled on a coarse detector grid (from the WCS-WAVE table)."""

    x: np.ndarray  # 1-based detector column control points
    y: np.ndarray  # 1-based detector row control points
    wavelength_um: np.ndarray  # shape (len(y), len(x))


@dataclass(frozen=True)
class FitsFrameInfo:
    """Validated metadata of one exposure. Pixel data are read per request, never held here."""

    path: Path
    signature: tuple[int, int]  # (mtime_ns, size) - changes when the file is replaced
    frame_id: str  # "YYYY-MM" from the header observation date
    label: str  # "May 2025"
    date: str  # "YYYY-MM-DD"
    date_obs: str
    mjd: float
    obsid: str | None
    detector: int | None
    bunit: str
    shape: tuple[int, int]  # (rows, columns)
    header: fits.Header
    centre: tuple[float, float]  # ICRS degrees at the image centre
    radius_deg: float  # centre-to-farthest-corner angle
    bad_flag_mask: int
    wave_grid: WaveGrid | None

    def wcs(self) -> WCS:
        """A fresh WCS per use: astropy WCS objects are not guaranteed to be thread-safe."""
        return WCS(self.header)


@dataclass(frozen=True)
class ResampledFrame:
    info: FitsFrameInfo
    values: np.ndarray  # float32 (N, N) in MJy/sr; NaN where invalid. Row 0 is the southern edge.
    valid: np.ndarray  # bool (N, N)
    coverage_fraction: float
    wavelength_um: tuple[float, float, float] | None  # (min, max, mean) over valid pixels of the cutout


@dataclass(frozen=True)
class CutoutSet:
    ra: float
    dec: float
    size: int
    pixel_scale_arcsec: float
    frames: tuple[ResampledFrame, ...]


# --------------------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------------------


def inspect_fits(path: Path) -> FitsFrameInfo:
    """Open ``path`` read-only (memory-mapped) and validate it as a usable SPHEREx image."""
    path = path.expanduser()
    if not path.is_file():
        raise FitsUnavailable(
            f"SPHEREx FITS file not found: {path.name}. Set SKY_BLINK_FITS_FILES to the two local exposures."
        )
    stat = path.stat()
    try:
        with fits.open(path, memmap=True, lazy_load_hdus=True) as hdul:
            return _inspect(path, (stat.st_mtime_ns, stat.st_size), hdul)
    except FitsUnavailable:
        raise
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise FitsUnavailable(f"{path.name} could not be read as a SPHEREx FITS image ({exc}).") from exc


def _inspect(path: Path, signature: tuple[int, int], hdul: fits.HDUList) -> FitsFrameInfo:
    name = path.name
    names = [str(hdu.name).upper() for hdu in hdul]
    if "IMAGE" not in names:
        raise FitsUnavailable(f"{name} has no IMAGE extension.")
    hdu = hdul["IMAGE"]
    header = hdu.header.copy()
    if header.get("NAXIS") != 2:
        raise FitsUnavailable(f"{name}: IMAGE must be two-dimensional.")
    ny, nx = int(header["NAXIS2"]), int(header["NAXIS1"])
    if ny < 2 or nx < 2:
        raise FitsUnavailable(f"{name}: IMAGE is too small to be a science image.")

    bunit = str(header.get("BUNIT", "")).strip()
    if bunit not in SUPPORTED_UNITS:
        raise FitsUnavailable(f"{name}: unsupported image unit '{bunit}' (expected MJy / sr).")

    wcs = WCS(header)
    if not wcs.has_celestial or wcs.naxis != 2:
        raise FitsUnavailable(f"{name}: IMAGE has no celestial WCS.")
    ctypes = [str(c) for c in wcs.wcs.ctype]
    if not all(c[5:8] == "TAN" or "-TAN" in c for c in ctypes) or not ctypes[0].startswith("RA"):
        raise FitsUnavailable(f"{name}: only RA/Dec TAN(-SIP) images are supported (found {ctypes}).")
    radesys = str(header.get("RADESYS", "ICRS")).strip().upper()
    if radesys not in {"ICRS", ""}:
        raise FitsUnavailable(f"{name}: coordinate system {radesys} is not supported (ICRS expected).")

    probe_x = np.array([0, nx - 1, nx - 1, 0, (nx - 1) / 2], dtype=float)
    probe_y = np.array([0, 0, ny - 1, ny - 1, (ny - 1) / 2], dtype=float)
    ra, dec = wcs.all_pix2world(probe_x, probe_y, 0)
    if not (np.all(np.isfinite(ra)) and np.all(np.isfinite(dec))):
        raise FitsUnavailable(f"{name}: the WCS produced non-finite sky coordinates.")
    centre = (float(ra[4]) % 360.0, float(dec[4]))
    radius = float(np.max(_separation_deg(centre[0], centre[1], ra[:4], dec[:4])))

    date_obs = str(header.get("DATE-OBS", "")).strip()
    match = _DATE_RE.match(date_obs)
    mjd = header.get("MJD-OBS")
    if not match or not isinstance(mjd, (int, float)) or not math.isfinite(mjd):
        raise FitsUnavailable(f"{name}: missing DATE-OBS / MJD-OBS observation time.")
    year, month, day = (int(g) for g in match.groups())
    if not 1 <= month <= 12:
        raise FitsUnavailable(f"{name}: invalid DATE-OBS '{date_obs}'.")

    sample = np.asarray(hdu.data[::_SAMPLE_STRIDE, ::_SAMPLE_STRIDE], dtype=np.float32)
    if sample.size == 0 or float(np.isfinite(sample).mean()) < 0.5:
        raise FitsUnavailable(f"{name}: IMAGE contains no usable science data.")

    detector = header.get("DETECTOR")
    obsid = header.get("OBSID")
    return FitsFrameInfo(
        path=path,
        signature=signature,
        frame_id=f"{year:04d}-{month:02d}",
        label=f"{calendar.month_name[month]} {year}",
        date=f"{year:04d}-{month:02d}-{day:02d}",
        date_obs=date_obs,
        mjd=float(mjd),
        obsid=str(obsid).strip() if obsid else None,
        detector=int(detector) if isinstance(detector, (int, float)) else None,
        bunit=bunit,
        shape=(ny, nx),
        header=header,
        centre=centre,
        radius_deg=radius,
        bad_flag_mask=_bad_flag_mask(hdul, names),
        wave_grid=_wave_grid(hdul, names, name),
    )


def _bad_flag_mask(hdul: fits.HDUList, names: list[str]) -> int:
    """Resolve BAD_FLAG_NAMES to a bit mask using the FLAGS header's own plane names."""
    if "FLAGS" not in names:
        return 0
    mask = 0
    for key, value in hdul["FLAGS"].header.items():
        if key.startswith("MSKN") and key[4:].isdigit() and str(value).strip().upper() in BAD_FLAG_NAMES:
            mask |= 1 << int(key[4:])
    return mask


def _wave_grid(hdul: fits.HDUList, names: list[str], filename: str) -> WaveGrid | None:
    """Central wavelength per detector position from WCS-WAVE (a FITS -TAB style lookup table).

    Optional metadata: a table that does not look as expected yields ``None`` rather than a guess.
    """
    if "WCS-WAVE" not in names:
        return None
    try:
        row = hdul["WCS-WAVE"].data[0]
        x = np.asarray(row["X"], dtype=float)
        y = np.asarray(row["Y"], dtype=float)
        values = np.asarray(row["VALUES"], dtype=float)  # (len(y), len(x), 2): [wavelength, bandwidth]
        if values.shape != (y.size, x.size, 2) or not np.all(np.isfinite(values[..., 0])):
            raise ValueError(f"unexpected table shape {values.shape}")
        wavelength = values[..., 0]
        if not (0.3 < float(wavelength.min()) and float(wavelength.max()) < 6.0):  # SPHEREx: 0.75-5.0 µm
            raise ValueError("wavelength values outside the SPHEREx range")
        return WaveGrid(x=x, y=y, wavelength_um=wavelength)
    except (KeyError, IndexError, ValueError, TypeError) as exc:
        log.warning("%s: wavelength table ignored (%s)", filename, exc)
        return None


# --------------------------------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------------------------------


def _separation_deg(ra1: float, dec1: float, ra2: np.ndarray | float, dec2: np.ndarray | float) -> np.ndarray:
    """Great-circle separation (haversine), robust at small angles and across the RA wrap."""
    r1, d1 = math.radians(ra1), math.radians(dec1)
    r2, d2 = np.radians(ra2), np.radians(dec2)
    a = np.sin((d2 - d1) / 2) ** 2 + np.cos(d1) * np.cos(d2) * np.sin((r2 - r1) / 2) ** 2
    return np.degrees(2 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0))))


def build_output_wcs(ra: float, dec: float, size: int, pixel_scale_arcsec: float) -> WCS:
    """North-up, east-left TAN grid centred on (ra, dec); the centre falls between the middle pixels."""
    wcs = WCS(naxis=2)
    wcs.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    wcs.wcs.crval = [ra, dec]
    wcs.wcs.crpix = [(size + 1) / 2.0, (size + 1) / 2.0]
    step = pixel_scale_arcsec / 3600.0
    wcs.wcs.cdelt = [-step, step]
    wcs.wcs.cunit = ["deg", "deg"]
    wcs.pixel_shape = (size, size)
    return wcs


def output_sky_grid(wcs: WCS, size: int) -> tuple[np.ndarray, np.ndarray]:
    yy, xx = np.mgrid[0:size, 0:size]
    ra, dec = wcs.all_pix2world(xx.astype(float), yy.astype(float), 0)
    return np.asarray(ra, dtype=float), np.asarray(dec, dtype=float)


# --------------------------------------------------------------------------------------------------
# Resampling
# --------------------------------------------------------------------------------------------------


def bilinear_sample(image: np.ndarray, rows: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """Bilinear interpolation of ``image`` at fractional (row, col) pixel-centre positions (NumPy only).

    Neighbours that fall outside the image contribute zero, so callers wanting edge handling sample a
    validity image the same way (see ``resample_to_grid``).
    """
    ny, nx = image.shape
    r0 = np.floor(rows).astype(np.int64)
    c0 = np.floor(cols).astype(np.int64)
    fr = (rows - r0).astype(np.float32)
    fc = (cols - c0).astype(np.float32)
    out = np.zeros(rows.shape, dtype=np.float32)
    for dr, wr in ((0, 1.0 - fr), (1, fr)):
        for dc, wc in ((0, 1.0 - fc), (1, fc)):
            r, c = r0 + dr, c0 + dc
            inside = (r >= 0) & (r < ny) & (c >= 0) & (c < nx)
            out += np.where(inside, image[np.clip(r, 0, ny - 1), np.clip(c, 0, nx - 1)], 0.0) * wr * wc
    return out


def resample_to_grid(
    data: np.ndarray, valid: np.ndarray, rows: np.ndarray, cols: np.ndarray, *, min_weight: float = 0.99
) -> tuple[np.ndarray, np.ndarray]:
    """Bilinearly sample ``data`` at fractional (row, col) positions, ignoring invalid pixels.

    Invalid and out-of-image neighbours contribute zero weight; the result is normalised by the weight
    actually found and a pixel is valid only if almost its whole 2x2 stencil was valid. So invalid input
    pixels never leak into the output and the validity mask shrinks by at most one pixel at the edges.
    """
    weights = valid.astype(np.float32)
    clean = np.where(valid, data, 0.0).astype(np.float32)
    inside = np.isfinite(rows) & np.isfinite(cols)
    safe_rows, safe_cols = np.where(inside, rows, -1e6), np.where(inside, cols, -1e6)
    numerator = bilinear_sample(clean, safe_rows, safe_cols)
    weight = bilinear_sample(weights, safe_rows, safe_cols)
    ok = inside & (weight >= min_weight)
    out = np.full(rows.shape, np.nan, dtype=np.float32)
    out[ok] = numerator[ok] / weight[ok]
    return out, ok


def _empty_frame(info: FitsFrameInfo, size: int) -> ResampledFrame:
    return ResampledFrame(
        info=info,
        values=np.full((size, size), np.nan, dtype=np.float32),
        valid=np.zeros((size, size), dtype=bool),
        coverage_fraction=0.0,
        wavelength_um=None,
    )


def extract_frame(
    info: FitsFrameInfo, sky_ra: np.ndarray, sky_dec: np.ndarray, centre: tuple[float, float], half_diagonal_deg: float
) -> ResampledFrame:
    """Resample one exposure onto the output sky grid through its own SIP-aware WCS."""
    size = sky_ra.shape[0]
    separation = float(_separation_deg(centre[0], centre[1], info.centre[0], info.centre[1]))
    if separation > info.radius_deg + half_diagonal_deg:
        return _empty_frame(info, size)  # far outside the footprint: do not extrapolate the distortion

    wcs = info.wcs()
    try:
        sx, sy = wcs.all_world2pix(sky_ra, sky_dec, 0, quiet=True, tolerance=1e-4, maxiter=40, adaptive=True)
    except (NoConvergence, SingularMatrixError, ValueError) as exc:
        raise FitsProcessingError(f"{info.path.name}: sky-to-pixel transformation failed ({exc}).") from exc
    sx = np.asarray(sx, dtype=float)
    sy = np.asarray(sy, dtype=float)
    ny, nx = info.shape
    in_footprint = np.isfinite(sx) & np.isfinite(sy) & (sx >= -0.5) & (sx <= nx - 0.5) & (sy >= -0.5) & (sy <= ny - 0.5)
    if not in_footprint.any():
        return _empty_frame(info, size)

    margin = 2
    x0 = max(0, int(math.floor(sx[in_footprint].min())) - margin)
    x1 = min(nx, int(math.ceil(sx[in_footprint].max())) + margin + 1)
    y0 = max(0, int(math.floor(sy[in_footprint].min())) - margin)
    y1 = min(ny, int(math.ceil(sy[in_footprint].max())) + margin + 1)
    data, valid = _read_window(info, x0, x1, y0, y1)

    rows = np.where(in_footprint, sy - y0, np.nan)
    cols = np.where(in_footprint, sx - x0, np.nan)
    values, ok = resample_to_grid(data, valid, rows, cols)
    return ResampledFrame(
        info=info,
        values=values,
        valid=ok,
        coverage_fraction=float(ok.mean()),
        wavelength_um=_wavelength_stats(info.wave_grid, sx, sy, ok),
    )


def _read_window(info: FitsFrameInfo, x0: int, x1: int, y0: int, y1: int) -> tuple[np.ndarray, np.ndarray]:
    """Read only the needed sub-image (and its flags); the file is opened and closed per call."""
    try:
        stat = info.path.stat()
        if (stat.st_mtime_ns, stat.st_size) != info.signature:
            raise FitsUnavailable(f"{info.path.name} changed on disk; request again to reload it.")
        with fits.open(info.path, memmap=True, lazy_load_hdus=True) as hdul:
            data = np.array(hdul["IMAGE"].section[y0:y1, x0:x1], dtype=np.float32)
            valid = np.isfinite(data)
            if info.bad_flag_mask:
                flags = np.asarray(hdul["FLAGS"].section[y0:y1, x0:x1])
                valid &= (flags.astype(np.int64) & info.bad_flag_mask) == 0
    except FitsUnavailable:
        raise
    except (OSError, ValueError, KeyError, IndexError) as exc:
        raise FitsProcessingError(f"{info.path.name}: reading pixels failed ({exc}).") from exc
    return data, valid


def _wavelength_stats(
    grid: WaveGrid | None, sx: np.ndarray, sy: np.ndarray, ok: np.ndarray
) -> tuple[float, float, float] | None:
    if grid is None or not ok.any():
        return None
    # Control points are 1-based detector pixels; our coordinates are 0-based. Positions beyond the
    # outermost control point (at most half a pixel) take the edge value.
    row_index = np.interp(sy[ok] + 1.0, grid.y, np.arange(grid.y.size))
    col_index = np.interp(sx[ok] + 1.0, grid.x, np.arange(grid.x.size))
    wavelengths = bilinear_sample(grid.wavelength_um.astype(np.float32), row_index, col_index)
    if not np.all(np.isfinite(wavelengths)):
        return None
    return float(wavelengths.min()), float(wavelengths.max()), float(wavelengths.mean())


def extract_cutouts(
    infos: list[FitsFrameInfo], ra: float, dec: float, size: int, pixel_scale_arcsec: float
) -> CutoutSet:
    """Resample every exposure onto one shared grid centred on (ra, dec)."""
    wcs = build_output_wcs(ra, dec, size, pixel_scale_arcsec)
    sky_ra, sky_dec = output_sky_grid(wcs, size)
    if not (np.all(np.isfinite(sky_ra)) and np.all(np.isfinite(sky_dec))):
        raise FitsProcessingError("The requested field could not be projected onto the sky.")
    half_diagonal = size * pixel_scale_arcsec / 3600.0 * math.sqrt(2) / 2
    frames = tuple(extract_frame(info, sky_ra, sky_dec, (ra, dec), half_diagonal) for info in infos)
    return CutoutSet(ra=ra, dec=dec, size=size, pixel_scale_arcsec=pixel_scale_arcsec, frames=frames)
