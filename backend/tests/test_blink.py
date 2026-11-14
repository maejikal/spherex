"""Blink viewer: WCS alignment, coverage, display processing and the HTTP API, on synthetic FITS files.

The synthetic exposures place stars with astropy's forward WCS (incl. SIP) and are rotated 180° / shifted
relative to each other, like the real May and December files. The real 65 MB files are never needed.
"""

from __future__ import annotations

import io
import math

import numpy as np
import pytest
from astropy.wcs import WCS
from PIL import Image

import app.services.blink_service as blink_service
from app.services.fits_cutout import CutoutSet, build_output_wcs, ResampledFrame, extract_cutouts, inspect_fits, resample_to_grid
from app.services.fits_display import (
    compute_display_parameters,
    render_png,
    stretch_to_uint8,
)
from fits_factory import PIXEL_SCALE_ARCSEC, make_exposure, make_wcs, offset_sky

CENTRE = (150.0, 40.0)
SIZE = 64  # cutout edge used by most tests (6.5 arcmin)
HALF = (SIZE - 1) / 2


def expected_pixel(east_arcsec: float, north_arcsec: float) -> tuple[float, float]:
    """Where an offset from the field centre must land in the output grid: east is left, north is up."""
    return HALF - east_arcsec / PIXEL_SCALE_ARCSEC, HALF + north_arcsec / PIXEL_SCALE_ARCSEC


def centroid(values: np.ndarray, near: tuple[float, float], radius: int = 5) -> tuple[float, float]:
    x0, y0 = int(round(near[0])), int(round(near[1]))
    window = np.nan_to_num(values[y0 - radius : y0 + radius + 1, x0 - radius : x0 + radius + 1])
    window = np.clip(window - np.nanmedian(values), 0, None)
    yy, xx = np.mgrid[y0 - radius : y0 + radius + 1, x0 - radius : x0 + radius + 1]
    total = window.sum()
    return float((window * xx).sum() / total), float((window * yy).sum() / total)


STATIONARY = ((120.0, 80.0), (-90.0, -150.0))  # (east, north) arcsec from CENTRE


def sources_at(*offsets: tuple[float, float], amplitude: float = 5.0):
    return tuple((*offset_sky(CENTRE, e, n), amplitude) for e, n in offsets)


@pytest.fixture
def pair(tmp_path):
    """May: unrotated. December: rotated 180°, pointed 40″ east. Two stationary stars in both."""
    a, b = tmp_path / "may.fits", tmp_path / "dec.fits"
    stars = sources_at(*STATIONARY)
    make_exposure(a, centre=CENTRE, sources=stars, background=0.146, date_obs="2025-05-24T21:54:42.018", mjd=60819.9, obsid="OBS_MAY")
    make_exposure(
        b, centre=offset_sky(CENTRE, 40, 0), roll_deg=180.0, sources=stars, background=0.191,
        date_obs="2025-12-08T00:26:28.874", mjd=61017.0, obsid="OBS_DEC",
    )
    return a, b


@pytest.fixture
def blink_client(make_client, pair):
    return make_client(blink_fits_files=list(pair))


def cutouts_for(paths, ra=CENTRE[0], dec=CENTRE[1], size=SIZE) -> CutoutSet:
    return extract_cutouts([inspect_fits(p) for p in sorted(paths, key=lambda p: p.name)], ra, dec, size, PIXEL_SCALE_ARCSEC)


# ------------------------------------------------------------------------------------- alignment


def test_stationary_stars_land_on_the_same_pixels_and_at_the_true_position(pair):
    may, dec = (f.values for f in cutouts_for(pair).frames)  # dec.fits sorts before may.fits; order irrelevant here
    for offset in STATIONARY:
        truth = expected_pixel(*offset)
        for values in (may, dec):
            x, y = centroid(values, truth)
            assert (x, y) == pytest.approx(truth, abs=0.3)


