"""Dynamic, wavelength-aware blink analysis for an arbitrary sky position.

Flow: IRSA SIA discovery -> footprint/wavelength *prediction* from metadata only -> ranked candidate pairs
-> for each candidate (best first): download cutouts, verify the *exact* wavelength from the FITS WCS,
reproject onto one shared grid, check geometric and quality coverage -> render the first pair that passes.
A pair that fails verification is rejected, never silently accepted; if none passes, the error says why.
"""

from __future__ import annotations

import logging
import math
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np
from astropy.io import fits
from astropy.wcs import WCS

from ..config import Settings
from ..models.errors import DynamicSelectionError, InvalidParameters, UpstreamInvalidResponse, UpstreamTimeout, UpstreamUnavailable
from ..utils.ttl_cache import TTLCache
from . import fits_display as fd
from .fits_cutout import BAD_FLAG_NAMES, SUPPORTED_UNITS, build_output_wcs, output_sky_grid, resample_to_grid
from .irsa_archive import CutoutCorrupt, FullHeaderStore, IrsaClient
from .pair_selection import (
    PairCandidate,
    Prediction,
    Settings as PairSettings,
    SiaObservation,
    field_frame,
    group_epochs,
    output_size_pixels,
    predict,
    rank_pairs,
)
from .spherex_calibration import CalibrationError, CalibrationRegistry, DetectorCalibration, calibration_from_hdul, header_frame_offset

log = logging.getLogger("skyexplorer.dynamic")

