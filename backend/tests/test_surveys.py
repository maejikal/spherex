import httpx
import pytest

from app.providers.spherex import build_survey_info, parse_blank_frames, parse_properties
from app.models.errors import UpstreamInvalidResponse
from conftest import PROPERTIES, PROPERTIES_URL


def test_surveys_lists_only_spherex_with_the_real_channel_table(client, upstream):
    upstream.get(PROPERTIES_URL).respond(200, text=PROPERTIES)
    resp = client.get("/api/surveys")
    assert resp.status_code == 200
    surveys = resp.json()["surveys"]
    assert [s["id"] for s in surveys] == ["spherex"]
    s = surveys[0]
    assert (s["release"], s["available"], s["tile_format"], s["max_order"], s["tile_width"]) == ("DR1", True, "png", 5, 512)
    assert s["hips_url"].endswith("/spherex_allsky_cube") and s["sky_fraction"] == 1.0
    assert s["observation_window_mjd"] == [60789.75076, 61174.49276]
    assert len(s["channels"]) == 102
    by_frame = {c["frame"]: c for c in s["channels"]}
    assert by_frame[0]["wavelength_um"] == 0.753 and by_frame[101]["wavelength_um"] == 4.988
    assert (by_frame[17]["band"], by_frame[17]["band_channel"]) == (2, 1)
    assert [f for f, c in by_frame.items() if not c["has_data"]] == [50, 51]
    assert "sdss" not in resp.text.lower()


def test_surveys_is_cached(client, upstream):
    route = upstream.get(PROPERTIES_URL).respond(200, text=PROPERTIES)
    client.get("/api/surveys"); client.get("/api/surveys")
    assert route.call_count == 1


def test_surveys_fails_loudly_when_irsa_is_unreachable(client, upstream):
    upstream.get(PROPERTIES_URL).mock(side_effect=httpx.ConnectError("down"))
    resp = client.get("/api/surveys")
    assert resp.status_code == 502 and resp.json()["error"]["code"] == "upstream_unavailable"


def test_surveys_timeout(client, upstream):
    upstream.get(PROPERTIES_URL).mock(side_effect=httpx.ReadTimeout("slow"))
    resp = client.get("/api/surveys")
    assert resp.status_code == 504 and resp.json()["error"]["code"] == "upstream_timeout"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t.replace("creator_did          = ivo://IPAC/P/SPHEREx/DR1/cube", "creator_did = ivo://x/y").replace("obs_collection       = SPHEREx DR1", "obs_collection = DSS"),
        lambda t: t.replace("dataproduct_type     = cube", "dataproduct_type = image"),
        lambda t: t.replace("hips_frame           = equatorial", "hips_frame = galactic"),
        lambda t: t.replace("hips_cube_depth      = 102", "hips_cube_depth = 50"),
        lambda t: t.replace("data_cube_bunit3     = um", "data_cube_bunit3 = nm"),
        lambda t: t.replace("hips_tile_width      = 512", ""),
        lambda t: "<html>maintenance</html>",
    ],
)
def test_invalid_hips_metadata_is_rejected(client, upstream, mutate):
    upstream.get(PROPERTIES_URL).respond(200, text=mutate(PROPERTIES))
    resp = client.get("/api/surveys")
    assert resp.status_code == 502 and resp.json()["error"]["code"] == "upstream_invalid_response"


def test_http_error_from_irsa(client, upstream):
    upstream.get(PROPERTIES_URL).respond(404)
    assert client.get("/api/surveys").json()["error"]["code"] == "upstream_invalid_response"


def test_properties_parser_and_blank_frame_sentence():
    props = parse_properties("# c\nkey = a = b\n\nx=1")
    assert props == {"key": "a = b", "x": "1"}
    assert parse_blank_frames("Frames 50 and 51 (x) are blank.", 102) == [50, 51]
    assert parse_blank_frames("Frames 3, 4 and 200 are blank", 102) == [3, 4]
    assert parse_blank_frames("no blanks mentioned", 102) == []


def test_build_survey_info_marks_blank_channels():
    info = build_survey_info(parse_properties(PROPERTIES), "https://x")
    assert sum(c.has_data for c in info.channels) == 100
    with pytest.raises(UpstreamInvalidResponse):
        build_survey_info({**parse_properties(PROPERTIES), "data_cube_crval3_arr": "1 2 3"}, "https://x")
