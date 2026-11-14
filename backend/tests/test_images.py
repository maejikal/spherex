import io

import httpx
import pytest
from PIL import Image

from app.providers.base import CutoutRequest
from app.providers.sdss import plan_upstream_request
from conftest import SDSS_JPEG, make_jpeg

PARAMS = {"ra": 180, "dec": 0.5, "scale": 0.4, "width": 512, "height": 512, "survey": "sdss-dr18", "grid": 0}


def get(client, **overrides):
    return client.get("/api/images/cutout", params={**PARAMS, **overrides})


def error_code(resp):
    body = resp.json()
    assert set(body) == {"error"} and set(body["error"]) == {"code", "message"}
    return body["error"]["code"]


# ---------------------------------------------------------------- success ----
def test_valid_request_returns_raw_jpeg_with_headers(client, upstream):
    jpeg = make_jpeg(512, 512)
    route = upstream.get(SDSS_JPEG).respond(200, content=jpeg, headers={"content-type": "image/jpeg"})
    resp = get(client)
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/jpeg"
    assert resp.content[:3] == b"\xff\xd8\xff" and resp.content == jpeg
    assert resp.headers["x-survey-release"] == "DR18"
    assert resp.headers["x-coordinate-frame"] == "J2000"
    assert resp.headers["x-source-url"].startswith("https://skyserver.sdss.org/")
    # Unknown provenance must be absent rather than invented.
    for name in ("x-observation-time", "x-wavelength", "x-projection"):
        assert name not in resp.headers
    q = route.calls.last.request.url.params
    assert (q["ra"], q["dec"], q["width"], q["height"]) == ("180.00000000", "0.50000000", "512", "512")
    assert "opt" not in q


