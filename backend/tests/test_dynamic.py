"""Dynamic (archive-driven) blink: geometry, wavelength calibration, pair selection, archive behaviour, processing.

A synthetic archive (tests/dyn_factory.py) serves full detectors with known WCS, sources and calibration through the
same SIA2/cutout protocol as IRSA; nothing here touches the network or the real 65 MB images (those are used by the
separate real-FITS tests at the bottom, which skip when the fixtures are missing).
"""

from __future__ import annotations

import io
import math
import threading
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from PIL import Image

from app.config import Settings
from app.models.errors import DynamicSelectionError, InvalidParameters, UpstreamInvalidResponse, UpstreamTimeout, UpstreamUnavailable
from app.services.dynamic_blink import DynamicBlinkService, _Reject, establish_mapping, load_cutout, resolve_flag_masks
from app.services.fits_cutout import build_output_wcs
from app.services.irsa_archive import CutoutStore, FullHeaderStore, IrsaClient, parse_image_header, validate_cutout
from app.services.pair_selection import (
    Prediction, SiaRecordError, Settings as PairSettings, fit_detector_map, field_frame, group_epochs, observations_from_table,
    output_size_pixels, parse_polygon, predict, rank_pairs,
)
from app.services.irsa_archive import HeaderIncomplete
from app.services.spherex_calibration import CalibrationError, CalibrationRegistry, calibration_from_hdul, full_frame_offset, header_frame_offset
from dyn_factory import FLAG_BITS, SCALE, FakeArchive, FakeDetector
from fits_factory import offset_sky

T = (150.0, 40.0)
MAY, DEC_MJD = 60815.0, 61020.0
FOV = 0.1
N_OUT = output_size_pixels(FOV, SCALE)  # 59
HALF = (N_OUT - 1) / 2


@pytest.fixture
def archive(upstream):
    a = FakeArchive()
    a.install(upstream)
    return a


@pytest.fixture
def cfg(tmp_path) -> Settings:
    return Settings(_env_file=None, blink_cache_dir=tmp_path / "cache", blink_calibration_seed_files=[], irsa_backoff_base=0.0, irsa_max_retries=2)


class Stack:
    def __init__(self, cfg: Settings) -> None:
        self.cfg = cfg
        self.irsa = IrsaClient(cfg, sleep=lambda _s: None)
        self.store = CutoutStore(cfg, self.irsa)
        self.registry = CalibrationRegistry(cfg.blink_cache_dir / "calibration")
        self.headers = FullHeaderStore(cfg, self.irsa)
        self.service = DynamicBlinkService(cfg, self.irsa, self.store, self.registry, self.headers)


@pytest.fixture
def stack(cfg):
    s = Stack(cfg)
    yield s
    s.irsa.close()


def px_expected(east: float, north: float) -> tuple[float, float]:
    return HALF - east / SCALE, HALF + north / SCALE


def centroid(values: np.ndarray, near: tuple[float, float], r: int = 4) -> tuple[float, float]:
    x0, y0 = int(round(near[0])), int(round(near[1]))
    w = np.nan_to_num(values[y0 - r : y0 + r + 1, x0 - r : x0 + r + 1])
    w = np.clip(w - np.nanmedian(values), 0, None)
    yy, xx = np.mgrid[y0 - r : y0 + r + 1, x0 - r : x0 + r + 1]
    return float((w * xx).sum() / w.sum()), float((w * yy).sum() / w.sum())


def star(e, n, amp=5.0):
    return (*offset_sky(T, e, n), amp)


STARS = (star(60.0, 40.0), star(-50.0, -70.0))


def standard_pair(archive: FakeArchive, *, may_y=180, dec_y=186, may_extra=None, dec_extra=None, stars=STARS, det=3, tag="") -> tuple[FakeDetector, FakeDetector]:
    may = archive.add(**{**dict(obs_id=f"2025W20_2D_01{tag}_{det}", detector=det, mjd=MAY, target=T, target_pixel=(200, may_y), roll=0.0, sources=stars), **(may_extra or {})})
    dec = archive.add(**{**dict(obs_id=f"2025W51_1A_02{tag}_{det}", detector=det, mjd=DEC_MJD, target=T, target_pixel=(190, dec_y), roll=180.0, sources=stars), **(dec_extra or {})})
    return may, dec


# ===================================================================================== polygon / SIA records


def test_parse_polygon_variants_and_errors():
    closed = "POLYGON ICRS 10 1 11 1 11 2 10 2 10 1"
    assert parse_polygon(closed).shape == (4, 2)
    assert np.array_equal(parse_polygon("polygon 10 1 11 1 11 2 10 2"), parse_polygon(closed))
    assert parse_polygon("POLYGON ICRS 360.5 1 11 1 11 2 10 2")[0, 0] == pytest.approx(0.5)  # RA normalised
    for bad in ("CIRCLE 1 2 3", "POLYGON ICRS 1 2 3 4 5 6", "POLYGON ICRS 1 2 x 4 5 6 7 8", "POLYGON ICRS 1 2 3 nan 5 6 7 8", "POLYGON ICRS 1 95 3 4 5 6 7 8", "", None):
        with pytest.raises(SiaRecordError):
            parse_polygon(bad)


def row(obs="2025W20_2D_0001_3", band="SPHEREx-D3", t=60815.0, **kw):
    base = dict(obs_id=obs, energy_bandpassname=band, access_url="https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/x/l2b-v27-2026-198/3/f.fits",
                t_min=t, s_region="POLYGON ICRS 10 1 11 1 11 2 10 2 10 1", s_xel1=2040, s_xel2=2040, s_pixel_scale=6.15, em_min=1.6e-6, em_max=2.4e-6)
    base.update(kw)
    return base


def test_sia_rows_are_validated_deduplicated_and_never_fatal():
    obs, problems = observations_from_table([
        row(), row(),  # the archive lists each observation twice
        row(obs="B", band="SPHEREx-D5"), row(obs="C", band="weird"), row(obs="D", t=float("nan")), row(obs="E", s_xel1=0),
        row(obs="F", access_url="http://insecure/x.fits"), row(obs="G", s_region="nonsense"), row(obs="H", s_pixel_scale=99.0),
    ])
    assert [o.obs_id for o in obs] == ["2025W20_2D_0001_3", "B"]
    assert [o.detector for o in obs] == ["D3", "D5"] and obs[0].release == "l2b-v27-2026-198"
    assert len(problems) == 6
    assert obs[0].iso_date == "2025-05-20"


def test_epochs_group_by_timestamps_not_calendar_months():
    obs, _ = observations_from_table([row(obs=f"O{i}", t=t) for i, t in enumerate([60800, 60805, 60830, 60845, 61015, 61020, 61030])])
    epochs = group_epochs(obs, 30.0)
    assert [[o.obs_id for o in e] for e in epochs] == [["O0", "O1", "O2", "O3"], ["O4", "O5", "O6"]]
    assert len(group_epochs(obs, 10.0)) == 4  # a tighter gap splits the first survey (30 -> 25 -> 15 day gaps)
    assert group_epochs([], 30.0) == []


# ===================================================================================== geometry / prediction


def make_obs(det: FakeDetector, archive: FakeArchive):
    rows = list(__import__("astropy.io.votable", fromlist=["parse_single_table"]).parse_single_table(io.BytesIO(archive.votable(*det.target))).to_table(use_names_over_ids=True))
    obs, _ = observations_from_table([{k: r[k] for k in r.colnames} for r in rows])
    return next(o for o in obs if o.obs_id == det.obs_id)


@pytest.mark.parametrize("target", [(150.0, 40.0), (0.03, 10.0), (359.97, -12.0), (30.0, 85.0), (200.0, -80.0)])
def test_predicted_position_is_close_to_truth_incl_ra_wrap_and_poles(archive, target):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=target, target_pixel=(150.0, 230.0), roll=33.0)
    obs = make_obs(det, archive)
    pred = predict(obs, target[0], target[1], FOV, SCALE, 20.0, None)
    assert pred is not None
    assert (pred.x, pred.y) == pytest.approx((150.0, 230.0), abs=4.0)  # polygon affine is an estimate (reference: <10 px)
    assert 0 in pred.angles or len(pred.angles) > 0


def test_vertex_order_matters_and_wrong_order_is_visibly_wrong(archive):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(120.0, 260.0))
    obs = make_obs(det, archive)
    good = predict(obs, *T, FOV, SCALE, 20.0, None)
    swapped = type(obs)(**{**obs.__dict__, "vertices": obs.vertices[[0, 3, 2, 1]]})
    bad = predict(swapped, *T, FOV, SCALE, 20.0, None)
    assert math.dist((good.x, good.y), (120.0, 260.0)) < 4
    assert bad is None or math.dist((bad.x, bad.y), (120.0, 260.0)) > 50  # transposed: the exact-position check would reject it


def test_degenerate_or_non_rectangular_footprints_are_rejected(archive):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200))
    obs = make_obs(det, archive)
    frame = field_frame(*T)
    flat = type(obs)(**{**obs.__dict__, "vertices": np.repeat(obs.vertices[:1], 4, axis=0) + np.array([[0, 0], [1e-9, 0], [0, 1e-9], [1e-9, 1e-9]])})
    with pytest.raises(SiaRecordError):
        fit_detector_map(flat, frame)
    skewed = obs.vertices.copy(); skewed[2] += [0.3, 0.3]
    with pytest.raises(SiaRecordError):
        fit_detector_map(type(obs)(**{**obs.__dict__, "vertices": skewed}), frame)