def test_raw_arrays_are_flipped_but_resampled_arrays_agree(pair, tmp_path):
    """Guards the central claim: blinking raw pixels would be wrong, the resampled grid is right."""
    from astropy.io import fits

    raw = {p.name: np.nan_to_num(fits.getdata(p, extname="IMAGE")) for p in pair}
    raw_may, raw_dec = raw["may.fits"], raw["dec.fits"]
    brightest = lambda a: np.unravel_index(np.argmax(a), a.shape)  # noqa: E731
    # In raw pixel space the same star sits far apart (the exposures are rotated 180°).
    assert math.dist(brightest(raw_may), brightest(raw_dec)) > 20

    frames = cutouts_for(pair).frames
    by_name = {f.info.path.name: f.values for f in frames}
    for offset in STATIONARY:
        truth = expected_pixel(*offset)
        a, b = centroid(by_name["may.fits"], truth), centroid(by_name["dec.fits"], truth)
        assert math.dist(a, b) < 0.3


def test_moving_source_stays_displaced_after_alignment(tmp_path):
    a, b = tmp_path / "a.fits", tmp_path / "b.fits"
    stars = sources_at((120.0, 80.0))
    mover_a, mover_b = (30.0, -40.0), (30.0 + 12 * PIXEL_SCALE_ARCSEC, -40.0 + 5 * PIXEL_SCALE_ARCSEC)
    make_exposure(a, centre=CENTRE, sources=stars + sources_at(mover_a), date_obs="2025-05-24T00:00:00", mjd=60819.0)
    make_exposure(b, centre=offset_sky(CENTRE, 40, 0), roll_deg=180.0, sources=stars + sources_at(mover_b), date_obs="2025-12-08T00:00:00", mjd=61017.0)
    first, second = cutouts_for([a, b]).frames
    pa, pb = expected_pixel(*mover_a), expected_pixel(*mover_b)
    ca, cb = centroid(first.values, pa), centroid(second.values, pb)
    assert ca == pytest.approx(pa, abs=0.3) and cb == pytest.approx(pb, abs=0.3)
    # East is left, north is up: moving 12 px east and 5 px north is -12 px in x and +5 px in y.
    assert (cb[0] - ca[0], cb[1] - ca[1]) == pytest.approx((-12.0, 5.0), abs=0.4)
    # And it is genuinely absent where it used to be in the second frame.
    assert second.values[round(pa[1]), round(pa[0])] < 0.5 * first.values[round(pa[1]), round(pa[0])]


def test_sip_distortion_is_honoured(tmp_path):
    """Full SIP-aware transforms: ignoring the distortion terms would shift this star by several pixels."""
    a, b = tmp_path / "a.fits", tmp_path / "b.fits"
    far = (-150.0, 150.0)  # away from the field centre, where SIP matters most
    stars = sources_at(far, (60.0, -120.0))
    make_exposure(a, centre=CENTRE, sip=True, sources=stars, date_obs="2025-05-24T00:00:00", mjd=60819.0)
    make_exposure(b, centre=CENTRE, sip=False, roll_deg=180.0, sources=stars, date_obs="2025-12-08T00:00:00", mjd=61017.0)

    sip_wcs = WCS(inspect_fits(a).header)
    plain = make_wcs(CENTRE, 200)  # the same TAN solution with the distortion terms dropped
    ra, dec = offset_sky(CENTRE, *far)
    ignored_shift = math.dist(sip_wcs.all_world2pix(ra, dec, 0), plain.all_world2pix(ra, dec, 0))
    assert ignored_shift > 2.0  # the test is only meaningful if SIP matters

    frames = cutouts_for([a, b], size=96).frames  # a sorts first
    half = (96 - 1) / 2
    truth = (half - far[0] / PIXEL_SCALE_ARCSEC, half + far[1] / PIXEL_SCALE_ARCSEC)
    for frame in frames:
        assert centroid(frame.values, truth) == pytest.approx(truth, abs=0.35)


