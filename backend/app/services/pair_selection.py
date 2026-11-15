"""Metadata-only observation discovery logic: SIA records, footprint geometry, wavelength prediction, ranking.

Everything here works from the archive's search metadata (no pixel data): it shortlists observation pairs
that *should* cover the field at comparable wavelengths. The shortlist is only a prediction (the polygon
affine fit is accurate to roughly 10 pixels); every candidate is re-verified from the downloaded FITS WCS.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from itertools import product

import numpy as np
from astropy import units as u
from astropy.coordinates import SkyCoord, SkyOffsetFrame
from astropy.time import Time

from .fits_cutout import build_output_wcs
from .spherex_calibration import DetectorCalibration

ANGLES = tuple(range(0, 180, 15))
_DETECTOR_RE = re.compile(r"D([1-6])$")
_RELEASE_RE = re.compile(r"/(l2[a-z]?(?:_retry)?-v[\w.-]+)/")  # also the reprocessed "l2b_retry-v27-..." files


class SiaRecordError(ValueError):
    """A single SIA record is unusable (reported, never fatal for the whole query)."""


# ------------------------------------------------------------------------------------------------
# SIA records
# ------------------------------------------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class SiaObservation:
    obs_id: str
    detector: str  # "D3"
    mjd: float
    access_url: str
    vertices: np.ndarray  # (4, 2) ICRS degrees, as listed by the archive
    nx: int
    ny: int
    pixel_scale_arcsec: float
    release: str
    bandpass_um: tuple[float, float] | None  # nominal em_min/em_max of the whole detector, informational

    @property
    def iso_date(self) -> str:
        return Time(self.mjd, format="mjd", scale="utc").isot[:10]


def parse_polygon(region: object) -> np.ndarray:
    """Four ICRS vertices from ``POLYGON [ICRS] ra dec ...`` (a closing duplicate vertex is accepted)."""
    words = str(region).strip().split()
    if not words or words[0].upper() != "POLYGON":
        raise SiaRecordError(f"unsupported footprint '{str(region)[:40]}'")
    start = 2 if len(words) > 1 and words[1].upper() == "ICRS" else 1
    try:
        values = np.array([float(w) for w in words[start:]], dtype=float)
    except ValueError as exc:
        raise SiaRecordError("footprint contains non-numeric values") from exc
    if values.size % 2 or not np.all(np.isfinite(values)):
        raise SiaRecordError("footprint has an odd or non-finite coordinate list")
    points = values.reshape(-1, 2)
    if len(points) > 4 and np.allclose(points[0], points[-1]):
        points = points[:-1]
    if len(points) != 4:
        raise SiaRecordError(f"expected four footprint vertices, found {len(points)}")
    if np.any(np.abs(points[:, 1]) > 90):
        raise SiaRecordError("footprint declination out of range")
    points[:, 0] %= 360.0
    return points


def _text(value: object) -> str:
    return "" if value is None or np.ma.is_masked(value) else str(value).strip()


def _number(value: object) -> float:
    if value is None or np.ma.is_masked(value):
        return math.nan
    try:
        return float(value)
    except (TypeError, ValueError):
        return math.nan


def observations_from_table(rows: list[dict]) -> tuple[list[SiaObservation], list[str]]:
    """Validate SIA rows. Returns (unique valid observations, per-row problems). Duplicates are collapsed."""
    seen: set[tuple[str, str]] = set()
    out: list[SiaObservation] = []
    problems: list[str] = []
    for index, row in enumerate(rows):
        try:
            obs_id = _text(row.get("obs_id"))
            band = _text(row.get("energy_bandpassname"))
            match = _DETECTOR_RE.search(band)
            url = _text(row.get("access_url"))
            mjd = _number(row.get("t_min"))
            nx, ny, scale = _number(row.get("s_xel1")), _number(row.get("s_xel2")), _number(row.get("s_pixel_scale"))
            if not obs_id or not match or not url.startswith("https://"):
                raise SiaRecordError("missing obs_id, detector or https access_url")
            if not math.isfinite(mjd) or not 50000 < mjd < 80000:
                raise SiaRecordError(f"invalid t_min {mjd}")
            if not (math.isfinite(nx) and math.isfinite(ny) and nx >= 16 and ny >= 16 and nx == int(nx) and ny == int(ny)):
                raise SiaRecordError("missing or invalid detector size (s_xel1/s_xel2)")
            if not math.isfinite(scale) or not 1.0 <= scale <= 20.0:
                raise SiaRecordError("missing or implausible s_pixel_scale")
            detector = f"D{match.group(1)}"
            key = (obs_id, detector)
            if key in seen:
                continue
            seen.add(key)
            lo, hi = _number(row.get("em_min")), _number(row.get("em_max"))
            rel = _RELEASE_RE.search(url)
            out.append(SiaObservation(
                obs_id=obs_id, detector=detector, mjd=mjd, access_url=url, vertices=parse_polygon(row.get("s_region")),
                nx=int(nx), ny=int(ny), pixel_scale_arcsec=scale, release=rel.group(1) if rel else "unknown",
                bandpass_um=(lo * 1e6, hi * 1e6) if math.isfinite(lo) and math.isfinite(hi) else None,
            ))
        except SiaRecordError as exc:
            problems.append(f"row {index}: {exc}")
    return out, problems


# ------------------------------------------------------------------------------------------------
# Epochs
# ------------------------------------------------------------------------------------------------


def group_epochs(observations: list[SiaObservation], gap_days: float) -> list[list[SiaObservation]]:
    """Cluster by actual timestamps: a new epoch starts after a gap longer than ``gap_days``."""
    ordered = sorted(observations, key=lambda o: (o.mjd, o.obs_id))
    epochs: list[list[SiaObservation]] = []
    for obs in ordered:
        if epochs and obs.mjd - epochs[-1][-1].mjd <= gap_days:
            epochs[-1].append(obs)
        else:
            epochs.append([obs])
    return epochs


# ------------------------------------------------------------------------------------------------
# Footprint geometry
# ------------------------------------------------------------------------------------------------


def output_size_pixels(fov_deg: float, pixel_scale_arcsec: float) -> int:
    """Edge length of the output grid: covers the requested FOV and is odd so the target sits on a pixel centre."""
    n = int(math.ceil(fov_deg * 3600.0 / pixel_scale_arcsec))
    return n + 1 if n % 2 == 0 else n


def offsets(frame: SkyOffsetFrame, ra: np.ndarray, dec: np.ndarray) -> np.ndarray:
    """(lon, lat) offsets in degrees from the field centre; lon is east-positive and wraps safely at RA = 0."""
    off = SkyCoord(np.atleast_1d(ra) * u.deg, np.atleast_1d(dec) * u.deg, frame="icrs").transform_to(frame)
    return np.column_stack((np.atleast_1d(off.lon.wrap_at(180 * u.deg).deg), np.atleast_1d(off.lat.deg)))


def field_frame(ra: float, dec: float) -> SkyOffsetFrame:
    return SkyOffsetFrame(origin=SkyCoord(ra * u.deg, dec * u.deg, frame="icrs"))


def fov_corner_offsets(ra: float, dec: float, fov_deg: float, pixel_scale_arcsec: float, angle: float, frame: SkyOffsetFrame) -> np.ndarray:
    """Sky-offset corners (and centre) of the *actual* output grid for a given rotation, taken from its WCS.

    Deriving them from the WCS (rather than rotating a square by hand) guarantees the footprint that is
    tested for coverage is the footprint that is later resampled, whatever the rotation sign convention.
    """
    n = output_size_pixels(fov_deg, pixel_scale_arcsec)
    wcs = build_output_wcs(ra, dec, n, pixel_scale_arcsec, rotation_deg=float(angle))
    px = np.array([[-0.5, -0.5], [n - 0.5, -0.5], [n - 0.5, n - 0.5], [-0.5, n - 0.5], [(n - 1) / 2, (n - 1) / 2]])
    world_ra, world_dec = wcs.all_pix2world(px[:, 0], px[:, 1], 0)
    return offsets(frame, world_ra, world_dec)


@dataclass(frozen=True, eq=False)
class DetectorMap:
    """Affine map from field-offset coordinates to zero-based full-detector pixels, fitted to the polygon."""

    fit: np.ndarray  # (3, 2)
    residual_px: float

    def pixels(self, pts: np.ndarray) -> np.ndarray:
        pts = np.atleast_2d(pts)
        return np.column_stack((pts, np.ones(len(pts)))) @ self.fit


def fit_detector_map(obs: SiaObservation, frame: SkyOffsetFrame) -> DetectorMap:
    """Assume polygon vertices P1..P4 are the detector corners (0,0), (nx-1,0), (nx-1,ny-1), (0,ny-1).

    That ordering held for the four validated full images but is not guaranteed for every record, so the
    fit is checked for consistency (residual, orientation, scale) and the *exact* position derived from
    the downloaded cutout is later compared against this prediction; a wrong ordering fails that check.
    """
    plane = offsets(frame, obs.vertices[:, 0], obs.vertices[:, 1])
    corners = np.array([[0, 0], [obs.nx - 1, 0], [obs.nx - 1, obs.ny - 1], [0, obs.ny - 1]], dtype=float)
    design = np.column_stack((plane, np.ones(4)))
    fit, *_ = np.linalg.lstsq(design, corners, rcond=None)
    residual = float(np.max(np.linalg.norm(design @ fit - corners, axis=1)))
    jac = fit[:2].T  # d(pixel)/d(offset), pixels per degree
    if abs(np.linalg.det(jac)) < 1e-9:
        raise SiaRecordError("degenerate footprint")
    scale = 3600.0 / math.sqrt(abs(np.linalg.det(jac)))
    if residual > 12.0:  # real SIA polygons deviate from an exact rectangle by up to ~5 px
        raise SiaRecordError(f"footprint is not a rectangle in pixel space (residual {residual:.1f} px)")
    if abs(scale / obs.pixel_scale_arcsec - 1) > 0.1:
        raise SiaRecordError(f"footprint scale {scale:.2f}\"/px disagrees with s_pixel_scale {obs.pixel_scale_arcsec}")
    return DetectorMap(fit, residual)


@dataclass(frozen=True, eq=False)
class Prediction:
    obs: SiaObservation
    x: float  # predicted zero-based full-detector position of the target
    y: float
    wavelength_um: float
    bandwidth_um: float
    # angle -> (edge margin in px, wavelengths at [corner x4, centre])
    angles: dict[int, tuple[float, np.ndarray]]
    reasons: tuple[str, ...] = ()


def predict(obs: SiaObservation, ra: float, dec: float, fov_deg: float, scale_arcsec: float, buffer_px: float,
            cal: DetectorCalibration | None, frame: SkyOffsetFrame | None = None) -> Prediction | None:
    """Predicted target position, wavelength, and the rotations for which the FOV fits inside the buffered detector."""
    frame = frame or field_frame(ra, dec)
    dmap = fit_detector_map(obs, frame)
    x, y = dmap.pixels(np.zeros((1, 2)))[0]
    lo_x, hi_x, lo_y, hi_y = buffer_px, obs.nx - 1 - buffer_px, buffer_px, obs.ny - 1 - buffer_px
    angles: dict[int, tuple[float, np.ndarray]] = {}
    for angle in ANGLES:
        px = dmap.pixels(fov_corner_offsets(ra, dec, fov_deg, scale_arcsec, angle, frame))
        margin = float(min((px[:, 0] - lo_x).min(), (hi_x - px[:, 0]).min(), (px[:, 1] - lo_y).min(), (hi_y - px[:, 1]).min()))
        if margin < 0:
            continue
        lam = cal.lookup(px[:, 0], px[:, 1])[0] if cal is not None else np.full(5, np.nan)
        angles[angle] = (margin, lam)
    if not angles:
        return None
    if cal is None:
        lam0, bw0 = math.nan, math.nan
    else:
        l, b = cal.lookup(np.array([x]), np.array([y]))
        lam0, bw0 = float(l[0]), float(b[0])
    return Prediction(obs, float(x), float(y), lam0, bw0, angles)


# ------------------------------------------------------------------------------------------------
# Pairing and ranking
# ------------------------------------------------------------------------------------------------


@dataclass(frozen=True, eq=False)
class Settings:
    max_pair_gap_nm: float = 30.0
    max_gap_over_bandwidth: float = 0.75
    max_bandwidth_difference_fraction: float = 0.25
    min_epoch_separation_days: float = 60.0


@dataclass(frozen=True, eq=False)
class PairCandidate:
    a: Prediction
    b: Prediction
    angle: int
    gap_nm: float
    gap_over_bandwidth: float
    bandwidth_difference: float
    field_gap_nm: float  # diagnostic only; matching uses the target's wavelength, not the FOV
    margin_px: float
    epoch_separation_days: float

    @property
    def key(self) -> tuple[str, str]:
        return self.a.obs.obs_id, self.b.obs.obs_id


@dataclass
class PairingReport:
    candidates: list[PairCandidate] = field(default_factory=list)
    considered: int = 0
    no_common_rotation: int = 0
    different_detector: int = 0
    no_calibration: int = 0
    too_close_in_time: int = 0
    rejected_wavelength: int = 0
    rejected_bandwidth: int = 0


def rotation_preference(angle: int) -> int:
    return min(angle, 180 - angle)


def rank_pairs(epochs: list[list[Prediction]], settings: Settings) -> PairingReport:
    """All admissible cross-epoch pairs, best first. Ordering is fully deterministic.

    Order of criteria: target wavelength compatibility (relative to the bandwidth, to 0.001), bandwidth match,
    detector-edge margin (coverage / quality), larger epoch separation, rotation closest to north-up,
    then observation ids as the final tie-break.
    """
    report = PairingReport()
    for i, j in ((i, j) for i in range(len(epochs)) for j in range(i + 1, len(epochs))):
        for a, b in product(epochs[i], epochs[j]):
            report.considered += 1
            if a.obs.detector != b.obs.detector:  # different arrays have different flat fields, PSFs and wavelength ranges
                report.different_detector += 1
                continue
            common = set(a.angles) & set(b.angles)
            if not common:
                report.no_common_rotation += 1
                continue
            if not (math.isfinite(a.wavelength_um) and math.isfinite(b.wavelength_um) and a.bandwidth_um > 0 and b.bandwidth_um > 0):
                report.no_calibration += 1
                continue
            separation = abs(a.obs.mjd - b.obs.mjd)
            if separation < settings.min_epoch_separation_days:
                report.too_close_in_time += 1
                continue
            angle = min(common, key=lambda z: (rotation_preference(z), z))
            gap_nm = abs(a.wavelength_um - b.wavelength_um) * 1000
            mean_bw_nm = 500 * (a.bandwidth_um + b.bandwidth_um)
            rel = gap_nm / mean_bw_nm
            bw_diff = abs(a.bandwidth_um - b.bandwidth_um) / max(a.bandwidth_um, b.bandwidth_um)
            if gap_nm > settings.max_pair_gap_nm or rel > settings.max_gap_over_bandwidth:
                report.rejected_wavelength += 1
                continue
            if bw_diff > settings.max_bandwidth_difference_fraction:
                report.rejected_bandwidth += 1
                continue
            la, lb = a.angles[angle][1], b.angles[angle][1]
            field_gap = float(np.nanmax(np.abs(la - lb))) * 1000 if np.all(np.isfinite(la)) and np.all(np.isfinite(lb)) else math.inf
            report.candidates.append(PairCandidate(a, b, angle, gap_nm, rel, bw_diff, field_gap,
                                                   min(a.angles[angle][0], b.angles[angle][0]), separation))
    report.candidates.sort(key=lambda c: (round(c.gap_over_bandwidth, 3), round(c.bandwidth_difference, 3), -round(c.margin_px, 0),
                                          -round(c.epoch_separation_days, 0), rotation_preference(c.angle), c.key))
    return report