def test_fov_containment_and_detector_edge_buffer(archive):
    # target 25 px from the left edge: a 59 px field needs ~29.5 px, so it only fits when the buffer is small/zero
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(25.0, 200.0))
    obs = make_obs(det, archive)
    assert predict(obs, *T, FOV, SCALE, 20.0, None) is None
    assert predict(obs, *T, FOV, SCALE, 0.0, None) is None  # still outside: 25 < 29.5
    near = archive.add(obs_id="W2_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(60.0, 200.0))
    p = predict(make_obs(near, archive), *T, FOV, SCALE, 20.0, None)
    assert p is not None and p.angles[0][0] == pytest.approx(60 - 29.5 - 20, abs=4)  # margin = distance to the buffered edge
    assert predict(make_obs(near, archive), *T, FOV, SCALE, 40.0, None) is None  # 30.5 px needed beyond the 40 px buffer
    assert predict(make_obs(near, archive), *T, 0.02, SCALE, 40.0, None) is not None  # a smaller field fits


def test_rotation_angles_describe_the_actual_output_footprint(archive):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(48.0, 200.0), roll=0.0)  # close to the left edge
    p = predict(make_obs(det, archive), *T, 0.1, SCALE, 5.0, None)
    # A 45-degree square reaches further (diagonal 1.41x) than the north-up square, so it must not be accepted where 0 deg is marginal
    assert 0 in p.angles
    margins = {a: m for a, (m, _) in p.angles.items()}
    assert margins[0] > margins.get(45, -1e9)


# ===================================================================================== wavelength calibration


def test_calibration_lookup_is_exact_at_control_points_bilinear_between_and_nan_outside(archive):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200), lam=(2.0, 3.0))
    with fits.open(io.BytesIO(det.cutout_bytes(*T, 0.05))) as h:
        cal = calibration_from_hdul(h)
    assert cal.detector == "D3" and cal.version == "cal-test-0001" and cal.wavelength_um.shape == (14, 9)
    lam, bw = cal.lookup(np.array([0.0, 399.0, 199.5]), np.array([0.0, 399.0, 199.5]))
    assert lam[0] == pytest.approx(2.0) and lam[1] == pytest.approx(3.0) and lam[2] == pytest.approx(2.5, abs=1e-3)  # zero-based pixel 0 is FITS pixel 1
    assert bw == pytest.approx([0.046] * 3, abs=1e-6)
    off = cal.lookup(np.array([-0.5, 400.0, 100.0, np.nan]), np.array([100.0, 100.0, -0.5, 100.0]))[0]
    assert np.isnan(off).all()  # outside the grid: NaN, never extrapolated


def test_calibration_rejects_bad_tables_and_wrong_detector(archive, tmp_path):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200))
    good = det.cutout_bytes(*T, 0.05)
    with fits.open(io.BytesIO(good)) as h:
        with pytest.raises(CalibrationError, match="expected D5"):
            calibration_from_hdul(h, expected_detector="D5")
    with fits.open(io.BytesIO(good), mode="update") if False else fits.open(io.BytesIO(good)) as h:
        h["WCS-WAVE"].data["VALUES"][0, 0, 0, 0] = 99.0  # outside 0.75-5 um
        with pytest.raises(CalibrationError, match="outside the SPHEREx range"):
            calibration_from_hdul(h)
        h["IMAGE"].header["DETECTOR"] = 9
        with pytest.raises(CalibrationError, match="DETECTOR"):
            calibration_from_hdul(h)


def test_registry_separates_detectors_and_versions_and_persists(archive, tmp_path):
    d3 = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200), lam=(1.8, 2.3))
    d5 = archive.add(obs_id="W1_2D_0001_5", detector=5, mjd=MAY, target=T, target_pixel=(200, 200), lam=(3.9, 4.6), calibration_id="cal-D5")
    cals = {}
    for d in (d3, d5):
        with fits.open(io.BytesIO(d.cutout_bytes(*T, 0.05))) as h:
            cals[d.detector] = calibration_from_hdul(h)
    reg = CalibrationRegistry(tmp_path / "cal")
    for c in cals.values():
        reg.register(c)
    assert reg.current("D3").wavelength_um.max() < 2.4 < 3.9 < reg.current("D5").wavelength_um.min()  # never shared between detectors
    assert reg.current("D4") is None and reg.detectors() == ["D3", "D5"]
    newer = type(cals[3])("D3", "cal-test-0002", cals[3].x, cals[3].y, cals[3].wavelength_um + 0.01, cals[3].bandwidth_um)
    reg.register(newer)
    assert reg.current("D3").version == "cal-test-0002" and reg.get("D3", "cal-test-0001") is not None
    reloaded = CalibrationRegistry(tmp_path / "cal")
    assert reloaded.detectors() == ["D3", "D5"] and reloaded.get("D5", "cal-D5").fingerprint == cals[5].fingerprint
    (tmp_path / "cal" / "D9_junk.npz").write_bytes(b"corrupt")
    assert CalibrationRegistry(tmp_path / "cal").detectors() == ["D3", "D5"]  # corrupt cache entries are discarded, not fatal


def test_full_frame_offset_and_the_cutout_local_coordinate_bug(archive):
    """Regression: cutout-local pixel positions must be converted to full-detector positions before the lookup."""
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(250.0, 310.0), lam=(1.8, 2.8))
    with fits.open(io.BytesIO(det.cutout_bytes(*T, 0.1))) as h:
        hdr, cal = h["IMAGE"].header, calibration_from_hdul(h)
        from astropy.wcs import WCS
        xl, yl = (float(v) for v in WCS(hdr).all_world2pix(*T, 0))
    dx, dy = full_frame_offset(hdr, 400, 400)
    assert dx == pytest.approx(200.5 - hdr["CRPIX1"]) and (xl + dx, yl + dy) == pytest.approx((250.0, 310.0), abs=1e-6)  # recovers the true detector position
    truth = det.true_wavelength_at(250.0, 310.0)
    right = cal.lookup(np.array([xl + dx]), np.array([yl + dy]))[0][0]
    wrong = cal.lookup(np.array([xl]), np.array([yl]))[0][0]  # the old prototype bug
    assert right == pytest.approx(truth, abs=1e-6)
    assert abs(wrong - truth) > 0.05  # the bug is large (tens of nm), so this test is meaningful
    with pytest.raises(CalibrationError):
        hdr2 = hdr.copy(); del hdr2["CRPIX1"]
        full_frame_offset(hdr2, 400, 400)
    with pytest.raises(CalibrationError):
        full_frame_offset(hdr, 1, 1)


# ===================================================================================== ranking


def prediction(obs_id, mjd, lam, bw, angles=(0,), det="D3", margin=50.0, field=None):
    obs = observations_from_table([row(obs=obs_id, t=mjd, band=f"SPHEREx-{det}")])[0][0]
    field_lams = np.full(5, lam) if field is None else np.asarray(field, float)
    return Prediction(obs, 100.0, 100.0, lam, bw, {a: (margin, field_lams) for a in angles})


PAIRS = PairSettings(max_pair_gap_nm=30.0, max_gap_over_bandwidth=0.75,
                     max_bandwidth_difference_fraction=0.25, min_epoch_separation_days=60.0)


def test_ranking_is_deterministic_and_relative_to_bandwidth():
    a1, a2 = prediction("A1", 60810, 2.000, 0.040), prediction("A2", 60811, 2.000, 0.080)
    b1, b2 = prediction("B1", 61010, 2.020, 0.040), prediction("B2", 61011, 2.020, 0.080)  # 20 nm: 50% of a 40 nm band, 25% of an 80 nm band
    rep = rank_pairs([[a1, a2], [b1, b2]], PAIRS)
    assert [c.key for c in rep.candidates] == [("A2", "B2"), ("A1", "B1")]
    assert rep.candidates[0].gap_over_bandwidth == pytest.approx(0.25) and rep.candidates[1].gap_over_bandwidth == pytest.approx(0.5)
    assert rep.rejected_bandwidth == 2 and rep.considered == 4  # 40 vs 80 nm bands differ by 50%
    shuffled = rank_pairs([[a2, a1], [b2, b1]], PAIRS)
    assert [c.key for c in shuffled.candidates] == [c.key for c in rep.candidates]


def test_ranking_thresholds_epoch_separation_detector_and_rotation_preference():
    a = prediction("A", 60810, 2.000, 0.046, angles=(30, 60, 150))
    far = prediction("B", 61010, 2.040, 0.046, angles=(30, 60, 150))          # 40 nm > 30 nm absolute limit
    soon = prediction("C", 60840, 2.001, 0.046, angles=(30,))                 # only 30 days later
    other = prediction("D", 61010, 2.001, 0.046, angles=(30,), det="D5")      # different detector
    ok = prediction("E", 61010, 2.010, 0.046, angles=(60, 150))
    rep = rank_pairs([[a], [far, soon, other, ok]], PAIRS)
    assert [c.key for c in rep.candidates] == [("A", "E")] and rep.candidates[0].angle == 150  # 150 degrees is only 30 from north-up (min(angle, 180-angle)), closer than 60
    assert (rep.rejected_wavelength, rep.too_close_in_time, rep.different_detector) == (1, 1, 1)
    # north-up wins whenever available
    n = rank_pairs([[prediction("A", 60810, 2.0, 0.046, angles=(0, 30))], [prediction("B", 61010, 2.0, 0.046, angles=(0, 30))]], PAIRS)
    assert n.candidates[0].angle == 0
    none = rank_pairs([[prediction("A", 60810, 2.0, 0.046, angles=(0,))], [prediction("B", 61010, 2.0, 0.046, angles=(15,))]], PAIRS)
    assert none.candidates == [] and none.no_common_rotation == 1


def test_field_wide_wavelength_variation_does_not_reject_a_target_matched_pair():
    a = prediction("A", 60810, 2.000, 0.040, field=[1.95, 2.05, 1.95, 2.05, 2.0])
    b = prediction("B", 61010, 2.000, 0.040, field=[2.05, 1.95, 2.05, 1.95, 2.0])   # equal at the centre, 100 nm apart at the corners
    rep = rank_pairs([[a], [b]], PAIRS)
    assert [c.key for c in rep.candidates] == [("A", "B")]
    assert rep.candidates[0].gap_nm == 0
    assert rep.candidates[0].field_gap_nm == pytest.approx(100)


# ===================================================================================== archive access


def test_sia_discovery_dedupes_and_caches(archive, stack):
    standard_pair(archive)
    obs, problems = stack.irsa.search(*T)
    assert sorted(o.obs_id for o in obs) == ["2025W20_2D_01_3", "2025W51_1A_02_3"] and not problems
    assert archive.sia_requests[0]["COLLECTION"] == "spherex_dr1" and archive.sia_requests[0]["POS"].startswith("CIRCLE 150.000000 40.000000")
    stack.irsa.search(*T)
    assert len(archive.sia_requests) == 1  # second call served from the cache