def test_output_grid_is_north_up_east_left():
    wcs = build_output_wcs(*CENTRE, SIZE, PIXEL_SCALE_ARCSEC)
    east_x, east_y = wcs.all_world2pix(*offset_sky(CENTRE, 150.0, 0.0), 0)
    north_x, north_y = wcs.all_world2pix(*offset_sky(CENTRE, 0.0, 150.0), 0)
    assert east_x < HALF - 20 and east_y == pytest.approx(HALF, abs=0.2)  # east is to the left
    assert north_y > HALF + 20 and north_x == pytest.approx(HALF, abs=0.2)  # north is toward higher rows
    assert (east_x, north_y) == pytest.approx((HALF - 150 / PIXEL_SCALE_ARCSEC, HALF + 150 / PIXEL_SCALE_ARCSEC), abs=0.05)


# ------------------------------------------------------------------------------------- resampling


def test_resample_ignores_invalid_pixels_without_leaking_them():
    data = np.full((20, 20), 2.0, dtype=np.float32)
    valid = np.ones((20, 20), dtype=bool)
    data[10, 10], valid[10, 10] = np.nan, False
    rows, cols = np.array([[10.0, 5.5, -3.0]]), np.array([[10.0, 5.5, 8.0]])
    out, ok = resample_to_grid(data, valid, rows, cols)
    assert not ok[0, 0] and not ok[0, 2]  # on the bad pixel, and outside the image
    assert ok[0, 1] and out[0, 1] == pytest.approx(2.0)
    assert np.isnan(out[0, 0])


def test_nan_pixels_are_invalid_in_output_and_transparent_in_png(tmp_path, make_client):
    a, b = tmp_path / "a.fits", tmp_path / "b.fits"
    wcs = make_wcs(CENTRE, 200)
    px, py = wcs.all_world2pix(*CENTRE, 0)
    box = (int(py) - 4, int(py) + 5, int(px) - 4, int(px) + 5)
    make_exposure(a, centre=CENTRE, nan_box=box, date_obs="2025-05-24T00:00:00", mjd=60819.0)
    make_exposure(b, centre=CENTRE, roll_deg=180.0, date_obs="2025-12-08T00:00:00", mjd=61017.0)
    first, second = cutouts_for([a, b]).frames
    assert not first.valid[int(HALF) : int(HALF) + 2, int(HALF) : int(HALF) + 2].any()
    assert np.isnan(first.values[~first.valid]).all()
    assert first.valid[2, 2] and 0.95 < first.coverage_fraction < 1.0
    assert second.valid.all() and second.coverage_fraction == 1.0

    client = make_client(blink_fits_files=[a, b])
    body = client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE}).json()
    png = Image.open(io.BytesIO(client.get(body["frames"][0]["image_url"]).content))
    assert png.getpixel((SIZE // 2, SIZE // 2))[1] == 0  # alpha: transparent hole, not black sky
    assert png.getpixel((2, 2))[1] == 255


def test_quality_flags_mask_by_name_and_keep_source_pixels(tmp_path):
    a, b = tmp_path / "a.fits", tmp_path / "b.fits"
    wcs = make_wcs(CENTRE, 200)
    px, py = (int(v) for v in wcs.all_world2pix(*CENTRE, 0))
    star = sources_at((0.0, 0.0))
    # SOURCE flag covers the star (must stay valid); NONFUNC covers a patch to its right (must be masked).
    make_exposure(
        a, centre=CENTRE, sources=star, date_obs="2025-05-24T00:00:00", mjd=60819.0,
        flag_boxes=(("SOURCE", (py - 6, py + 7, px - 6, px + 7)), ("NONFUNC", (py - 3, py + 4, px + 12, px + 20))),
    )
    make_exposure(b, centre=CENTRE, roll_deg=180.0, date_obs="2025-12-08T00:00:00", mjd=61017.0)
    info = inspect_fits(a)
    assert info.bad_flag_mask == (1 << 6) | (1 << 27) and not info.bad_flag_mask & (1 << 21)
    frame = cutouts_for([a, b]).frames[0]
    assert frame.valid[round(HALF), round(HALF)]  # SOURCE-flagged star kept
    # Frame A is unrotated, so output x = HALF + (pixel offset): the NONFUNC patch (+12..+19 px) is at x ~ 44-51.
    assert not frame.valid[32, 47]  # NONFUNC patch masked
    assert frame.valid[32, 40]  # unflagged sky between the star and the patch stays valid


def test_file_without_flags_only_masks_non_finite(tmp_path):
    p = tmp_path / "noflags.fits"
    make_exposure(p, include_flags=False)
    assert inspect_fits(p).bad_flag_mask == 0


# ------------------------------------------------------------------------------------- coverage


def test_wavelength_statistics_come_from_the_wcs_wave_table(tmp_path):
    a, b = tmp_path / "a.fits", tmp_path / "b.fits"
    make_exposure(a, centre=CENTRE, wave_by_row=(4.4, 3.8), date_obs="2025-05-24T00:00:00", mjd=60819.0)
    make_exposure(b, centre=CENTRE, roll_deg=180.0, wave_by_row=(4.4, 3.8), date_obs="2025-12-08T00:00:00", mjd=61017.0)
    first, second = cutouts_for([a, b]).frames
    for frame in (first, second):
        low, high, mean = frame.wavelength_um
        assert 3.8 <= low <= mean <= high <= 4.4
    # Rows of image A run with wavelength; the 180° rotation means the same sky position was observed
    # through a different part of the filter in B, so a field away from the centre differs between frames.
    far = cutouts_for([a, b], *offset_sky(CENTRE, 0, 450.0), size=SIZE).frames
    assert abs(far[0].wavelength_um[2] - far[1].wavelength_um[2]) > 0.05


def test_partial_coverage_returns_frames_with_a_warning(blink_client):
    ra, dec = offset_sky(CENTRE, 560.0, 0.0)
    response = blink_client.get("/api/blink/cutouts", params={"ra": ra, "dec": dec, "size": SIZE})
    assert response.status_code == 200
    body = response.json()
    assert all(0.3 < f["coverage_fraction"] < 0.95 for f in body["frames"])
    assert any(w.startswith("Partial coverage") for w in body["warnings"])
    assert body["common_coverage_fraction"] <= min(f["coverage_fraction"] for f in body["frames"]) + 1e-6


def test_no_coverage_is_a_structured_error(blink_client):
    response = blink_client.get("/api/blink/cutouts", params={"ra": 10.0, "dec": -20.0})
    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "no_fits_coverage"
    assert error["message"].startswith("No usable SPHEREx observations are available for this selected region.")
    assert "RA 150" in error["message"]  # tells the user where the data are, from the headers


def test_one_frame_covering_is_not_enough(tmp_path, make_client):
    a, b = tmp_path / "a.fits", tmp_path / "b.fits"
    make_exposure(a, centre=CENTRE, date_obs="2025-05-24T00:00:00", mjd=60819.0)
    make_exposure(b, centre=offset_sky(CENTRE, 3 * 3600.0, 0), date_obs="2025-12-08T00:00:00", mjd=61017.0)
    client = make_client(blink_fits_files=[a, b])
    response = client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1]})
    assert response.status_code == 404 and response.json()["error"]["code"] == "no_fits_coverage"