# Quality-flag policy (names are resolved to bits through each file's own MSKN#### header cards).
HARD_INVALID_NAMES = BAD_FLAG_NAMES
SUSPECT_NAMES = frozenset({"OVERFLOW", "TRANSIENT", "PERSIST", "OUTLIER", "HALO", "DICHROIC", "PHANMISS", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT"})
INFORMATIONAL_NAMES = frozenset({"SOURCE", "FULLSAMPLE"})  # never masked
CALIBRATION_BOOTSTRAP_FOV = 0.01
# Reasons that point at geometry/metadata (not at the sky or the data): worth trying more candidates for.
METADATA_REASONS = frozenset({"coordinate_mapping_failed", "footprint_mismatch", "invalid_calibration"})
# Shown to the user (concise). Technical detail goes to the backend log. Ties between reasons are broken in this order.
REASON_TEXT = {
    "coordinate_mapping_failed": "the detector coordinates of the observations could not be verified, so their wavelengths could not be established reliably",
    "footprint_mismatch": "the archive's footprint metadata contradicts the observations' own sky coordinates",
    "invalid_calibration": "the wavelength calibration table was unavailable or invalid",
    "quality_failure": "too many invalid pixels",
    "insufficient_coverage": "insufficient field coverage",
    "wavelength_mismatch": "wavelength mismatch",
    "no_observations": "no usable observation",
}
REASON_PRIORITY = tuple(REASON_TEXT)
# For these the failing numbers are meaningful to the user, so the first detail is included in the message.
DETAIL_IN_MESSAGE = frozenset({"quality_failure", "insufficient_coverage", "wavelength_mismatch"})


@dataclass(frozen=True)
class FlagMasks:
    hard: int
    suspect: int
    source: int
    names: dict[int, str]

    def describe(self, mask: int) -> list[str]:
        return [n for b, n in sorted(self.names.items()) if mask >> b & 1]


def resolve_flag_masks(header: fits.Header) -> FlagMasks:
    names = {int(k[4:]): str(v).strip().upper() for k, v in header.items() if k.startswith("MSKN") and k[4:].isdigit()}
    hard = sum(1 << b for b, n in names.items() if n in HARD_INVALID_NAMES)
    suspect = sum(1 << b for b, n in names.items() if n in SUSPECT_NAMES)
    source = sum(1 << b for b, n in names.items() if n == "SOURCE")
    return FlagMasks(hard, suspect, source, names)


class _Reject(Exception):
    """A candidate pair failed verification. ``reason`` is one of DynamicSelectionError.REASONS.

    ``obs`` names the single observation at fault (``(obs_id, detector)``), if there is one, so the same
    observation is not downloaded and re-verified again in another pair."""

    def __init__(self, reason: str, detail: str, obs: tuple[str, str] | None = None) -> None:
        super().__init__(detail)
        self.reason, self.detail, self.obs = reason, detail, obs


@dataclass(eq=False)
class LoadedCutout:
    obs: SiaObservation
    path: Path
    header: fits.Header
    wcs: WCS
    data: np.ndarray
    variance: np.ndarray
    flags: np.ndarray
    masks: FlagMasks
    calibration: DetectorCalibration
    date_obs: str
    obsid: str


def load_cutout(path: Path, obs: SiaObservation) -> LoadedCutout:
    try:
        with fits.open(path, memmap=False) as hdul:
            header = hdul["IMAGE"].header.copy()
            bunit = str(header.get("BUNIT", "")).strip()
            if bunit not in SUPPORTED_UNITS:
                raise _Reject("quality_failure", f"{obs.obs_id}: unsupported unit '{bunit}'", (obs.obs_id, obs.detector))
            cal = calibration_from_hdul(hdul, expected_detector=obs.detector)
            data = np.array(hdul["IMAGE"].data, dtype=np.float32)
            variance = np.array(hdul["VARIANCE"].data, dtype=np.float32)
            flags = np.array(hdul["FLAGS"].data).astype(np.int64)
            masks = resolve_flag_masks(hdul["FLAGS"].header)
    except CalibrationError as exc:
        raise _Reject("invalid_calibration", f"{obs.obs_id}: {exc}", (obs.obs_id, obs.detector)) from exc
    except (OSError, KeyError, ValueError) as exc:
        raise _Reject("quality_failure", f"{obs.obs_id}: unreadable cutout ({exc})", (obs.obs_id, obs.detector)) from exc
    wcs = WCS(header)
    ctype = [str(c) for c in wcs.wcs.ctype]
    if not wcs.has_celestial or "TAN" not in ctype[0] or str(header.get("RADESYS", "ICRS")).strip().upper() not in {"ICRS", ""}:
        raise _Reject("coordinate_mapping_failed", f"{obs.obs_id}: unsupported celestial WCS {ctype}", (obs.obs_id, obs.detector))
    if not (data.shape == variance.shape == flags.shape):
        raise _Reject("quality_failure", f"{obs.obs_id}: image/variance/flags shapes differ", (obs.obs_id, obs.detector))
    return LoadedCutout(obs, path, header, wcs, data, variance, flags, masks, cal, str(header.get("DATE-OBS", "")), str(header.get("OBSID", obs.obs_id)))


@dataclass(frozen=True)
class DetectorMapping:
    """How this cutout's pixels map to the full detector (the frame the wavelength table is defined in)."""

    dx: float  # add to a zero-based cutout pixel to get the zero-based full-detector pixel
    dy: float
    exact_xy: tuple[float, float]  # target position on the full detector, from the archive's own full-image WCS
    full_crpix: tuple[float, float]
    prediction_error_px: float  # distance from the SIA-polygon prediction (informational unless large)


def establish_mapping(cut: LoadedCutout, pred: Prediction, full_header: fits.Header, ra: float, dec: float, s: Settings) -> DetectorMapping:
    """Verify, from the archive's own full-image header, how this cutout sits on the detector.

    The full header supplies the original CRPIX (which is *not* always the detector centre) and WCS. Checks:
    detector size and number agree with the metadata; the crop origin is a whole number of pixels; the cutout WCS
    and the full WCS give the same sky position at the mapped pixels; the position derived from the cutout equals
    the one derived directly from the full WCS. Only then is the wavelength looked up.
    """
    obs = cut.obs
    key = (obs.obs_id, obs.detector)

    def fail(reason: str, detail: str) -> _Reject:
        return _Reject(reason, f"{obs.obs_id} {obs.detector}: {detail}", key)

    if (full_header.get("NAXIS1"), full_header.get("NAXIS2")) != (obs.nx, obs.ny):
        raise fail("coordinate_mapping_failed", f"full image is {full_header.get('NAXIS1')}x{full_header.get('NAXIS2')} but the archive lists {obs.nx}x{obs.ny}")
    if int(full_header.get("DETECTOR", -1)) != int(obs.detector[1:]):
        raise fail("coordinate_mapping_failed", f"full header is detector {full_header.get('DETECTOR')}, archive says {obs.detector}")
    full_wcs = WCS(full_header)
    if not full_wcs.has_celestial or "TAN" not in str(full_wcs.wcs.ctype[0]):
        raise fail("coordinate_mapping_failed", f"unsupported full-image WCS {list(full_wcs.wcs.ctype)}")
    try:
        dx, dy = header_frame_offset(cut.header, full_header)
    except CalibrationError as exc:
        raise fail("coordinate_mapping_failed", str(exc)) from exc

    ny, nx = cut.data.shape
    probe = np.array([[0.0, 0.0], [nx - 1.0, 0.0], [nx - 1.0, ny - 1.0], [0.0, ny - 1.0], [(nx - 1) / 2, (ny - 1) / 2]])
    cut_sky = np.column_stack(cut.wcs.all_pix2world(probe[:, 0], probe[:, 1], 0))
    full_sky = np.column_stack(full_wcs.all_pix2world(probe[:, 0] + dx, probe[:, 1] + dy, 0))
    sep = np.hypot((cut_sky[:, 0] - full_sky[:, 0] + 180) % 360 - 180, cut_sky[:, 1] - full_sky[:, 1]) * 3600
    if not np.all(np.isfinite(sep)) or float(sep.max()) > 0.05:
        raise fail("coordinate_mapping_failed", f"cutout and full-image WCS disagree by {float(sep.max()):.3f} arcsec at the mapped pixels")

    lx, ly = (float(v) for v in cut.wcs.all_world2pix(ra, dec, 0))
    exact = (lx + dx, ly + dy)
    direct = tuple(float(v) for v in full_wcs.all_world2pix(ra, dec, 0))
    if not (np.isfinite(exact).all() and np.isfinite(direct).all()) or math.hypot(exact[0] - direct[0], exact[1] - direct[1]) > 0.05:
        raise fail("coordinate_mapping_failed", f"cutout-derived position {exact} differs from the full-image WCS position {direct}")
    if not (-0.5 <= exact[0] <= obs.nx - 0.5 and -0.5 <= exact[1] <= obs.ny - 0.5):
        raise fail("insufficient_coverage", f"target maps to {exact[0]:.0f},{exact[1]:.0f}, outside the {obs.nx}x{obs.ny} detector")
    error = math.hypot(exact[0] - pred.x, exact[1] - pred.y)
    if error > s.max_footprint_error_px:
        raise fail("footprint_mismatch", f"archive footprint predicts ({pred.x:.0f},{pred.y:.0f}) but the file's own WCS places the target at ({exact[0]:.0f},{exact[1]:.0f}): {error:.0f} px apart")
    return DetectorMapping(dx, dy, exact, (float(full_header["CRPIX1"]), float(full_header["CRPIX2"])), error)


@dataclass(eq=False)
class DynamicFrame:
    cutout: LoadedCutout
    values: np.ndarray  # float32 (n, n), calibrated MJy/sr, NaN where invalid. Row 0 = southern edge.
    valid: np.ndarray  # bool: hard-valid science pixel after interpolation
    flags: np.ndarray  # int32 nearest-neighbour flag bitmask (never interpolated)
    geometric_coverage: float
    good_fraction: float  # of the whole output grid
    suspect_fraction: float  # of the valid pixels, carrying a suspect flag (kept)
    source_fraction: float  # of the valid pixels, carrying SOURCE (informational, kept)
    wavelength_map: np.ndarray  # µm per output pixel (NaN outside the calibration grid)
    centre_wavelength_um: float
    centre_bandwidth_um: float
    centre_xy: tuple[float, float]  # exact zero-based full-detector position of the target
    mapping: DetectorMapping | None = None


def resample_cutout(cut: LoadedCutout, out_wcs: WCS, sky_ra: np.ndarray, sky_dec: np.ndarray, ra: float, dec: float,
                    mapping: DetectorMapping, s: Settings) -> DynamicFrame:
    n = sky_ra.shape[0]
    sx, sy = cut.wcs.all_world2pix(sky_ra, sky_dec, 0, quiet=True, tolerance=1e-4, maxiter=40, adaptive=True)
    sx, sy = np.asarray(sx, float), np.asarray(sy, float)
    ny, nx = cut.data.shape
    inside = np.isfinite(sx) & np.isfinite(sy) & (sx >= -0.5) & (sx <= nx - 0.5) & (sy >= -0.5) & (sy <= ny - 0.5)
    valid_px = np.isfinite(cut.data) & np.isfinite(cut.variance) & (cut.variance > 0) & ((cut.flags & cut.masks.hard) == 0)
    rows, cols = np.where(inside, sy, np.nan), np.where(inside, sx, np.nan)
    values, ok = resample_to_grid(cut.data, valid_px, rows, cols, min_weight=s.dynamic_interp_min_weight)
    # Flags are categorical: nearest neighbour only, never interpolated.
    nr = np.clip(np.rint(np.where(inside, sy, 0)).astype(int), 0, ny - 1)
    nc = np.clip(np.rint(np.where(inside, sx, 0)).astype(int), 0, nx - 1)
    flags_out = np.where(inside, cut.flags[nr, nc], 0).astype(np.int32)

    dx, dy = mapping.dx, mapping.dy
    lam_map, bw_map = cut.calibration.lookup(sx + dx, sy + dy)
    cx, cy = (float(v) for v in cut.wcs.all_world2pix(ra, dec, 0))
    clam, cbw = cut.calibration.lookup(np.array([cx + dx]), np.array([cy + dy]))
    n_valid = max(int(ok.sum()), 1)
    return DynamicFrame(
        cutout=cut,
        values=values,
        valid=ok,
        flags=flags_out,
        geometric_coverage=float(inside.mean()),
        good_fraction=float(ok.mean()),
        suspect_fraction=float(((flags_out & cut.masks.suspect) != 0)[ok].sum() / n_valid),
        source_fraction=float(((flags_out & cut.masks.source) != 0)[ok].sum() / n_valid),
        wavelength_map=np.where(ok, lam_map, np.nan),
        centre_wavelength_um=float(clam[0]),
        centre_bandwidth_um=float(cbw[0]),
        centre_xy=(cx + dx, cy + dy),
        mapping=mapping,
    )


# ------------------------------------------------------------------------------------------------
# Results
# ------------------------------------------------------------------------------------------------


@dataclass(eq=False)
class DynamicResult:
    ra: float
    dec: float
    fov_deg: float
    size: int
    pixel_scale_arcsec: float
    rotation_deg: int
    wcs_header: dict
    frames: list[DynamicFrame]
    images: dict[str, bytes]
    display: fd.DisplayParameters
    common_good_fraction: float
    common_geometric_coverage: float
    pair: PairCandidate
    exact_gap_nm: float
    exact_gap_over_bandwidth: float
    field_gap_nm: float
    candidates_tried: int
    rejected: list[str]
    warnings: list[str]
    release: str
    collection: str


class HeaderSource(Protocol):
    def get(self, obs: SiaObservation, *, cached_only: bool = False) -> fits.Header: ...


class CutoutSource(Protocol):
    def get(self, obs: SiaObservation, ra: float, dec: float, size_deg: float, overscan: float | None = None, *, cached_only: bool = False) -> Path: ...


def frame_id(frame: DynamicFrame) -> str:
    return frame.cutout.obs.iso_date[:7]


class DynamicBlinkService:
    def __init__(self, settings: Settings, irsa: IrsaClient, store: CutoutSource, registry: CalibrationRegistry,
                 headers: HeaderSource | None = None) -> None:
        self._s = settings
        self._irsa = irsa
        self._store = store
        self._headers: HeaderSource = headers or FullHeaderStore(settings, irsa)
        self._registry = registry
        self._lock = threading.Lock()
        self._gates: dict[str, threading.Lock] = {}
        self._results: TTLCache[DynamicResult] = TTLCache(settings.dynamic_result_cache_entries, settings.blink_cache_ttl_seconds)
        self._seeded = False
        self._pair_settings = PairSettings(
            settings.max_pair_gap_nm, settings.max_gap_over_bandwidth, settings.max_field_gap_over_bandwidth,
            settings.max_bandwidth_difference_fraction, settings.min_epoch_separation_days,
        )

    # -- public ----------------------------------------------------------------------------------
    def analyse(self, ra: float, dec: float, fov_deg: float | None) -> DynamicResult:
        fov = self._s.dynamic_fov_default if fov_deg is None else float(fov_deg)
        if not (math.isfinite(fov) and self._s.dynamic_fov_min <= fov <= self._s.dynamic_fov_max):
            raise InvalidParameters(f"fov_deg must be between {self._s.dynamic_fov_min} and {self._s.dynamic_fov_max} degrees.")
        key = f"{ra:.6f}|{dec:.6f}|{fov:.5f}"
        with self._lock:
            hit = self._results.get(key)
            gate = self._gates.setdefault(key, threading.Lock())
        if hit is not None:
            return hit
        with gate:  # identical concurrent requests share one analysis
            with self._lock:
                hit = self._results.get(key)
            if hit is not None:
                return hit
            result = self._analyse(ra, dec, fov)
            with self._lock:
                self._results.set(key, result)
            return result

    def image(self, ra: float, dec: float, fov_deg: float | None, frame_identifier: str) -> bytes:
        result = self.analyse(ra, dec, fov_deg)
        try:
            return result.images[frame_identifier]
        except KeyError:
            raise InvalidParameters(f"Unknown frame '{frame_identifier}'.") from None

    # -- calibration -----------------------------------------------------------------------------
    def _seed_calibrations(self) -> None:
        with self._lock:
            if self._seeded:
                return
            self._seeded = True
        for path in self._s.blink_calibration_seed_files:
            self._registry.seed_from_file(Path(path))

    def _ensure_calibrations(self, predictions: list[Prediction], ra: float, dec: float, cached_fov: float | None = None) -> tuple[dict[str, DetectorCalibration], dict[str, str]]:
        """Calibration per detector (memory/disk/local seed, else a tiny IRSA cutout). Failures exclude the detector."""
        self._seed_calibrations()
        need: dict[str, Prediction] = {}
        have: dict[str, DetectorCalibration] = {}
        for p in predictions:
            det = p.obs.detector
            cal = self._registry.current(det)
            if cal is not None:
                have[det] = cal
            elif det not in need or p.obs.mjd < need[det].obs.mjd:
                need[det] = p
        failed: dict[str, str] = {}
        archive_errors: list[Exception] = []

        def bootstrap(det: str, pred: Prediction) -> tuple[str, DetectorCalibration | None, str]:
            try:
                if cached_fov is not None:
                    path = self._store.get(pred.obs, ra, dec, cached_fov, cached_only=True)
                else:
                    path = self._store.get(pred.obs, ra, dec, CALIBRATION_BOOTSTRAP_FOV, overscan=1.0)
                with fits.open(path, memmap=False) as hdul:
                    cal = calibration_from_hdul(hdul, expected_detector=det)
                self._registry.register(cal)
                return det, cal, ""
            except (CalibrationError, OSError, CutoutCorrupt) as exc:
                return det, None, f"{det}: {exc}"
            except (UpstreamUnavailable, UpstreamTimeout, UpstreamInvalidResponse) as exc:
                # One detector's calibration failing excludes that detector only; the others can still pair.
                archive_errors.append(exc)
                return det, None, f"{det}: {exc.message}"

        if need:
            with ThreadPoolExecutor(max_workers=min(3, len(need))) as pool:
                for det, cal, why in pool.map(lambda kv: bootstrap(*kv), need.items()):
                    if cal is not None:
                        have[det] = cal
                    else:
                        failed[det] = why
        if not have and archive_errors:
            raise archive_errors[0]  # the archive itself is the problem: say so rather than blaming calibration
        return have, failed

    # -- analysis --------------------------------------------------------------------------------
    def _analyse(self, ra: float, dec: float, fov: float) -> DynamicResult:
        try:
            observations, _ = self._irsa.search(ra, dec)
        except (UpstreamUnavailable, UpstreamTimeout) as outage:
            snapshot = self._irsa.cached_search(ra, dec)
            if snapshot is None:
                raise
            observations, saved = snapshot
            available = []
            for obs in observations:
                try:
                    self._store.get(obs, ra, dec, fov, cached_only=True)
                    available.append(obs)
                except UpstreamInvalidResponse:
                    continue
            try:
                result = self._analyse_observations(ra, dec, fov, available, cached_only=True)
            except (DynamicSelectionError, UpstreamInvalidResponse, UpstreamUnavailable, UpstreamTimeout) as exc:
                raise type(outage)(
                    f"{outage.message} Cached data cannot provide a verified pair for this view: {exc.message}"
                ) from exc
            result.warnings.insert(0,
                f"Cached data; archive unavailable. Discovery metadata saved {saved}; "
                "newer observations may be missing. Local FITS were revalidated and re-rendered.")
            return result
        return self._analyse_observations(ra, dec, fov, observations)

    def _analyse_observations(self, ra: float, dec: float, fov: float, observations: list[SiaObservation],
                              *, cached_only: bool = False) -> DynamicResult:
        s = self._s
        if not observations:
            raise DynamicSelectionError("No SPHEREx DR1 observations in the NASA/IPAC archive cover this position.", "no_observations")
        frame = field_frame(ra, dec)
        geometric: list[Prediction] = []
        for obs in observations:
            try:
                pred = predict(obs, ra, dec, fov, s.blink_pixel_scale_arcsec, s.dynamic_detector_buffer_px, None, frame)
            except ValueError as exc:
                log.info("skipping %s: %s", obs.obs_id, exc)
                continue
            if pred is not None:
                geometric.append(pred)
        if not geometric:
            raise DynamicSelectionError(
                f"{len(observations)} SPHEREx observation(s) include this position, but none contains the whole {fov:g}° field "
                f"with a {s.dynamic_detector_buffer_px:g}-pixel margin from the detector edge. Try a smaller field of view.",
                "insufficient_coverage")
        if len(group_epochs([p.obs for p in geometric], s.epoch_gap_days)) < 2:
            raise DynamicSelectionError(
                "SPHEREx has observed this field in only one survey epoch so far (or the other epochs do not cover the "
                f"whole {fov:g}° field), so there is nothing to blink against.", "no_observations")

        geo_epochs = group_epochs([p.obs for p in geometric], s.epoch_gap_days)
        epoch_index = {o.obs_id + o.detector: i for i, grp in enumerate(geo_epochs) for o in grp}
        per_detector: dict[str, set[int]] = {}
        for p in geometric:
            per_detector.setdefault(p.obs.detector, set()).add(epoch_index[p.obs.obs_id + p.obs.detector])
        pairable = [p for p in geometric if len(per_detector[p.obs.detector]) >= 2]  # a detector seen in one epoch cannot pair with itself
        if not pairable:
            raise DynamicSelectionError("No detector observed this field in more than one survey epoch with full coverage.", "no_observations")
        calibrations, failed = self._ensure_calibrations(pairable, ra, dec, cached_fov=fov if cached_only else None)
        predictions: list[Prediction] = []
        for p in pairable:
            cal = calibrations.get(p.obs.detector)
            if cal is None:
                continue
            full = predict(p.obs, ra, dec, fov, s.blink_pixel_scale_arcsec, s.dynamic_detector_buffer_px, cal, frame)
            if full is not None:
                predictions.append(full)
        if not predictions:
            raise DynamicSelectionError("The wavelength calibration could not be established for any detector covering this field ("
                                        + "; ".join(failed.values())[:300] + ").", "invalid_calibration")
        by_obs = {p.obs.obs_id + p.obs.detector: p for p in predictions}
        epochs = [[by_obs[o.obs_id + o.detector] for o in grp] for grp in group_epochs([p.obs for p in predictions], s.epoch_gap_days)]
        report = rank_pairs(epochs, self._pair_settings)
        if not report.candidates:
            if len(epochs) < 2:
                raise DynamicSelectionError("Only one survey epoch has usable wavelength calibration for this field.", "invalid_calibration")
            reason, text = self._no_candidate_reason(report, fov)
            raise DynamicSelectionError(text, reason)

        rejected: list[str] = []
        reasons: list[str] = []
        bad_observations: dict[tuple[str, str], str] = {}  # an observation that failed once is never downloaded/verified again
        attempts, limit = 0, s.top_pairs_to_try
        for cand in report.candidates:
            if attempts >= limit:
                break
            known = next((k for k in ((cand.a.obs.obs_id, cand.a.obs.detector), (cand.b.obs.obs_id, cand.b.obs.detector)) if k in bad_observations), None)
            if known is not None:
                log.info("skipping pair %s: %s %s already rejected (%s)", cand.key, known[0], known[1], bad_observations[known])
                continue
            attempts += 1
            try:
                return self._verify_and_build(cand, ra, dec, fov, attempts, rejected, calibrations, failed, cached_only=cached_only)
            except _Reject as rej:
                rejected.append(f"{cand.a.obs.obs_id} / {cand.b.obs.obs_id}: {rej.detail}")
                reasons.append(rej.reason)
                if rej.obs is not None:
                    bad_observations[rej.obs] = rej.reason
                log.warning("rejected pair %s [%s]: %s", cand.key, rej.reason, rej.detail)  # full technical detail stays in the log
                # Geometry/metadata failures say nothing about the sky: look further down the ranking (bounded).
                if attempts >= limit and limit < s.max_pairs_to_try and all(r in METADATA_REASONS for r in reasons):
                    limit = s.max_pairs_to_try
        if not reasons:
            raise DynamicSelectionError("Every shortlisted observation pair involved an observation that had already failed verification.", "quality_failure")
        reason = max(set(reasons), key=lambda r: (reasons.count(r), -REASON_PRIORITY.index(r)))
        detail = f" ({rejected[0].split(': ', 1)[-1]})" if reason in DETAIL_IN_MESSAGE else ""
        raise DynamicSelectionError(
            f"None of the {len(reasons)} best candidate pair(s) passed verification: {REASON_TEXT[reason]}{detail}.", reason)

    def _no_candidate_reason(self, r, fov: float) -> tuple[str, str]:
        s = self._s
        if r.no_common_rotation and r.no_common_rotation >= r.rejected_wavelength + r.rejected_bandwidth + r.rejected_field:
            return "insufficient_coverage", f"No pair of observations covers the same {fov:g}° field at a common orientation. Try a smaller field of view."
        if r.too_close_in_time and not (r.rejected_wavelength or r.rejected_bandwidth or r.rejected_field):
            return "no_observations", f"Observations of this field are less than {s.min_epoch_separation_days:g} days apart."
        hint = " The wavelength changes across the field, so a smaller field of view may allow a match." if r.rejected_field else ""
        return "wavelength_mismatch", (
            f"{r.considered} cross-epoch observation pair(s) cover this field, but none has comparable wavelengths there "
            f"(within {s.max_pair_gap_nm:g} nm and {s.max_gap_over_bandwidth:.0%} of the bandwidth). Blinking them would risk false changes.{hint}")

    def _verify_and_build(self, cand: PairCandidate, ra: float, dec: float, fov: float, tried: int, rejected: list[str],
                          calibrations: dict[str, DetectorCalibration], excluded: dict[str, str], *, cached_only: bool = False) -> DynamicResult:
        s = self._s
        out_n = output_size_pixels(fov, s.blink_pixel_scale_arcsec)
        out_wcs = build_output_wcs(ra, dec, out_n, s.blink_pixel_scale_arcsec, rotation_deg=float(cand.angle))
        sky_ra, sky_dec = output_sky_grid(out_wcs, out_n)
        frames: list[DynamicFrame] = []

        def fetch(pred: Prediction):
            """Fetch cutout and full-image header together; cached-only mode must not reach IRSA."""
            out: list = []
            for getter in (
                lambda: self._store.get(pred.obs, ra, dec, fov, cached_only=cached_only),
                lambda: self._headers.get(pred.obs, cached_only=cached_only),
            ):
                try:
                    out.append(getter())
                except UpstreamInvalidResponse as exc:
                    out.append(exc)
            return out

        with ThreadPoolExecutor(max_workers=2) as pool:  # the two observations are independent: fetch them side by side
            fetched = list(pool.map(fetch, (cand.a, cand.b)))
        position_notes: list[str] = []
        for pred, (path, header) in zip((cand.a, cand.b), fetched):
            key = (pred.obs.obs_id, pred.obs.detector)
            if isinstance(path, UpstreamInvalidResponse):
                raise _Reject("quality_failure", f"{pred.obs.obs_id}: {path.message}", key) from path
            if isinstance(header, UpstreamInvalidResponse):
                raise _Reject("coordinate_mapping_failed", f"{pred.obs.obs_id}: archive header unavailable ({header.message})", key) from header
            cut = load_cutout(path, pred.obs)
            mapping = establish_mapping(cut, pred, header, ra, dec, s)
            frame = resample_cutout(cut, out_wcs, sky_ra, sky_dec, ra, dec, mapping, s)
            if not math.isfinite(frame.centre_wavelength_um):
                raise _Reject("invalid_calibration", f"{pred.obs.obs_id}: target lies outside the wavelength calibration grid", key)
            if frame.geometric_coverage < s.min_geometric_coverage:
                raise _Reject("insufficient_coverage", f"{pred.obs.obs_id}: only {frame.geometric_coverage:.1%} of the field lies inside the cutout", key)
            if mapping.prediction_error_px > s.max_position_error_px:
                # The file's own WCS and CRPIX were verified, so the wavelength is trustworthy; only the archive's footprint estimate was off.
                position_notes.append(
                    f"The archive's footprint metadata for {pred.obs.obs_id} ({pred.obs.detector}) is {mapping.prediction_error_px:.0f} px off the position given by the file's own header; "
                    "the verified header position was used for the wavelength.")
                log.warning("%s: SIA prediction %.0f px from the verified position (header CRPIX %s)", pred.obs.obs_id, mapping.prediction_error_px, mapping.full_crpix)
            frames.append(frame)
        fa, fb = frames
        gap_nm = abs(fa.centre_wavelength_um - fb.centre_wavelength_um) * 1000
        mean_bw_nm = 500 * (fa.centre_bandwidth_um + fb.centre_bandwidth_um)
        if gap_nm > s.max_pair_gap_nm or gap_nm / mean_bw_nm > s.max_gap_over_bandwidth:
            raise _Reject("wavelength_mismatch", f"actual wavelength difference {gap_nm:.1f} nm is {gap_nm / mean_bw_nm:.0%} of the bandwidth")
        common = fa.valid & fb.valid
        if not common.any():
            raise _Reject("quality_failure", "no pixel is valid in both frames")
        field_gap = float(np.nanmax(np.abs(fa.wavelength_map - fb.wavelength_map)[common])) * 1000
        if field_gap / mean_bw_nm > s.max_field_gap_over_bandwidth:
            raise _Reject("wavelength_mismatch", f"wavelength difference reaches {field_gap:.1f} nm across the field")
        common_good = float(common.mean())
        if common_good < s.min_common_good_fraction:
            raise _Reject("quality_failure", f"common usable coverage {common_good:.1%} is below {s.min_common_good_fraction:.0%}")

        display_frames = [_Display(f.values, f.valid) for f in frames]
        pngs, params = fd.render_frames(tuple(display_frames))  # type: ignore[arg-type]
        ids = [frame_id(f) for f in frames]
        if len(set(ids)) != len(ids):
            raise _Reject("no_observations", "both observations fall in the same calendar month")
        return DynamicResult(
            ra=ra, dec=dec, fov_deg=fov, size=out_n, pixel_scale_arcsec=s.blink_pixel_scale_arcsec, rotation_deg=cand.angle,
            wcs_header={k: (v if isinstance(v, (int, float, str)) else str(v)) for k, v in out_wcs.to_header().items()},
            frames=frames, images=dict(zip(ids, pngs)), display=params, common_good_fraction=common_good,
            common_geometric_coverage=float((np.asarray([f.geometric_coverage for f in frames])).min()),
            pair=cand, exact_gap_nm=gap_nm, exact_gap_over_bandwidth=gap_nm / mean_bw_nm, field_gap_nm=field_gap,
            candidates_tried=tried, rejected=list(rejected), warnings=self._warnings(frames, common_good, gap_nm, mean_bw_nm, calibrations, field_gap) + position_notes + [f"Detector excluded: {why}" for why in excluded.values()],
            release=cand.a.obs.release, collection=s.irsa_collection,
        )

    def _warnings(self, frames: list[DynamicFrame], common_good: float, gap_nm: float, mean_bw_nm: float,
                  calibrations: dict[str, DetectorCalibration], field_gap: float) -> list[str]:
        notes = [
            f"The two observations differ by {gap_nm:.1f} nm in central wavelength ({gap_nm / mean_bw_nm:.0%} of the {mean_bw_nm:.0f} nm bandwidth). "
            "That is acceptable for a visual comparison but is not photometric equivalence."
        ]
        if field_gap / mean_bw_nm > 0.5:
            notes.append(f"Across the field the two frames' wavelengths differ by up to {field_gap:.0f} nm ({field_gap / mean_bw_nm:.0%} of the bandwidth), "
                         "because the wavelength changes across the detector and the two exposures were taken at different orientations. Differences are largest toward the field edges.")
        if common_good < 0.95:
            notes.append(f"Only {common_good:.1%} of the field is usable in both frames; flagged or uncovered areas are transparent.")
        for f in frames:
            if f.suspect_fraction >= 0.05:
                notes.append(f"{f.suspect_fraction:.0%} of usable pixels in {f.cutout.obs.iso_date} carry caution flags (overflow, transient, outlier, halo, persistence); they are shown, not hidden.")
            predicted = calibrations.get(f.cutout.obs.detector)
            if predicted is not None and predicted.fingerprint != f.cutout.calibration.fingerprint:
                notes.append(f"{f.cutout.obs.obs_id} uses wavelength calibration {f.cutout.calibration.version}, which differs from the one used to shortlist candidates "
                             f"({predicted.version}); the exact values from the file were used.")
        return notes


@dataclass(eq=False)
class _Display:
    values: np.ndarray
    valid: np.ndarray