def test_sia_502_is_retried_then_succeeds_and_gives_up_cleanly(archive, stack, cfg):
    standard_pair(archive)
    archive.sia_status = [502, 502]
    assert len(stack.irsa.search(*T)[0]) == 2 and len(archive.sia_requests) == 3
    archive.sia_status = [502, 502, 502, 502]
    other = (151.0, 41.0)
    with pytest.raises(UpstreamUnavailable) as err:
        stack.irsa.search(*other)
    assert "unavailable" in err.value.message and len(archive.sia_requests) == 3 + cfg.irsa_max_retries + 1  # bounded: retries + 1 attempts, no infinite loop


def test_sia_timeout_and_garbage_responses_are_typed_errors(upstream, stack):
    upstream.get("https://irsa.ipac.caltech.edu/SIA").mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(UpstreamTimeout):
        stack.irsa.search(*T)
    upstream.get("https://irsa.ipac.caltech.edu/SIA").mock(return_value=httpx.Response(200, text="<html>not a votable</html>"))
    with pytest.raises(UpstreamInvalidResponse):
        stack.irsa.search(1.0, 2.0)


def test_empty_archive_result_is_no_observations(archive, stack):
    with pytest.raises(DynamicSelectionError) as err:
        stack.service.analyse(10.0, -20.0, FOV)
    assert err.value.code == "no_observations" and err.value.status_code == 404


def test_cutout_cache_hit_and_miss_and_atomic_files(archive, stack, cfg):
    may, _ = standard_pair(archive)
    obs, _ = stack.irsa.search(*T)
    o = next(x for x in obs if x.obs_id == may.obs_id)
    p1 = stack.store.get(o, *T, FOV)
    assert len(archive.downloads) == 1 and p1.exists() and not list(p1.parent.glob("*.part"))
    assert archive.downloads[0][3] == pytest.approx(FOV * cfg.dynamic_overscan)  # 1.5x overscan requested
    assert stack.store.get(o, *T, FOV) == p1 and len(archive.downloads) == 1  # hit
    stack.store.get(o, *T, 0.05)
    assert len(archive.downloads) == 2  # a different size is a miss


def test_cache_key_includes_position_so_coordinates_cannot_collide(archive, stack):
    """The prototype keyed files by observation and size only, so a second position silently reused the first file."""
    may, _ = standard_pair(archive)
    obs, _ = stack.irsa.search(*T)
    o = next(x for x in obs if x.obs_id == may.obs_id)
    other = offset_sky(T, 120.0, 90.0)
    a, b = stack.store.get(o, *T, FOV), stack.store.get(o, *other, FOV)
    assert a != b and len(archive.downloads) == 2
    with fits.open(a) as ha, fits.open(b) as hb:
        assert ha["IMAGE"].header["CRPIX1"] != hb["IMAGE"].header["CRPIX1"] or ha["IMAGE"].header["CRPIX2"] != hb["IMAGE"].header["CRPIX2"]
    assert CutoutStore.cache_key(o, *T, FOV, 1.5) != CutoutStore.cache_key(o, T[0], T[1] + 1e-5, FOV, 1.5)
    assert CutoutStore.cache_key(o, *T, FOV, 1.5) != CutoutStore.cache_key(o, *T, FOV, 2.0)


def test_corrupt_download_is_rejected_and_leaves_no_cache_file(archive, stack):
    may, _ = standard_pair(archive)
    may.poison = True
    obs, _ = stack.irsa.search(*T)
    o = next(x for x in obs if x.obs_id == may.obs_id)
    with pytest.raises(UpstreamInvalidResponse, match="unusable cutout"):
        stack.store.get(o, *T, FOV)
    d = stack.cfg.blink_cache_dir / "cutouts"
    assert not list(d.glob("*")) if d.exists() else True
    may.poison = False
    assert stack.store.get(o, *T, FOV).exists()  # recovers once the archive is healthy


def test_corrupt_cached_file_is_replaced(archive, stack):
    may, _ = standard_pair(archive)
    o = next(x for x in stack.irsa.search(*T)[0] if x.obs_id == may.obs_id)
    path = stack.store.get(o, *T, FOV)
    path.write_bytes(path.read_bytes()[:500])  # truncate
    again = stack.store.get(o, *T, FOV)
    validate_cutout(again) and None
    assert len(archive.downloads) == 2


def test_download_failures_retry_then_report_and_host_is_allow_listed(archive, stack):
    may, _ = standard_pair(archive)
    o = next(x for x in stack.irsa.search(*T)[0] if x.obs_id == may.obs_id)
    archive.cutout_status[may.obs_id] = [503, 503]
    stack.store.get(o, *T, FOV)  # two failures then success within the retry budget
    assert len(archive.downloads) == 3
    archive.cutout_status[may.obs_id] = [503] * 5
    with pytest.raises(UpstreamUnavailable):
        stack.store.get(o, *T, 0.07)
    evil = type(o)(**{**o.__dict__, "access_url": "https://evil.example/x.fits"})
    with pytest.raises(UpstreamInvalidResponse, match="allow-list"):
        stack.store.get(evil, *T, FOV)


def test_concurrent_requests_share_one_download_and_one_analysis(archive, stack):
    standard_pair(archive)
    o = stack.irsa.search(*T)[0][0]
    results, errors = [], []

    def grab():
        try:
            results.append(stack.store.get(o, *T, FOV))
        except Exception as exc:  # pragma: no cover
            errors.append(exc)

    threads = [threading.Thread(target=grab) for _ in range(8)]
    [t.start() for t in threads]; [t.join() for t in threads]
    assert not errors and len(set(results)) == 1 and len(archive.downloads) == 1

    archive.downloads.clear(); archive.sia_requests.clear()
    outs = []
    runners = [threading.Thread(target=lambda: outs.append(stack.service.analyse(*T, FOV))) for _ in range(6)]
    [t.start() for t in runners]; [t.join() for t in runners]
    assert len(outs) == 6 and all(r is outs[0] for r in outs)  # one shared result object
    assert len(archive.sia_requests) <= 1  # the search was cached before this burst


def test_cache_is_size_bounded_with_lru_eviction(archive, cfg):
    small = cfg.model_copy(update={"blink_cache_max_bytes": 1})
    irsa = IrsaClient(small, sleep=lambda _s: None)
    store = CutoutStore(small, irsa)
    may, dec = standard_pair(archive)
    obs = {o.obs_id: o for o in irsa.search(*T)[0]}
    first = store.get(obs[may.obs_id], *T, FOV)
    second = store.get(obs[dec.obs_id], *T, FOV)
    assert second.exists() and not first.exists()  # the oldest file was evicted, the newest kept
    irsa.close()


# ===================================================================================== end-to-end analysis


def analyse(stack, **kw):
    return stack.service.analyse(*T, kw.get("fov", FOV))


def test_dynamic_analysis_end_to_end_with_known_ground_truth(archive, stack):
    may, dec = standard_pair(archive)
    r = analyse(stack)
    assert r.size == N_OUT == 59 and r.rotation_deg == 0 and r.pair.key == (may.obs_id, dec.obs_id)
    a, b = r.frames
    assert [f.cutout.obs.iso_date for f in (a, b)] == ["2025-05-18", "2025-12-10"] or a.cutout.obs.mjd < b.cutout.obs.mjd
    # exact wavelengths come from each cutout's own table at the true detector position, using full-frame coordinates
    assert a.centre_wavelength_um == pytest.approx(may.true_wavelength_at(200, 180), abs=1e-4)
    assert b.centre_wavelength_um == pytest.approx(dec.true_wavelength_at(190, 186), abs=1e-4)
    assert r.exact_gap_nm == pytest.approx(abs(a.centre_wavelength_um - b.centre_wavelength_um) * 1000)
    assert r.exact_gap_over_bandwidth < 0.75 and r.pair.gap_nm == pytest.approx(r.exact_gap_nm, abs=6)  # prediction within a few nm
    assert a.geometric_coverage == 1.0 and r.common_good_fraction > 0.99
    # the 180-degree rotation is compensated: stationary stars coincide at their true position
    for e, n, _amp in [(60.0, 40.0, 0), (-50.0, -70.0, 0)]:
        truth = px_expected(e, n)
        ca, cb = centroid(a.values, truth), centroid(b.values, truth)
        assert ca == pytest.approx(truth, abs=0.4) and cb == pytest.approx(truth, abs=0.4)
    assert set(r.images) == {"2025-05", "2025-12"} and r.release == "l2b-v27-2026-198"
    assert all(Image.open(io.BytesIO(png)).size == (59, 59) for png in r.images.values())
    assert r.wcs_header["CTYPE1"] == "RA---TAN" and r.wcs_header["CRPIX1"] == 30.0


@pytest.mark.parametrize("requested", [None, 1.875])
def test_target_wavelength_matching_is_independent_of_fov(archive, stack, requested):
    may, dec = standard_pair(archive)
    results = [stack.service.analyse(*T, fov, wavelength_um=requested) for fov in (0.02, 0.1, 0.5)]
    small, _, wide = results
    for result in results:
        assert result.pair.key == (may.obs_id, dec.obs_id)
        assert result.pair.gap_nm == pytest.approx(small.pair.gap_nm)
        assert result.exact_gap_nm == pytest.approx(small.exact_gap_nm, abs=1e-6)
        for frame, reference in zip(result.frames, small.frames):
            assert frame.centre_wavelength_um == pytest.approx(reference.centre_wavelength_um, abs=1e-9)
            assert frame.centre_bandwidth_um == pytest.approx(reference.centre_bandwidth_um, abs=1e-9)
    # Opposite detector orientations give a large edge mismatch, but the target still matches.
    assert wide.field_gap_nm > 1.5 * wide.frames[0].centre_bandwidth_um * 1000
    assert wide.field_gap_nm > small.field_gap_nm
    assert any("Across the field" in warning for warning in wide.warnings)