# ------------------------------------------------------------------------------------- display


def frame_of(values: np.ndarray, valid: np.ndarray | None = None) -> ResampledFrame:
    valid = np.isfinite(values) if valid is None else valid
    return ResampledFrame(info=None, values=values.astype(np.float32), valid=valid, coverage_fraction=float(valid.mean()), wavelength_um=None)  # type: ignore[arg-type]


def test_constant_image_renders_without_dividing_by_zero():
    flat = frame_of(np.full((32, 32), 0.2))
    params = compute_display_parameters((flat, flat))
    assert params.high > params.low and np.isfinite(params.low) and np.isfinite(params.high)
    gray = stretch_to_uint8(flat.values, flat.valid, params.background[0], params)
    assert gray.min() == gray.max()  # uniform, no NaN-driven garbage
    assert Image.open(io.BytesIO(render_png(gray, flat.valid))).size == (32, 32)


def test_all_invalid_frame_renders_as_empty_not_a_crash():
    nothing = frame_of(np.full((16, 16), np.nan))
    params = compute_display_parameters((nothing,))
    gray = stretch_to_uint8(nothing.values, nothing.valid, params.background[0], params)
    assert not gray.any()


def test_extreme_outliers_do_not_dominate_the_stretch():
    rng = np.random.default_rng(1)
    values = 0.15 + rng.normal(0, 0.01, (64, 64))
    values[10, 10] = 1.0e6  # one wild pixel
    values[40:48, 40:48] += 0.5  # a genuine extended source (~1.5 % of the pixels)
    params = compute_display_parameters((frame_of(values),))
    assert params.high < 1.0  # percentile clip: not dragged toward 1e6
    gray = stretch_to_uint8(frame_of(values).values, np.ones((64, 64), bool), params.background[0], params)
    assert gray[44, 44] > 200 and gray[10, 10] == 255  # the star is clearly bright; the outlier merely saturates
    assert np.median(gray) < 100


