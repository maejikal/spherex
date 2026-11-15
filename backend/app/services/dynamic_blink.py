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
from .irsa_archive import CutoutCorrupt, IrsaClient
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
from .spherex_calibration import CalibrationError, CalibrationRegistry, DetectorCalibration, calibration_from_hdul, full_frame_offset

log = logging.getLogger("skyexplorer.dynamic")

# Quality-flag policy (names are resolved to bits through each file's own MSKN#### header cards).
HARD_INVALID_NAMES = frozenset(BAD_FLAG_NAMES | {"COLD"})
SUSPECT_NAMES = frozenset({"TRANSIENT", "PERSIST", "OUTLIER", "HALO", "DICHROIC", "PHANMISS", "CROSSTALK", "GHOST", "GHOST_FPA", "GHOST_EXT"})
INFORMATIONAL_NAMES = frozenset({"SOURCE", "FULLSAMPLE"})  # never masked
CALIBRATION_BOOTSTRAP_FOV = 0.01
REASON_TEXT = {
    "insufficient_coverage": "insufficient field coverage",
    "wavelength_mismatch": "wavelength mismatch",
    "invalid_calibration": "calibration or position check failed",
    "quality_failure": "too many invalid pixels",
    "no_observations": "no usable observation",
}


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
    """A candidate pair failed verification. ``reason`` is one of DynamicSelectionError.REASONS."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason, self.detail = reason, detail


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
                raise _Reject("quality_failure", f"{obs.obs_id}: unsupported unit '{bunit}'")
            cal = calibration_from_hdul(hdul, expected_detector=obs.detector)
            data = np.array(hdul["IMAGE"].data, dtype=np.float32)
            variance = np.array(hdul["VARIANCE"].data, dtype=np.float32)
            flags = np.array(hdul["FLAGS"].data).astype(np.int64)
            masks = resolve_flag_masks(hdul["FLAGS"].header)
    except CalibrationError as exc:
        raise _Reject("invalid_calibration", f"{obs.obs_id}: {exc}") from exc
    except (OSError, KeyError, ValueError) as exc:
        raise _Reject("quality_failure", f"{obs.obs_id}: unreadable cutout ({exc})") from exc
    wcs = WCS(header)
    ctype = [str(c) for c in wcs.wcs.ctype]
    if not wcs.has_celestial or "TAN" not in ctype[0] or str(header.get("RADESYS", "ICRS")).strip().upper() not in {"ICRS", ""}:
        raise _Reject("invalid_calibration", f"{obs.obs_id}: unsupported celestial WCS {ctype}")
    if not (data.shape == variance.shape == flags.shape):
        raise _Reject("quality_failure", f"{obs.obs_id}: image/variance/flags shapes differ")
    return LoadedCutout(obs, path, header, wcs, data, variance, flags, masks, cal, str(header.get("DATE-OBS", "")), str(header.get("OBSID", obs.obs_id)))


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


def resample_cutout(cut: LoadedCutout, out_wcs: WCS, sky_ra: np.ndarray, sky_dec: np.ndarray, ra: float, dec: float,
                    pred: Prediction, s: Settings) -> DynamicFrame:
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

    dx, dy = full_frame_offset(cut.header, cut.obs.nx, cut.obs.ny)
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


class CutoutSource(Protocol):
    def get(self, obs: SiaObservation, ra: float, dec: float, size_deg: float, overscan: float | None = None) -> Path: ...


def frame_id(frame: DynamicFrame) -> str:
    return frame.cutout.obs.iso_date[:7]


class DynamicBlinkService:
    def __init__(self, settings: Settings, irsa: IrsaClient, store: CutoutSource, registry: CalibrationRegistry) -> None:
        self._s = settings
        self._irsa = irsa
        self._store = store
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

    def _ensure_calibrations(self, predictions: list[Prediction], ra: float, dec: float) -> tuple[dict[str, DetectorCalibration], dict[str, str]]:
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
        s = self._s
        observations, _ = self._irsa.search(ra, dec)
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
        calibrations, failed = self._ensure_calibrations(pairable, ra, dec)
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
        for tried, cand in enumerate(report.candidates[: s.top_pairs_to_try], 1):
            try:
                return self._verify_and_build(cand, ra, dec, fov, tried, rejected, calibrations, failed)
            except _Reject as rej:
                rejected.append(f"{cand.a.obs.obs_id} / {cand.b.obs.obs_id}: {rej.detail}")
                reasons.append(rej.reason)
                log.info("rejected pair %s: %s", cand.key, rej.detail)
        reason = max(set(reasons), key=lambda r: (reasons.count(r), r))
        raise DynamicSelectionError(
            f"None of the {len(rejected)} best candidate pair(s) passed verification. Most common problem: {REASON_TEXT[reason]}. First: {rejected[0]}", reason)

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
                          calibrations: dict[str, DetectorCalibration], excluded: dict[str, str]) -> DynamicResult:
        s = self._s
        out_n = output_size_pixels(fov, s.blink_pixel_scale_arcsec)
        out_wcs = build_output_wcs(ra, dec, out_n, s.blink_pixel_scale_arcsec, rotation_deg=float(cand.angle))
        sky_ra, sky_dec = output_sky_grid(out_wcs, out_n)
        frames: list[DynamicFrame] = []

        def fetch(pred: Prediction) -> Path | UpstreamInvalidResponse:
            try:
                return self._store.get(pred.obs, ra, dec, fov)
            except UpstreamInvalidResponse as exc:  # a bad cutout rejects this candidate; outages propagate
                return exc

        with ThreadPoolExecutor(max_workers=2) as pool:  # the two downloads are independent: run them side by side
            fetched = list(pool.map(fetch, (cand.a, cand.b)))
        for pred, path in zip((cand.a, cand.b), fetched):
            if isinstance(path, UpstreamInvalidResponse):
                raise _Reject("quality_failure", path.message) from path
            cut = load_cutout(path, pred.obs)
            frame = resample_cutout(cut, out_wcs, sky_ra, sky_dec, ra, dec, pred, s)
            err = math.hypot(frame.centre_xy[0] - pred.x, frame.centre_xy[1] - pred.y)
            if not math.isfinite(err) or err > s.max_position_error_px:
                raise _Reject("invalid_calibration", f"{pred.obs.obs_id}: exact detector position differs from the SIA prediction by {err:.1f} px (limit {s.max_position_error_px:g})")
            if not math.isfinite(frame.centre_wavelength_um):
                raise _Reject("invalid_calibration", f"{pred.obs.obs_id}: target lies outside the wavelength calibration grid")
            if frame.geometric_coverage < s.min_geometric_coverage:
                raise _Reject("insufficient_coverage", f"{pred.obs.obs_id}: only {frame.geometric_coverage:.1%} of the field lies inside the cutout")
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
            candidates_tried=tried, rejected=list(rejected), warnings=self._warnings(frames, common_good, gap_nm, mean_bw_nm, calibrations, field_gap) + [f"Detector excluded: {why}" for why in excluded.values()],
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
                notes.append(f"{f.suspect_fraction:.0%} of usable pixels in {f.cutout.obs.iso_date} carry caution flags (transient, outlier, halo, persistence); they are shown, not hidden.")
            predicted = calibrations.get(f.cutout.obs.detector)
            if predicted is not None and predicted.fingerprint != f.cutout.calibration.fingerprint:
                notes.append(f"{f.cutout.obs.obs_id} uses wavelength calibration {f.cutout.calibration.version}, which differs from the one used to shortlist candidates "
                             f"({predicted.version}); the exact values from the file were used.")
        return notes


@dataclass(eq=False)
class _Display:
    values: np.ndarray
    valid: np.ndarray