def test_fits_verification_keeps_field_wavelength_variation_as_diagnostic_only(archive, stack):
    standard_pair(archive)
    small = stack.service.analyse(*T, 0.02)
    wide = stack.service._verify_and_build(small.pair, *T, 0.5, 1, [], {"D3": stack.registry.current("D3")}, {})
    assert wide.exact_gap_nm == pytest.approx(small.exact_gap_nm, abs=1e-6)
    assert wide.field_gap_nm > 1.5 * wide.frames[0].centre_bandwidth_um * 1000
    assert any("Across the field" in warning for warning in wide.warnings)


def test_a_moving_source_remains_displaced_after_alignment(archive, stack):
    mover_a, mover_b = star(30.0, -20.0, 6.0), star(30.0 + 8 * SCALE, -20.0 + 4 * SCALE, 6.0)
    standard_pair(archive, stars=(), may_extra=dict(sources=(mover_a, STARS[0])), dec_extra=dict(sources=(mover_b, STARS[0])))
    a, b = analyse(stack).frames
    pa, pb = px_expected(30.0, -20.0), px_expected(30.0 + 8 * SCALE, -20.0 + 4 * SCALE)
    ca, cb = centroid(a.values, pa), centroid(b.values, pb)
    assert (cb[0] - ca[0], cb[1] - ca[1]) == pytest.approx((-8.0, 4.0), abs=0.8)  # 8 px east = -8 px in x; 4 px north = +4 px in y (centroid bias of the bilinear resampling < 0.6 px)
    assert b.values[round(pa[1]), round(pa[0])] < 0.5 * a.values[round(pa[1]), round(pa[0])]


def test_sip_distortion_is_honoured_in_reprojection(archive, stack):
    standard_pair(archive, may_extra=dict(sip=True), dec_extra=dict(sip=False))
    a, b = analyse(stack).frames
    for e, n in [(60.0, 40.0), (-50.0, -70.0)]:
        truth = px_expected(e, n)
        assert centroid(a.values, truth) == pytest.approx(truth, abs=0.45)


def test_quality_flag_policy_source_kept_hard_flags_invalid_suspect_reported(archive, stack):
    cy, cx = 180, 200  # target pixel of the May detector
    boxes = (("SOURCE", (cy - 10, cy + 10, cx - 12, cx + 12)),           # covers the star at (60", 40")? star lies at x=190, y=187 -> inside
             ("COLD", (cy + 5, cy + 9, cx - 30, cx - 26)), ("NONFUNC", (cy - 9, cy - 5, cx + 20, cx + 24)),
             ("STREAK", (cy - 20, cy - 16, cx - 20, cx - 5)), ("HALO", (cy + 12, cy + 24, cx - 25, cx + 25)), ("TRANSIENT", (cy - 25, cy - 21, cx + 8, cx + 20)))
    standard_pair(archive, may_extra=dict(flag_boxes=boxes))
    r = analyse(stack)
    a = r.frames[0]
    masks = a.cutout.masks
    assert masks.hard == (1 << FLAG_BITS["NONFUNC"])
    assert not masks.hard & (1 << FLAG_BITS["SOURCE"]) and not masks.hard & (1 << FLAG_BITS["HALO"]) and masks.suspect & (1 << FLAG_BITS["HALO"])
    def out_px(dx, dy):  # output pixel for a May detector pixel offset from the target pixel (north-up, unrotated detector; rows increase northward)
        return round(HALF + dx), round(HALF + dy)
    # hard-invalid regions are transparent
    assert not a.valid[out_px(22, -7)[1], out_px(22, -7)[0]]
    assert a.valid[out_px(-28, 7)[1], out_px(-28, 7)[0]]
    assert a.valid[out_px(-12, -18)[1], out_px(-12, -18)[0]]
    # SOURCE-flagged pixels (and the star inside) stay valid and carry their flag; suspect-flagged pixels stay valid and are counted
    assert a.valid[out_px(0, 0)[1], out_px(0, 0)[0]] and a.source_fraction > 0.1
    assert a.valid[out_px(0, -17)[1], out_px(0, -17)[0]] and a.suspect_fraction > 0.02
    assert a.valid[out_px(0, 0)[1], out_px(0, 0)[0]]
    assert (a.flags[out_px(0, 0)[1], out_px(0, 0)[0]] >> FLAG_BITS["SOURCE"]) & 1


def test_flags_are_never_interpolated_only_nearest_neighbour(archive, stack):
    boxes = (("OUTLIER", (170, 180, 190, 200)), ("SOURCE", (180, 190, 200, 210)), ("HALO", (190, 200, 210, 220)))
    standard_pair(archive, may_extra=dict(flag_boxes=boxes))
    a = analyse(stack).frames[0]
    allowed = {0} | {1 << FLAG_BITS[n] for n, _ in boxes}
    assert set(np.unique(a.flags)) <= allowed  # a bilinear blend of 2**19 and 2**21 would create values like 2**20 + ...
    assert len(set(np.unique(a.flags))) >= 3


def test_invalid_pixels_do_not_contaminate_and_variance_is_validated(archive, stack):
    nan_box, var_box = (175, 180, 195, 200), (182, 186, 205, 209)
    standard_pair(archive, may_extra=dict(nan_box=nan_box, variance_box=var_box))
    a = analyse(stack).frames[0]
    def out_px(dx, dy):
        return round(HALF + dx), round(HALF + dy)
    assert not a.valid[out_px(-3, -3)[1], out_px(-3, -3)[0]]       # NaN science pixels
    assert not a.valid[out_px(6, 3)[1], out_px(6, 3)[0]]       # variance == 0 pixels
    assert np.isnan(a.values[~a.valid]).all() and np.isfinite(a.values[a.valid]).all()
    # poisoning every invalid source pixel changes no valid output pixel (contamination test from the diagnostic)
    cut = a.cutout
    from app.services.dynamic_blink import resample_cutout
    poisoned = type(cut)(**{**cut.__dict__, "data": np.where(np.isfinite(cut.data) & (cut.variance <= 0), 1e9, cut.data).astype(np.float32)})
    r = analyse(stack)
    again = resample_cutout(poisoned, build_output_wcs(*T, N_OUT, SCALE), *__import__("app.services.fits_cutout", fromlist=["x"]).output_sky_grid(build_output_wcs(*T, N_OUT, SCALE), N_OUT), *T, a.mapping, stack.cfg)
    assert np.array_equal(again.valid, a.valid) and np.array_equal(again.values[a.valid], a.values[a.valid])


def test_geometric_versus_quality_coverage_are_reported_separately(archive, stack):
    standard_pair(archive, may_extra=dict(nan_box=(180, 190, 190, 210)))  # a ~6 % NaN hole inside the field
    r = analyse(stack)
    a, b = r.frames
    assert a.geometric_coverage == 1.0 and 0.85 < a.good_fraction < 0.95  # all of the field is on the detector, but ~6-10 % of it is unusable
    assert r.common_geometric_coverage == 1.0 and r.common_good_fraction == pytest.approx(min(a.good_fraction, b.good_fraction), abs=0.1)
    assert any("Only" in w and "usable in both frames" in w for w in r.warnings)


def test_poor_quality_pair_is_rejected_with_quality_failure(archive, stack):
    standard_pair(archive, may_extra=dict(nan_box=(160, 200, 175, 205)))  # ~35 % of the field is NaN
    with pytest.raises(DynamicSelectionError) as err:
        analyse(stack)
    assert err.value.code == "quality_failure" and "common usable coverage" in err.value.message


def test_candidate_rejection_falls_back_to_the_next_pair_and_reports_it(archive, stack):
    may3, dec3 = standard_pair(archive, may_extra=dict(nan_box=(160, 200, 175, 205)))          # best predicted pair is unusable (~35 % NaN)
    may5, dec5 = standard_pair(archive, may_y=180, dec_y=190, det=5, tag="b", may_extra=dict(lam=(3.9, 4.06)), dec_extra=dict(lam=(3.9, 4.06)))
    r = analyse(stack)
    assert r.pair.a.obs.detector == "D5" and r.candidates_tried == 2 and len(r.rejected) == 1 and may3.obs_id in r.rejected[0]
    assert "common usable coverage" in r.rejected[0]
    assert {c.detector for c in (stack.registry.current("D3"), stack.registry.current("D5"))} == {"D3", "D5"}  # D3 and D5 each bootstrapped separately


def test_every_candidate_failing_gives_a_reason_not_a_silent_accept(archive, stack):
    standard_pair(archive, may_extra=dict(nan_box=(0, 400, 0, 400)))
    with pytest.raises(DynamicSelectionError) as err:
        analyse(stack)
    assert err.value.reason in DynamicSelectionError.REASONS


@pytest.mark.parametrize("fov", [0.02, 0.1, 0.2])
def test_wavelength_mismatch_is_reported_as_such(archive, stack, fov):
    standard_pair(archive, may_y=100, dec_y=300)  # ~125 nm apart at the target
    with pytest.raises(DynamicSelectionError) as err:
        stack.service.analyse(*T, fov)
    assert err.value.code == "wavelength_mismatch" and "comparable wavelengths" in err.value.message
    assert "at the target" in err.value.message
    assert "smaller field of view" not in err.value.message