def test_common_stretch_matches_backgrounds_but_keeps_real_brightness_changes():
    rng = np.random.default_rng(2)
    noise = rng.normal(0, 0.005, (64, 64))
    may = 0.146 + noise
    dec = 0.191 + rng.normal(0, 0.005, (64, 64))  # a brighter sky background
    may[28:36, 28:36] += 1.0
    dec[28:36, 28:36] += 3.0  # the source really brightened
    frames = (frame_of(may), frame_of(dec))
    params = compute_display_parameters(frames)
    gray = [stretch_to_uint8(f.values, f.valid, bg, params) for f, bg in zip(frames, params.background)]
    assert abs(float(np.median(gray[0][:20])) - float(np.median(gray[1][:20]))) <= 2  # sky level matched
    assert gray[1][31, 31] > gray[0][31, 31] + 20  # brightness change survives (no per-image rescale)
    assert params.background[1] - params.background[0] == pytest.approx(0.045, abs=0.003)


# ------------------------------------------------------------------------------------- API


def test_response_structure_and_png_endpoints(blink_client):
    response = blink_client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE})
    assert response.status_code == 200
    body = response.json()
    assert body["coordinates"] == {"ra": CENTRE[0], "dec": CENTRE[1]}
    assert body["image_size"] == SIZE and body["pixel_scale_arcsec"] == PIXEL_SCALE_ARCSEC
    assert body["field_of_view_arcmin"] == pytest.approx(SIZE * PIXEL_SCALE_ARCSEC / 60, abs=0.001)
    assert [f["id"] for f in body["frames"]] == ["2025-05", "2025-12"]  # ordered by observation time
    may, dec = body["frames"]
    assert (may["date"], may["obsid"], may["detector"], may["unit"]) == ("2025-05-24", "OBS_MAY", 5, "MJy / sr")
    assert dec["date"] == "2025-12-08" and may["label"] == "May 2025"
    assert may["background_mjy_sr"] == pytest.approx(0.146, abs=0.002) and dec["background_mjy_sr"] == pytest.approx(0.191, abs=0.002)
    assert body["display"]["stretch_high_mjy_sr"] > body["display"]["stretch_low_mjy_sr"]
    assert body["warnings"] == [] and body["common_coverage_fraction"] == pytest.approx(1.0, abs=0.02)

    sizes = set()
    for frame in body["frames"]:
        image = blink_client.get(frame["image_url"])
        assert image.status_code == 200 and image.headers["content-type"] == "image/png"
        assert "max-age" in image.headers["cache-control"]
        decoded = Image.open(io.BytesIO(image.content))
        decoded.load()
        sizes.add(decoded.size)
        assert decoded.mode == "LA"
    assert sizes == {(SIZE, SIZE)}  # identical dimensions: same grid, same registration


def test_png_is_north_up_and_east_left(blink_client):
    body = blink_client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE}).json()
    image = np.asarray(Image.open(io.BytesIO(blink_client.get(body["frames"][0]["image_url"]).content)))[..., 0]
    # Star (east=120", north=80") must be in the LEFT half and the UPPER half of the PNG.
    star_x, star_y = expected_pixel(*STATIONARY[0])
    top_row = SIZE - 1 - round(star_y)
    assert abs(image[top_row, round(star_x)].astype(int) - int(image.max())) < 40
    assert star_x < HALF and top_row < HALF