def test_grid_is_forwarded_only_when_requested(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    get(client, grid=1)
    assert route.calls.last.request.url.params["opt"] == "G"
    get(client, grid=0, ra=181)
    assert "opt" not in route.calls.last.request.url.params


def test_cors_exposes_metadata_headers(client, upstream):
    upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    resp = client.get("/api/images/cutout", params=PARAMS, headers={"Origin": "http://localhost:5173"})
    assert resp.headers["access-control-allow-origin"] == "http://localhost:5173"
    assert "X-Survey-Release" in resp.headers["access-control-expose-headers"]
    other = client.get("/api/images/cutout", params=PARAMS, headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_defaults_match_frontend_optional_params(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    resp = client.get("/api/images/cutout", params={"ra": 10, "dec": 10})
    assert resp.status_code == 200
    assert route.calls.last.request.url.params["scale"] == "0.400000"


# ------------------------------------------------------------- validation ----
@pytest.mark.parametrize(
    "overrides",
    [
        {"ra": -0.1}, {"ra": 360}, {"ra": "nan"}, {"ra": "inf"}, {"ra": "abc"},
        {"dec": 90.5}, {"dec": -91}, {"dec": "nan"},
        {"scale": 0.04}, {"scale": 121}, {"scale": 0}, {"scale": "inf"},
        {"width": 0}, {"width": 1537}, {"height": 0}, {"height": 1537}, {"width": "x"},
        {"grid": 2}, {"grid": -1},
    ],
)
def test_invalid_parameters_are_rejected_before_any_upstream_call(client, upstream, overrides):
    resp = get(client, **overrides)
    assert resp.status_code == 422
    assert error_code(resp) == "invalid_parameters"
    assert upstream.calls.call_count == 0


def test_missing_required_ra_dec(client, upstream):
    assert error_code(client.get("/api/images/cutout")) == "invalid_parameters"


def test_unsupported_survey(client, upstream):
    resp = get(client, survey="spherex")
    assert resp.status_code == 400 and error_code(resp) == "unsupported_survey"
    assert upstream.calls.call_count == 0


def test_field_of_view_too_large_for_sdss(client, upstream):
    resp = get(client, scale=120, width=1536, height=1536)
    assert resp.status_code == 422 and error_code(resp) == "invalid_parameters"
    assert upstream.calls.call_count == 0


# ------------------------------------------------- upstream limits adaptation ---
def test_plan_respects_sdss_limits():
    p = plan_upstream_request(CutoutRequest(ra=1, dec=1, scale=0.4, width=512, height=512))
    assert (p.scale, p.width, p.height) == (0.4, 512, 512) and not p.needs_reshape(CutoutRequest(1, 1, 0.4, 512, 512))
    big = CutoutRequest(1, 1, 100.0, 500, 400)
    p = plan_upstream_request(big)
    assert p.scale == 60.0 and (p.width, p.height) == (834, 667) and p.needs_reshape(big)
    tiny = CutoutRequest(1, 1, 1.0, 20, 30)
    p = plan_upstream_request(tiny)
    assert (p.scale, p.width, p.height) == (1.0, 64, 64) and p.needs_reshape(tiny)


def test_small_image_is_cropped_to_requested_size(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(64, 64), headers={"content-type": "image/jpeg"})
    resp = get(client, width=20, height=30)
    assert resp.status_code == 200
    assert Image.open(io.BytesIO(resp.content)).size == (20, 30)
    assert resp.headers["x-image-resampled"] == "1"
    assert route.calls.last.request.url.params["width"] == "64"


def test_large_scale_requests_stay_within_upstream_scale_limit(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(834, 667), headers={"content-type": "image/jpeg"})
    resp = get(client, scale=100, width=500, height=400)
    assert Image.open(io.BytesIO(resp.content)).size == (500, 400)
    assert float(route.calls.last.request.url.params["scale"]) == 60.0


# ------------------------------------------------------- upstream failures ----
def test_no_coverage_when_sdss_reports_outside_footprint(client, upstream):
    upstream.get(SDSS_JPEG).respond(404, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    resp = get(client, ra=50, dec=-60)
    assert resp.status_code == 404 and error_code(resp) == "no_coverage"
    assert "application/json" in resp.headers["content-type"]


def test_dark_image_is_not_treated_as_missing_coverage(client, upstream):
    black = make_jpeg(512, 512, color=(0, 0, 0))
    upstream.get(SDSS_JPEG).respond(200, content=black, headers={"content-type": "image/jpeg"})
    resp = get(client)
    assert resp.status_code == 200 and resp.content == black


def test_404_with_json_body_is_not_coverage(client, upstream):
    upstream.get(SDSS_JPEG).respond(404, json={"ErrorCode": 404})
    resp = get(client)
    assert resp.status_code == 502 and error_code(resp) == "upstream_invalid_response"


def test_upstream_400_is_reported_as_invalid_response(client, upstream):
    upstream.get(SDSS_JPEG).respond(400, json={"ErrorCode": 400})
    assert error_code(get(client)) == "upstream_invalid_response"


def test_timeout(client, upstream):
    upstream.get(SDSS_JPEG).mock(side_effect=httpx.ReadTimeout("slow"))
    resp = get(client)
    assert resp.status_code == 504 and error_code(resp) == "upstream_timeout"


def test_connection_failure_is_retried_then_reported(client, upstream):
    route = upstream.get(SDSS_JPEG).mock(side_effect=httpx.ConnectError("refused"))
    resp = get(client)
    assert resp.status_code == 502 and error_code(resp) == "upstream_unavailable"
    assert route.call_count == 3  # 1 + max_retries(2)


def test_transient_5xx_is_retried_and_recovers(client, upstream):
    jpeg = make_jpeg(512, 512)
    route = upstream.get(SDSS_JPEG).mock(
        side_effect=[httpx.Response(503), httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg"})]
    )
    resp = get(client)
    assert resp.status_code == 200 and route.call_count == 2


def test_persistent_5xx(client, upstream):
    upstream.get(SDSS_JPEG).respond(503)
    resp = get(client)
    assert resp.status_code == 502 and error_code(resp) == "upstream_unavailable"


def test_500_is_not_retried(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(500, content=b"boom")
    assert error_code(get(client)) == "upstream_invalid_response"
    assert route.call_count == 1


def test_html_instead_of_jpeg(client, upstream):
    upstream.get(SDSS_JPEG).respond(200, content=b"<html>Error</html>", headers={"content-type": "text/html"})
    resp = get(client)
    assert resp.status_code == 502 and error_code(resp) == "upstream_invalid_response"


def test_html_with_jpeg_content_type_fails_magic_check(client, upstream):
    upstream.get(SDSS_JPEG).respond(200, content=b"<html>Error</html>", headers={"content-type": "image/jpeg"})
    assert error_code(get(client)) == "upstream_invalid_response"


def test_corrupt_jpeg(client, upstream):
    corrupt = make_jpeg(512, 512)[:120]
    upstream.get(SDSS_JPEG).respond(200, content=corrupt, headers={"content-type": "image/jpeg"})
    assert error_code(get(client)) == "upstream_invalid_response"


def test_empty_response(client, upstream):
    upstream.get(SDSS_JPEG).respond(200, content=b"", headers={"content-type": "image/jpeg"})
    assert error_code(get(client)) == "upstream_invalid_response"


def test_oversized_response_is_rejected(make_client, upstream):
    c = make_client(max_upstream_image_bytes=1000)
    upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512, color=(1, 2, 3)) + b"\0" * 5000, headers={"content-type": "image/jpeg"})
    assert error_code(get(c)) == "upstream_invalid_response"


def test_failures_are_not_cached(client, upstream):
    jpeg = make_jpeg(512, 512)
    route = upstream.get(SDSS_JPEG).mock(
        side_effect=[httpx.Response(500)] + [httpx.Response(200, content=jpeg, headers={"content-type": "image/jpeg"})]
    )
    assert get(client).status_code == 502
    assert get(client).status_code == 200
    assert route.call_count == 2