def test_one_epoch_only_and_insufficient_coverage_have_distinct_reasons(archive, stack):
    archive.add(obs_id="2025W20_2D_01_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200))
    with pytest.raises(DynamicSelectionError) as err:
        analyse(stack)
    assert err.value.code == "no_observations" and "only one survey epoch" in err.value.message


def test_target_near_the_detector_edge_is_insufficient_coverage(archive, stack):
    archive.add(obs_id="2025W20_2D_01_3", detector=3, mjd=MAY, target=T, target_pixel=(20, 200))
    archive.add(obs_id="2025W51_1A_02_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(25, 200), roll=180.0)
    with pytest.raises(DynamicSelectionError) as err:
        analyse(stack)
    assert err.value.code == "insufficient_coverage" and "smaller field of view" in err.value.message
    relaxed = Stack(stack.cfg.model_copy(update={"dynamic_detector_buffer_px": 0.0}))  # the suggested smaller field works once the margin allows
    try:
        assert relaxed.service.analyse(*T, 0.02).size == output_size_pixels(0.02, SCALE)
    finally:
        relaxed.irsa.close()


def test_detector_position_cross_check_rejects_wrong_geometry(archive, stack):
    may, dec = standard_pair(archive)
    obs = {o.obs_id: o for o in stack.irsa.search(*T)[0]}
    wrong = type(obs[may.obs_id])(**{**obs[may.obs_id].__dict__, "nx": 1000, "ny": 1000})  # SIA claims a bigger detector: CRPIX_full would be wrong
    stack.registry.register(__import__("app.services.spherex_calibration", fromlist=["x"]).calibration_from_hdul(fits.open(io.BytesIO(may.cutout_bytes(*T, 0.05)))))
    pa = predict(obs[may.obs_id], *T, FOV, SCALE, 20.0, stack.registry.current("D3"))
    pb = predict(obs[dec.obs_id], *T, FOV, SCALE, 20.0, stack.registry.current("D3"))
    from app.services.pair_selection import PairCandidate
    cand = PairCandidate(pa, pb, 0, 5.0, 0.1, 0.0, 5.0, 50.0, 200.0)
    cand_wrong = PairCandidate(type(pa)(wrong, pa.x, pa.y, pa.wavelength_um, pa.bandwidth_um, pa.angles), pb, 0, 5.0, 0.1, 0.0, 5.0, 50.0, 200.0)
    stack.service._verify_and_build(cand, *T, FOV, 1, [], {"D3": stack.registry.current("D3")}, {})  # sanity: consistent metadata passes
    with pytest.raises(_Reject) as err:
        stack.service._verify_and_build(cand_wrong, *T, FOV, 1, [], {"D3": stack.registry.current("D3")}, {})
    assert err.value.reason == "coordinate_mapping_failed" and "archive lists 1000x1000" in err.value.detail


def test_calibration_changes_between_releases_are_noticed(archive, stack):
    may, dec = standard_pair(archive)
    stack.registry.register(__import__("app.services.spherex_calibration", fromlist=["x"]).calibration_from_hdul(fits.open(io.BytesIO(may.cutout_bytes(*T, 0.05)))))
    dec.calibration_id = "cal-test-0002"
    r = analyse(stack)
    assert r.frames[1].cutout.calibration.version == "cal-test-0002"
    assert any("differs from the one used to shortlist" in w for w in r.warnings) or r.frames[1].cutout.calibration.fingerprint == stack.registry.current("D3").fingerprint


def test_archive_outage_is_reported_as_unavailable_not_as_missing_data(archive, stack):
    archive.sia_status = [502] * 10
    with pytest.raises(UpstreamUnavailable):
        analyse(stack)


def test_fov_limits_are_enforced(archive, stack):
    standard_pair(archive)
    for bad in (0.0, 0.019, 0.51, float("nan"), -1.0):
        with pytest.raises(InvalidParameters):
            stack.service.analyse(*T, bad)


def test_output_grid_rotation_matches_the_wcs(archive):
    for angle in (0, 30, 90, 165):
        w = build_output_wcs(*T, 59, SCALE, rotation_deg=angle)
        c = w.all_pix2world(29.0, 29.0, 0)
        assert (float(c[0]), float(c[1])) == pytest.approx(T, abs=1e-9)  # centre pixel is the target
        one = w.all_pix2world(30.0, 29.0, 0)  # one pixel along +x
        sep = math.hypot((float(one[0]) - T[0]) * math.cos(math.radians(T[1])), float(one[1]) - T[1]) * 3600
        assert sep == pytest.approx(SCALE, abs=0.01)
    assert np.allclose(build_output_wcs(*T, 59, SCALE).wcs.get_pc() @ np.diag(build_output_wcs(*T, 59, SCALE).wcs.cdelt),
                       build_output_wcs(*T, 59, SCALE, rotation_deg=0).wcs.get_pc() @ np.diag(build_output_wcs(*T, 59, SCALE, rotation_deg=0).wcs.cdelt))


# ===================================================================================== detector mapping regressions
# Background: reprocessed "retry" images (WCSRETRY = T) have a full-image CRPIX that is NOT the detector centre
# (real example: (1017.2, 905.4) instead of (1020.5, 1020.5)). A cutout does not record the original CRPIX, so assuming the
# centre placed the target 115-125 px away from where the SIA footprint (and the file's own full WCS) put it.

OFF_CENTRE = [None, (150.5, 200.5), (200.5, 90.0), (120.2, 260.8)]


@pytest.mark.parametrize("roll", [0.0, 90.0, 180.0, 37.0])
@pytest.mark.parametrize("crpix", OFF_CENTRE)
def test_exact_position_and_wavelength_hold_for_any_orientation_and_crpix_convention(archive, stack, roll, crpix):
    may = archive.add(obs_id="2025W31_2A_0404_3", detector=3, mjd=MAY, target=T, target_pixel=(190.0, 190.0), roll=roll, crpix_full=crpix, sources=STARS)
    dec = archive.add(obs_id="2026W09_2A_0483_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(200.0, 196.0), roll=(roll + 180) % 360, crpix_full=crpix, sources=STARS, retry=crpix is not None)
    r = analyse(stack)
    a, b = r.frames
    assert a.centre_xy == pytest.approx((190.0, 190.0), abs=0.05) and b.centre_xy == pytest.approx((200.0, 196.0), abs=0.05)  # true detector positions
    assert a.centre_wavelength_um == pytest.approx(may.true_wavelength_at(190, 190), abs=1e-4)
    assert b.centre_wavelength_um == pytest.approx(dec.true_wavelength_at(200, 196), abs=1e-4)
    assert b.mapping.full_crpix == pytest.approx(crpix or (200.5, 200.5))
    assert not any("footprint metadata" in w for w in r.warnings)  # the SIA prediction was within tolerance throughout


def test_the_centre_crpix_assumption_would_have_failed_on_a_retry_image(archive, stack):
    """The exact failure from production, reproduced: the old conversion lands >100 px from the truth; the header-based one does not."""
    standard_pair(archive, dec_extra=dict(crpix_full=(197.2, 105.4), retry=True))
    o = next(x for x in stack.irsa.search(*T)[0] if x.obs_id == "2025W51_1A_02_3")
    assert o.release == "l2b_retry-v27-2026-198"  # the reprocessed file name is parsed (it used to be 'unknown')
    dec = archive.detectors[o.obs_id]
    path = stack.store.get(o, *T, FOV)
    with fits.open(path) as h:
        hdr = h["IMAGE"].header
        from astropy.wcs import WCS
        xl, yl = (float(v) for v in WCS(hdr).all_world2pix(*T, 0))
    dx, dy = full_frame_offset(hdr, 400, 400)   # assumes CRPIX_full = centre: the old behaviour
    assert math.hypot(xl + dx - 190.0, yl + dy - 186.0) > 90  # ~95 px off here (115 px on the real 2040-pixel image)
    assert abs(dy - round(dy)) > 0.01 or abs(dx - round(dx)) > 0.01  # and the crop origin it implies is not even a whole pixel: a tell-tale
    full = stack.headers.get(o)
    hx, hy = header_frame_offset(hdr, full)
    assert (xl + hx, yl + hy) == pytest.approx((190.0, 186.0), abs=0.05)
    r = analyse(stack)
    assert r.frames[1].mapping.full_crpix == pytest.approx((197.2, 105.4)) and r.exact_gap_nm == pytest.approx(r.pair.gap_nm, abs=6)


def test_replica_of_the_production_failure_on_a_full_size_detector(archive, stack):
    """2026W09_2A_0483_3 (D3 retry): CRPIX (1017.2, 905.4) on a 2040 x 2040 image, target at (1266.4, 366.3)."""
    big = dict(n=2040, background=0.15)
    archive.add(obs_id="2025W32_1A_0076_1", detector=3, mjd=MAY, target=T, target_pixel=(1737.0, 378.0), roll=-30.0, **big)
    retry = archive.add(obs_id="2026W09_2A_0483_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(1266.44, 366.26), roll=150.0,
                        crpix_full=(1017.2, 905.4), retry=True, release="l2b-v27-2026-229", **big)
    r = analyse(stack)
    frame = r.frames[1]
    assert frame.cutout.obs.obs_id == "2026W09_2A_0483_3" and frame.centre_xy == pytest.approx((1266.44, 366.26), abs=0.05)
    assert frame.mapping.prediction_error_px < 25 and frame.mapping.full_crpix == pytest.approx((1017.2, 905.4))
    assert frame.centre_wavelength_um == pytest.approx(retry.true_wavelength_at(1266.44, 366.26), abs=1e-4)
    assert frame.mapping.dy == pytest.approx(1017.2 * 0 + 905.4 - frame.cutout.header["CRPIX2"])
    centre_dy = 1020.5 - frame.cutout.header["CRPIX2"]
    assert abs(centre_dy - frame.mapping.dy) > 100  # what the centre assumption would have got wrong


def test_2025_and_2026_releases_and_retry_file_names(archive, stack):
    standard_pair(archive, may_extra=dict(release="l2b-v27-2026-225"), dec_extra=dict(release="l2b-v27-2026-229", crpix_full=(150.0, 120.0), retry=True))
    obs = {o.obs_id: o for o in stack.irsa.search(*T)[0]}
    assert obs["2025W20_2D_01_3"].release == "l2b-v27-2026-225" and obs["2025W51_1A_02_3"].release == "l2b_retry-v27-2026-229"
    r = analyse(stack)
    assert r.release == "l2b-v27-2026-225" and r.frames[1].cutout.obs.release == "l2b_retry-v27-2026-229"
    assert r.frames[0].mapping.full_crpix == pytest.approx((200.5, 200.5)) and r.frames[1].mapping.full_crpix == pytest.approx((150.0, 120.0))  # per-file conventions, never shared


def test_header_offset_must_be_a_whole_pixel_crop_origin(archive):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(250.0, 310.0), crpix_full=(190.3, 150.9))
    with fits.open(io.BytesIO(det.cutout_bytes(*T, 0.1))) as h:
        cut = h["IMAGE"].header
    full = det.full_header()
    dx, dy = header_frame_offset(cut, full)
    assert dx == round(dx) and dy == round(dy)
    bad = full.copy(); bad["CRPIX1"] = float(bad["CRPIX1"]) + 0.5
    with pytest.raises(CalibrationError, match="whole-pixel crop origin"):
        header_frame_offset(cut, bad)
    missing = full.copy(); del missing["CRPIX2"]
    with pytest.raises(CalibrationError, match="missing CRPIX"):
        header_frame_offset(cut, missing)


def mapping_case(archive, tmp_path, **kw):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(250.0, 310.0), **kw)
    path = tmp_path / "c.fits"
    path.write_bytes(det.cutout_bytes(*T, 0.1))
    obs = make_obs(det, archive)
    cfg = Settings(_env_file=None)
    pred = predict(obs, *T, FOV, SCALE, 20.0, None)
    return det, load_cutout(path, obs), pred, cfg


def test_mapping_rejects_headers_that_disagree_with_the_cutout(archive, tmp_path):
    det, cut, pred, cfg = mapping_case(archive, tmp_path, crpix_full=(190.3, 150.9))
    ok = establish_mapping(cut, pred, det.full_header(), *T, cfg)
    assert ok.exact_xy == pytest.approx((250.0, 310.0), abs=0.05) and ok.prediction_error_px < 10
    shifted = det.full_header(); shifted["CRVAL1"] = float(shifted["CRVAL1"]) + 5e-4  # full WCS no longer the cutout's parent
    with pytest.raises(_Reject, match="disagree") as err:
        establish_mapping(cut, pred, shifted, *T, cfg)
    assert err.value.reason == "coordinate_mapping_failed" and err.value.obs == ("W1_2D_0001_3", "D3")
    wrong_size = det.full_header(); wrong_size["NAXIS1"] = 1000
    with pytest.raises(_Reject, match="archive lists"):
        establish_mapping(cut, pred, wrong_size, *T, cfg)
    wrong_det = det.full_header(); wrong_det["DETECTOR"] = 4
    with pytest.raises(_Reject, match="full header is detector 4"):
        establish_mapping(cut, pred, wrong_det, *T, cfg)
    off_by_crop = det.full_header(); off_by_crop["CRPIX1"] = float(off_by_crop["CRPIX1"]) + 0.5
    with pytest.raises(_Reject, match="whole-pixel"):
        establish_mapping(cut, pred, off_by_crop, *T, cfg)


def test_footprint_prediction_error_is_a_warning_when_the_exact_position_is_verified(archive, stack):
    """SIA polygon wrong by 60 px, but the file's own header is self-consistent: the verified position is used, with a warning."""
    standard_pair(archive, dec_extra=dict(footprint_shift_px=(0.0, 60.0)))
    r = analyse(stack)
    assert r.frames[1].centre_xy == pytest.approx((190.0, 186.0), abs=0.05) and r.frames[1].mapping.prediction_error_px > 40
    assert any("footprint metadata" in w and "verified header position was used" in w for w in r.warnings)
    assert r.frames[1].centre_wavelength_um == pytest.approx(archive.detectors["2025W51_1A_02_3"].true_wavelength_at(190, 186), abs=1e-4)


def test_footprint_prediction_error_beyond_the_hard_limit_is_rejected_with_its_own_reason(archive, cfg):
    stack = Stack(cfg.model_copy(update={"max_footprint_error_px": 60.0}))
    try:
        standard_pair(archive, dec_extra=dict(footprint_shift_px=(100.0, 0.0)))
        with pytest.raises(DynamicSelectionError) as err:
            stack.service.analyse(*T, FOV)
        assert err.value.code == "footprint_mismatch"
        assert "footprint metadata contradicts" in err.value.message and "px" not in err.value.message  # concise: numbers stay in the log
    finally:
        stack.irsa.close()


def test_unreadable_archive_header_is_a_coordinate_mapping_failure_not_a_calibration_failure(archive, stack):
    standard_pair(archive, dec_extra=dict(header_poison=True))
    with pytest.raises(DynamicSelectionError) as err:
        analyse(stack)
    assert err.value.code == "coordinate_mapping_failed" and "calibration" not in err.value.message.lower().replace("wavelength", "")
    assert "could not be verified" in err.value.message


def test_header_service_outage_is_an_archive_error_and_is_retried(archive, stack):
    standard_pair(archive)
    archive.header_status = [503, 503]
    assert analyse(stack).size == 59  # recovered within the retry budget
    stack2 = Stack(stack.cfg.model_copy(update={"blink_cache_dir": stack.cfg.blink_cache_dir / "other"}))
    try:
        archive.header_status = [503] * 12
        with pytest.raises(UpstreamUnavailable):
            stack2.service.analyse(*T, FOV)
    finally:
        stack2.irsa.close()


def test_invalid_calibration_table_keeps_its_own_reason(archive, stack):
    standard_pair(archive, may_extra=dict(lam=(9.0, 10.0)), dec_extra=dict(lam=(9.0, 10.0)))  # outside 0.75-5 um
    with pytest.raises(DynamicSelectionError) as err:
        analyse(stack)
    assert err.value.code == "invalid_calibration"


def test_headers_are_cached_in_memory_and_on_disk(archive, stack, cfg):
    standard_pair(archive)
    analyse(stack)
    n = len(archive.header_requests)
    assert n == 2
    stack.service.analyse(*T, 0.05)  # new field of view: new cutouts, same files
    assert len(archive.header_requests) == n
    fresh = FullHeaderStore(cfg, stack.irsa)  # a new process: read from disk
    obs = stack.irsa.search(*T)[0][0]
    assert fresh.get(obs)["CRPIX1"] and len(archive.header_requests) == n


def test_cached_only_header_lookup_never_fetches_from_archive(archive, stack):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200))
    obs = make_obs(det, archive)
    with pytest.raises(UpstreamInvalidResponse, match="No valid cached full-image header"):
        stack.headers.get(obs, cached_only=True)
    assert archive.header_requests == []