@pytest.mark.parametrize("params", [
    {"ra": 360, "dec": 0}, {"ra": -1, "dec": 0}, {"ra": 10, "dec": 91}, {"ra": "nan", "dec": 0}, {"ra": 10, "dec": "inf"},
    {"ra": 150, "dec": 40, "size": 8}, {"ra": 150, "dec": 40, "size": 100000}, {"ra": 150, "dec": 40, "size": "big"}, {"dec": 40},
])
def test_invalid_requests_are_rejected(blink_client, params):
    response = blink_client.get("/api/blink/cutouts", params=params)
    assert response.status_code == 422 and response.json()["error"]["code"] == "invalid_parameters"


def test_unknown_or_malicious_frame_ids_are_rejected(blink_client):
    for frame_id in ("1999-01", "..%2F..%2Fetc%2Fpasswd", "2025-5"):
        response = blink_client.get(f"/api/blink/images/{frame_id}.png", params={"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE})
        assert response.status_code in (404, 422)
        assert response.headers["content-type"].startswith("application/json")


def test_missing_fits_file_is_a_clear_503(make_client, tmp_path, pair):
    client = make_client(blink_fits_files=[pair[0], tmp_path / "gone.fits"])
    response = client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1]})
    assert response.status_code == 503
    error = response.json()["error"]
    assert error["code"] == "fits_unavailable" and "gone.fits" in error["message"]
    assert str(tmp_path) not in error["message"]  # no filesystem paths leak to the browser


def test_unusable_files_are_rejected_clearly(make_client, tmp_path, pair):
    junk = tmp_path / "junk.fits"
    junk.write_text("not a fits file")
    wrong_unit = tmp_path / "unit.fits"
    make_exposure(wrong_unit, bunit="DN", date_obs="2025-06-01T00:00:00", mjd=60830.0)
    for bad in (junk, wrong_unit):
        client = make_client(blink_fits_files=[pair[0], bad])
        response = client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1]})
        assert response.status_code == 503 and response.json()["error"]["code"] == "fits_unavailable"
    assert "MJy" in client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1]}).json()["error"]["message"]


def test_api_never_accepts_a_filesystem_path(blink_client, pair):
    response = blink_client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE, "path": "/etc/passwd", "file": str(pair[0])})
    assert response.status_code == 200  # unknown parameters are ignored, never used


def test_repeated_requests_share_one_computation(blink_client, monkeypatch):
    calls = []
    original = blink_service.extract_cutouts

    def counting(*args, **kwargs):
        calls.append(args[1:4])
        return original(*args, **kwargs)

    monkeypatch.setattr(blink_service, "extract_cutouts", counting)
    params = {"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE}
    body = blink_client.get("/api/blink/cutouts", params=params).json()
    blink_client.get("/api/blink/cutouts", params=params)
    for frame in body["frames"]:
        assert blink_client.get(frame["image_url"]).status_code == 200
    assert len(calls) == 1
    blink_client.get("/api/blink/cutouts", params={**params, "dec": CENTRE[1] + 0.001})
    assert len(calls) == 2  # a different position is a different computation


def test_cache_is_bounded(make_client, pair):
    client = make_client(blink_fits_files=list(pair), blink_cache_entries=2)
    for i in range(5):
        assert client.get("/api/blink/cutouts", params={"ra": CENTRE[0], "dec": CENTRE[1] + i * 0.002, "size": SIZE}).status_code == 200
    service = client.app.state.services.blink
    assert len(service._results) <= 2


def test_replaced_file_is_reloaded(make_client, pair):
    client = make_client(blink_fits_files=list(pair))
    params = {"ra": CENTRE[0], "dec": CENTRE[1], "size": SIZE}
    first = client.get("/api/blink/cutouts", params=params).json()["frames"][0]["background_mjy_sr"]
    make_exposure(pair[0], centre=CENTRE, sources=sources_at(*STATIONARY), background=0.5, date_obs="2025-05-24T21:54:42.018", mjd=60819.9, obsid="OBS_MAY", sigma_px=2.5)
    second = client.get("/api/blink/cutouts", params=params).json()["frames"][0]["background_mjy_sr"]
    assert first == pytest.approx(0.146, abs=0.002) and second == pytest.approx(0.5, abs=0.002)