def test_parse_image_header_handles_truncation_and_garbage(archive):
    det = archive.add(obs_id="W1_2D_0001_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200), crpix_full=(197.2, 105.4))
    data = det.full_header_bytes()
    h = parse_image_header(data + b"\0" * 5000)
    assert (h["CRPIX1"], h["CRPIX2"], h["NAXIS1"], h["NAXIS2"]) == (197.2, 105.4, 400, 400)
    with pytest.raises(HeaderIncomplete):
        parse_image_header(data[:2880 + 400])   # IMAGE header cut short
    with pytest.raises(HeaderIncomplete):
        parse_image_header(b"<html>nope</html>" * 200)


@pytest.mark.skipif(not Path("~/Downloads/spherex_D5_2025_05_full.fits").expanduser().is_file(), reason="real D5 fixture not available")
def test_real_full_file_header_parses_from_its_first_bytes():
    path = Path("~/Downloads/spherex_D5_2025_05_full.fits").expanduser()
    h = parse_image_header(path.read_bytes()[: 96 * 1024])
    assert (h["CRPIX1"], h["CRPIX2"], h["NAXIS1"], h["NAXIS2"], h["DETECTOR"]) == (1020.5, 1020.5, 2040, 2040, 5)  # the centre convention holds for normal images
    with fits.open(path) as full:
        assert dict(full["IMAGE"].header) == dict(h) or all(full["IMAGE"].header[k] == h[k] for k in ("CRPIX1", "CRVAL1", "CD1_1") if k in h)


# ===================================================================================== candidate fallback


def test_an_observation_that_failed_is_not_fetched_again_for_another_pair(archive, stack):
    bad = archive.add(obs_id="2025W20_2D_01b_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 180), sources=STARS, header_poison=True)
    good = archive.add(obs_id="2025W20_2D_01g_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 200), sources=STARS)
    d1 = archive.add(obs_id="2025W51_1A_021_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(190, 181), roll=180.0, sources=STARS)
    d2 = archive.add(obs_id="2025W51_1A_022_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(190, 182), roll=180.0, sources=STARS)
    r = analyse(stack)  # ranking: (bad, d1), (bad, d2), (good, d1), ...
    assert r.pair.a.obs.obs_id == good.obs_id and r.candidates_tried == 2 and len(r.rejected) == 1 and bad.obs_id in r.rejected[0]
    assert [d[0] for d in archive.downloads if d[3] > 0.02].count(bad.obs_id) == 1  # its science cutout was fetched once (the 0.01 deg one is the calibration bootstrap)
    assert archive.header_requests.count(bad.obs_id) == 2  # one attempt = the 96 KB range plus the larger retry range, never repeated for the second pair
    assert r.pair.b.obs.obs_id == d2.obs_id  # the second pair containing `bad` was skipped; the next admissible pair won


def test_the_shortlist_is_extended_only_for_metadata_failures(archive, cfg):
    stack = Stack(cfg.model_copy(update={"top_pairs_to_try": 1, "max_pairs_to_try": 4}))
    try:
        for i, y in enumerate((187, 185)):  # both are one pixel row from the December observation: they rank first and second
            archive.add(obs_id=f"2025W20_2D_01{i}_3", detector=3, mjd=MAY, target=T, target_pixel=(200, y), sources=STARS, header_poison=True)
        good = archive.add(obs_id="2025W20_2D_01z_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 194), sources=STARS)
        archive.add(obs_id="2025W51_1A_02_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(190, 186), roll=180.0, sources=STARS)
        r = stack.service.analyse(*T, FOV)  # top_pairs_to_try is 1, yet the two header failures lead on to the third pair
        assert r.pair.a.obs.obs_id == good.obs_id and r.candidates_tried == 3 and len(r.rejected) == 2
    finally:
        stack.irsa.close()


def test_data_quality_failures_do_not_trigger_the_extension(archive, cfg):
    stack = Stack(cfg.model_copy(update={"top_pairs_to_try": 1, "max_pairs_to_try": 4}))
    try:
        archive.add(obs_id="2025W20_2D_010_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 187), sources=STARS, nan_box=(160, 200, 175, 205))
        archive.add(obs_id="2025W20_2D_011_3", detector=3, mjd=MAY, target=T, target_pixel=(200, 196), sources=STARS)
        archive.add(obs_id="2025W51_1A_02_3", detector=3, mjd=DEC_MJD, target=T, target_pixel=(190, 186), roll=180.0, sources=STARS)
        with pytest.raises(DynamicSelectionError) as err:
            stack.service.analyse(*T, FOV)
        assert err.value.code == "quality_failure"
        assert len([d for d in archive.downloads if d[3] > 0.02]) == 2  # only the first pair (two cutouts) was tried
    finally:
        stack.irsa.close()


def test_each_failure_reason_gets_its_own_code_and_a_concise_message(archive, stack):
    messages = {}
    for reason in DynamicSelectionError.REASONS:
        messages[reason] = str(DynamicSelectionError("x", reason).code)
    assert set(messages.values()) == set(DynamicSelectionError.REASONS)
    from app.services.dynamic_blink import DETAIL_IN_MESSAGE, METADATA_REASONS, REASON_PRIORITY, REASON_TEXT
    assert set(REASON_TEXT) >= METADATA_REASONS | DETAIL_IN_MESSAGE and set(REASON_PRIORITY) == set(REASON_TEXT)
    assert REASON_TEXT["invalid_calibration"] != REASON_TEXT["coordinate_mapping_failed"] != REASON_TEXT["footprint_mismatch"]


# ===================================================================================== HTTP API


@pytest.fixture
def api(make_client, archive, cfg):
    return make_client(**{k: getattr(cfg, k) for k in ("blink_cache_dir", "blink_calibration_seed_files", "irsa_backoff_base", "irsa_max_retries")})


def test_dynamic_endpoint_contract_images_and_provenance(api, archive):
    standard_pair(archive)
    r = api.get("/api/blink/dynamic", params={"ra": T[0], "dec": T[1], "fov_deg": FOV})
    assert r.status_code == 200
    body = r.json()
    assert body["mode"] == "dynamic" and body["image_size"] == 59 and body["rotation_deg"] == 0 and body["fov_deg"] == FOV
    assert [f["id"] for f in body["frames"]] == ["2025-05", "2025-12"] and body["frames"][0]["detector"] == 3
    f0 = body["frames"][0]
    assert f0["obsid"].startswith("2025W20") and f0["bandwidth_um"] == pytest.approx(0.046, abs=1e-5) and 0 < f0["coverage_fraction"] <= 1 and f0["geometric_coverage"] == 1.0
    assert f0["wavelength_um"]["min"] <= f0["wavelength_um"]["mean"] <= f0["wavelength_um"]["max"] and f0["calibration_version"] == "cal-test-0001"
    sel = body["selection"]
    assert sel["actual_gap_nm"] == pytest.approx(abs(body["frames"][0]["wavelength_um"]["mean"] - body["frames"][1]["wavelength_um"]["mean"]) * 1000, abs=0.01)
    assert sel["candidates_tried"] == 1 and sel["thresholds"]["max_pair_gap_nm"] == 30.0
    assert "max_field_gap_over_bandwidth" not in sel["thresholds"]
    assert body["provenance"]["collection"] == "spherex_dr1" and body["provenance"]["release"] == "l2b-v27-2026-198" and "SOURCE" in body["provenance"]["flag_policy"]
    assert body["wcs"]["CTYPE1"] == "RA---TAN" and any("differ by" in w for w in body["warnings"])
    sizes = set()
    for frame in body["frames"]:
        img = api.get(frame["image_url"])
        assert img.status_code == 200 and img.headers["content-type"] == "image/png"
        im = Image.open(io.BytesIO(img.content)); im.load()
        sizes.add((im.size, im.mode))
    assert sizes == {((59, 59), "LA")}
    assert len(archive.sia_requests) == 1  # the images reused the cached analysis


def test_dynamic_endpoint_errors_use_the_standard_envelope(api, archive):
    assert api.get("/api/blink/dynamic", params={"ra": 10, "dec": -20}).json()["error"]["code"] == "no_observations"
    assert api.get("/api/blink/dynamic/images/1999-01.png", params={"ra": 150, "dec": 40}).status_code in (404, 422)
    assert api.get("/api/blink/dynamic/images/..%2Fx.png", params={"ra": 150, "dec": 40}).headers["content-type"].startswith("application/json")
    for bad in ({"ra": 360, "dec": 0}, {"ra": 1, "dec": 95}, {"ra": 1, "dec": 1, "fov_deg": 0}, {"ra": 1, "dec": 1, "fov_deg": "x"}, {"ra": 1, "dec": 1, "fov_deg": 0.6}, {"ra": 1}):
        r = api.get("/api/blink/dynamic", params=bad)
        assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_parameters"
    archive.sia_status = [502] * 10
    r = api.get("/api/blink/dynamic", params={"ra": 151.0, "dec": 41.0})  # a position whose search is not cached yet
    assert r.status_code == 502 and r.json()["error"]["code"] == "upstream_unavailable"


def test_modes_endpoint_and_local_demo_still_present(api, make_client, tmp_path):
    modes = api.get("/api/blink/modes").json()
    assert modes["dynamic_enabled"] is True and isinstance(modes["local_demo_available"], bool)
    assert make_client(blink_fits_files=[tmp_path / "a.fits", tmp_path / "b.fits"]).get("/api/blink/modes").json()["local_demo_available"] is False
    off = make_client(blink_dynamic_enabled=False).get("/api/blink/dynamic", params={"ra": 150, "dec": 40})
    assert off.status_code == 422 and "disabled" in off.json()["error"]["message"]
    assert api.get("/api/blink/cutouts", params={"ra": 150, "dec": 40}).status_code in (200, 404, 503)  # the fixed-file endpoint is untouched


# ===================================================================================== real FITS (skipped when absent)

D3_MAY = Path("~/Downloads/spherex_D3_2025_05_full.fits").expanduser()
D3_DEC = Path("~/Downloads/spherex_D3_2025_12_full.fits").expanduser()
needs_real = pytest.mark.skipif(not (D3_MAY.is_file() and D3_DEC.is_file()), reason="real D3 fixtures not available")


@needs_real
def test_real_d3_calibration_and_cutout_local_conversion():
    with fits.open(D3_MAY, memmap=True) as h:
        cal = calibration_from_hdul(h, expected_detector="D3")
        header, wcs_full = h["IMAGE"].header.copy(), __import__("astropy.wcs", fromlist=["WCS"]).WCS(h["IMAGE"].header)
    assert (cal.x.size, cal.y.size) == (9, 14) and cal.wavelength_um.min() == pytest.approx(1.6162567, abs=1e-6) and cal.wavelength_um.max() == pytest.approx(2.4390657, abs=1e-6)
    assert cal.bandwidth_um.min() == pytest.approx(0.026320294, abs=1e-8) and cal.bandwidth_um.max() == pytest.approx(0.06035265, abs=1e-8)
    assert header["CRPIX1"] == 1020.5  # the convention full_frame_offset derives from the 2040-pixel detector size
    # emulate an IRSA cutout: shift CRPIX by the crop origin and verify the conversion recovers the full-frame wavelength
    x0, y0 = 700, 1100
    cut = header.copy(); cut["CRPIX1"] -= x0; cut["CRPIX2"] -= y0
    from astropy.wcs import WCS
    sky = wcs_full.all_pix2world(850.0, 1250.0, 0)
    xl, yl = (float(v) for v in WCS(cut).all_world2pix(*sky, 0))
    dx, dy = full_frame_offset(cut, 2040, 2040)
    assert (xl + dx, yl + dy) == pytest.approx((850.0, 1250.0), abs=1e-4)
    assert cal.lookup(np.array([xl + dx]), np.array([yl + dy]))[0][0] == pytest.approx(cal.lookup(np.array([850.0]), np.array([1250.0]))[0][0], abs=1e-9)
    assert abs(cal.lookup(np.array([xl]), np.array([yl]))[0][0] - cal.lookup(np.array([850.0]), np.array([1250.0]))[0][0]) > 0.01  # the old bug


@needs_real
def test_real_d3_pair_has_identical_calibration_and_distinct_orientation():
    with fits.open(D3_MAY, memmap=True) as a, fits.open(D3_DEC, memmap=True) as b:
        ca, cb = calibration_from_hdul(a), calibration_from_hdul(b)
    assert ca.fingerprint == cb.fingerprint and ca.version == cb.version  # same calibration for both epochs (the reference finding)


@pytest.mark.parametrize("flag", ["OVERFLOW", "HALO", "OUTLIER"])
def test_suspect_flags_remain_visible_and_counted(archive, stack, flag):
    standard_pair(archive, may_extra=dict(flag_boxes=((flag, (0, 360, 0, 400)),)))
    frame = analyse(stack).frames[0]
    bit = 1 << FLAG_BITS[flag]
    assert not frame.cutout.masks.hard & bit
    assert frame.cutout.masks.suspect & bit
    assert frame.valid.all()
    assert np.isfinite(frame.values).all()
    assert (frame.flags & bit).all()
    assert frame.suspect_fraction == 1.0


@pytest.mark.parametrize("flag", ["NONFUNC", "missing_data", "SUR_ERROR", "HOT", "COLD", "NONLINEAR", "STREAK", "BLOOM", "SNOWBALL", "UNKNOWN_FLAG"])
def test_dynamic_flag_mask_only_excludes_nonfunc_and_missing_data(flag):
    header = fits.Header({"MSKN0003": flag, "MSKN0021": "SOURCE"})
    masks = resolve_flag_masks(header)
    assert masks.hard == ((1 << 3) if flag.upper() in {"NONFUNC", "MISSING_DATA"} else 0)


def test_cached_view_survives_restart_and_irsa_outage(archive, stack, cfg, monkeypatch):
    standard_pair(archive)
    original = analyse(stack)
    downloads = len(archive.downloads)
    from app.services import fits_display
    render = fits_display.render_frames
    renders = []

    def track_render(frames):
        renders.append(True)
        return render(frames)

    monkeypatch.setattr(fits_display, "render_frames", track_render)
    # Prove fallback re-renders FITS, rather than serving a previous PNG/result.
    archive.sia_status = [502] * 10
    restarted = Stack(cfg)
    try:
        recovered = analyse(restarted)
        assert recovered.images == original.images
        assert renders == [True]
        assert recovered.common_good_fraction == original.common_good_fraction
        assert any("cached" in w.lower() and "unavailable" in w.lower() and "UTC" in w for w in recovered.warnings)
        assert len(archive.downloads) == downloads
    finally:
        restarted.irsa.close()


@pytest.mark.parametrize("damage", ["missing_fits", "corrupt_fits", "corrupt_discovery", "other_position", "other_collection", "other_endpoint", "other_fov"])
def test_cached_view_never_substitutes_missing_or_unrelated_data(archive, stack, cfg, damage):
    standard_pair(archive)
    analyse(stack)
    if damage in {"missing_fits", "corrupt_fits"}:
        for path in (cfg.blink_cache_dir / "cutouts").glob("*.fits"):
            if damage == "missing_fits":
                path.unlink()
            else:
                path.write_bytes(b"corrupt")
    elif damage == "corrupt_discovery":
        for path in (cfg.blink_cache_dir / "discovery").glob("*.xml"):
            path.write_bytes(b"corrupt")
    elif damage == "other_collection":
        cfg = cfg.model_copy(update={"irsa_collection": "spherex_qr3"})
    elif damage == "other_endpoint":
        cfg = cfg.model_copy(update={"irsa_sia_url": "https://irsa.ipac.caltech.edu/other-SIA"})
    downloads = len(archive.downloads)
    archive.sia_status = [502] * 20
    restarted = Stack(cfg)
    if damage == "other_endpoint":
        import httpx
        restarted.irsa._injected = httpx.Client(transport=httpx.MockTransport(lambda _r: httpx.Response(502)))
    try:
        with pytest.raises(UpstreamUnavailable):
            restarted.service.analyse(T[0] + (0.01 if damage == "other_position" else 0), T[1], FOV / 2 if damage == "other_fov" else FOV)
        assert len(archive.downloads) == downloads
    finally:
        if restarted.irsa._injected is not None:
            restarted.irsa._injected.close()
        restarted.irsa.close()


def test_live_discovery_is_preferred_after_restart(archive, stack, cfg):
    standard_pair(archive)
    analyse(stack)
    count = len(archive.sia_requests)
    restarted = Stack(cfg)
    try:
        result = analyse(restarted)
        assert len(archive.sia_requests) == count + 1
        assert not any("archive unavailable" in w.lower() for w in result.warnings)
    finally:
        restarted.irsa.close()


def test_cached_view_bootstraps_calibration_from_cached_science_fits(archive, stack, cfg):
    import shutil

    standard_pair(archive)
    analyse(stack)
    shutil.rmtree(cfg.blink_cache_dir / "calibration")
    downloads = len(archive.downloads)
    archive.sia_status = [503] * 10
    restarted = Stack(cfg)
    try:
        result = analyse(restarted)
        assert result.frames and len(archive.downloads) == downloads
        assert any("Cached data" in w for w in result.warnings)
    finally:
        restarted.irsa.close()


def test_cached_view_handles_search_timeout(archive, stack, cfg, monkeypatch):
    standard_pair(archive)
    analyse(stack)
    restarted = Stack(cfg)
    def timeout(*_args):
        raise UpstreamTimeout("IRSA timed out")
    monkeypatch.setattr(restarted.irsa, "_search_uncached", timeout)
    try:
        assert any("Cached data" in w for w in analyse(restarted).warnings)
    finally:
        restarted.irsa.close()


def test_cached_view_does_not_hide_invalid_live_response(archive, stack, cfg, monkeypatch):
    standard_pair(archive)
    analyse(stack)
    restarted = Stack(cfg)
    def invalid(*_args):
        raise UpstreamInvalidResponse("Malformed live response")
    monkeypatch.setattr(restarted.irsa, "_search_uncached", invalid)
    try:
        with pytest.raises(UpstreamInvalidResponse, match="Malformed live response"):
            analyse(restarted)
    finally:
        restarted.irsa.close()


def test_cached_view_survives_memory_cache_expiry(archive, cfg):
    standard_pair(archive)
    cfg = cfg.model_copy(update={"sia_cache_ttl_seconds": 0, "blink_cache_ttl_seconds": 0})
    stack = Stack(cfg)
    try:
        analyse(stack)
        archive.sia_status = [502] * 10
        assert any("Cached data" in w for w in analyse(stack).warnings)
    finally:
        stack.irsa.close()


def test_discovery_persistence_failure_does_not_break_live_search(archive, stack, monkeypatch):
    standard_pair(archive)
    def fail(*_args, **_kwargs):
        raise OSError("Read-only directory")
    monkeypatch.setattr("app.services.discovery_cache.os.replace", fail)
    observations, _ = stack.irsa.search(*T)
    assert len(observations) == 2


def test_requested_wavelength_selects_verified_pair_and_isolates_cache(archive, stack):
    standard_pair(archive, tag="short")
    standard_pair(archive, det=5, tag="long", may_extra={"lam": (4.0, 4.16)}, dec_extra={"lam": (4.0, 4.16)})
    short = stack.service.analyse(*T, FOV, wavelength_um=1.875)
    long = stack.service.analyse(*T, FOV, wavelength_um=4.075)
    assert short is stack.service.analyse(*T, FOV, wavelength_um=1.875)
    assert long is not short
    assert [f.cutout.obs.detector for f in short.frames] == ["D3", "D3"]
    assert [f.cutout.obs.detector for f in long.frames] == ["D5", "D5"]
    for result, requested in ((short, 1.875), (long, 4.075)):
        assert result.requested_wavelength_um == requested
        assert all(abs(f.centre_wavelength_um - requested) <= f.centre_bandwidth_um / 2 for f in result.frames)
    assert stack.service.image(*T, FOV, "2025-05", wavelength_um=4.075) == long.images["2025-05"]


@pytest.mark.parametrize("fov", [0.02, 0.1, 0.5])
def test_requested_wavelength_never_falls_back_to_unrelated_pair(archive, stack, fov):
    standard_pair(archive)
    with pytest.raises(DynamicSelectionError) as caught:
        stack.service.analyse(*T, fov, wavelength_um=4.1)
    assert caught.value.code == "wavelength_mismatch"
    assert "4.1" in caught.value.message
    assert stack.service.analyse(*T, fov).frames  # automatic selection still works


@pytest.mark.parametrize("wave", [0, -1, 0.74, 5.01, math.nan, math.inf])
def test_requested_wavelength_validation_precedes_discovery(stack, wave):
    with pytest.raises(InvalidParameters):
        stack.service.analyse(*T, FOV, wavelength_um=wave)


def test_requested_wavelength_endpoint_preserves_image_identity(api, archive):
    standard_pair(archive)
    standard_pair(archive, det=5, may_extra={"lam": (4.0, 4.16)}, dec_extra={"lam": (4.0, 4.16)})
    params = {"ra": T[0], "dec": T[1], "wavelength_um": 4.075}
    response = api.get("/api/blink/dynamic", params=params)
    assert response.status_code == 200
    body = response.json()
    assert body["requested_wavelength_um"] == 4.075
    for frame in body["frames"]:
        assert frame["detector"] == 5
        assert "wavelength_um=4.075" in frame["image_url"]
        image = api.get(frame["image_url"])
        assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    for wave in ("nan", "inf", "oops", 0.74, 5.01):
        invalid = api.get("/api/blink/dynamic", params={**params, "wavelength_um": wave})
        assert invalid.status_code == 422
        assert invalid.json()["error"]["code"] == "invalid_parameters"


def test_requested_wavelength_is_checked_against_fits_not_prediction(archive, stack, monkeypatch):
    from dataclasses import replace
    from app.services import dynamic_blink

    standard_pair(archive)
    original = dynamic_blink.predict

    def misleading_prediction(*args, **kwargs):
        result = original(*args, **kwargs)
        return replace(result, wavelength_um=1.93) if result is not None else None

    monkeypatch.setattr(dynamic_blink, "predict", misleading_prediction)
    with pytest.raises(DynamicSelectionError) as caught:
        stack.service.analyse(*T, FOV, wavelength_um=1.93)
    assert caught.value.code == "wavelength_mismatch"
    assert "outside the calibrated passband" in caught.value.message


def test_cached_recovery_preserves_requested_wavelength(archive, stack, cfg):
    standard_pair(archive)
    stack.service.analyse(*T, FOV, wavelength_um=1.875)
    archive.sia_status = [502] * 20
    restarted = Stack(cfg)
    try:
        recovered = restarted.service.analyse(*T, FOV, wavelength_um=1.875)
        assert recovered.requested_wavelength_um == 1.875
        assert any("Cached data" in note for note in recovered.warnings)
        with pytest.raises(UpstreamUnavailable, match="requested 4.1"):
            restarted.service.analyse(*T, FOV, wavelength_um=4.1)
    finally:
        restarted.irsa.close()


def test_detector_selection_is_enforced_and_images_are_pinned(api, archive):
    standard_pair(archive, det=3)
    standard_pair(archive, det=5)
    params = {"ra": T[0], "dec": T[1], "detector": 5}
    response = api.get('/api/blink/dynamic', params=params)
    assert response.status_code == 200
    body = response.json()
    assert body['requested_detector'] == 5
    assert {f['detector'] for f in body['frames']} == {5}
    for frame in body['frames']:
        assert 'detector=5' in frame['image_url']
        assert api.get(frame['image_url']).status_code == 200
    missing = api.get('/api/blink/dynamic', params={**params, 'detector': 6})
    assert missing.json()['error']['code'] == 'no_observations'
    for invalid in (0, 7, 'bad', 2.5):
        assert api.get('/api/blink/dynamic', params={**params, 'detector': invalid}).status_code == 422


def test_detector_cache_and_wavelength_constraints_remain_independent(archive, stack):
    standard_pair(archive, det=3)
    standard_pair(archive, det=5)
    a = stack.service.analyse(*T, FOV, detector=3)
    b = stack.service.analyse(*T, FOV, detector=5)
    assert a is not b
    assert a is stack.service.analyse(*T, FOV, detector=3)
    assert {f.cutout.obs.detector for f in a.frames} == {'D3'}
    assert {f.cutout.obs.detector for f in b.frames} == {'D5'}
    with pytest.raises(DynamicSelectionError):
        stack.service.analyse(*T, FOV, detector=5, wavelength_um=4.1)
