import httpx
import pytest

from app.utils.coordinates import angular_separation_arcsec, normalize_ra
from conftest import SDSS_SQL, SESAME, SESAME_NOT_FOUND, sesame_xml, sql_payload


def err(resp):
    body = resp.json()
    assert set(body) == {"error"}
    return body["error"]["code"]


# ------------------------------------------------------------------ resolve ----
def test_resolve_success(client, upstream):
    route = upstream.get(SESAME).respond(200, content=sesame_xml())
    resp = client.get("/api/objects/resolve", params={"name": "M31"})
    assert resp.status_code == 200
    assert resp.json() == {
        "name": "M 31", "ra": 10.6847083, "dec": 41.26875,
        "source": "CDS Sesame (SIMBAD)", "object_type": "AGN",
    }
    assert route.calls.last.request.url.query == b"M31"


def test_resolve_omits_object_type_when_unknown(client, upstream):
    xml = sesame_xml(otype="").replace(b"<otype></otype>", b"")
    upstream.get(SESAME).respond(200, content=xml)
    body = client.get("/api/objects/resolve", params={"name": "M31"}).json()
    assert "object_type" not in body


def test_resolve_strips_simbad_name_prefix_and_normalises_ra(client, upstream):
    upstream.get(SESAME).respond(200, content=sesame_xml(oname="NAME Barnard's star", ra="-90.5"))
    body = client.get("/api/objects/resolve", params={"name": "Barnard's Star"}).json()
    assert body["name"] == "Barnard's star" and body["ra"] == pytest.approx(269.5)


def test_resolve_encodes_unicode_and_spaces(client, upstream):
    route = upstream.get(SESAME).respond(200, content=sesame_xml(oname="NGC 891"))
    client.get("/api/objects/resolve", params={"name": "NGC 891 ★ ß"})
    assert route.calls.last.request.url.query == b"NGC%20891%20%E2%98%85%20%C3%9F"


def test_resolve_follows_redirect_to_allowed_mirror(client, upstream):
    upstream.get(SESAME).respond(302, headers={"location": "https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/SNV?M31"})
    mirror = upstream.get("https://vizier.idia.ac.za/viz-bin/nph-sesame/-oxp/SNV").respond(200, content=sesame_xml())
    assert client.get("/api/objects/resolve", params={"name": "M31"}).status_code == 200
    assert mirror.call_count == 1


def test_resolve_refuses_redirect_to_untrusted_host(client, upstream):
    upstream.get(SESAME).respond(302, headers={"location": "https://evil.example/x?M31"})
    evil = upstream.get("https://evil.example/x").respond(200, content=sesame_xml())
    resp = client.get("/api/objects/resolve", params={"name": "M31"})
    assert resp.status_code == 502 and err(resp) == "upstream_invalid_response"
    assert evil.call_count == 0


def test_resolve_refuses_redirect_loops(client, upstream):
    upstream.get(SESAME).respond(302, headers={"location": SESAME + "?M31"})
    assert err(client.get("/api/objects/resolve", params={"name": "M31"})) == "upstream_invalid_response"


def test_unresolved_name(client, upstream):
    upstream.get(SESAME).respond(200, content=SESAME_NOT_FOUND)
    resp = client.get("/api/objects/resolve", params={"name": "qqq"})
    assert resp.status_code == 404 and err(resp) == "object_not_found"


@pytest.mark.parametrize("name", ["", "   ", "a" * 101, "bad\x00name", "line\nbreak"])
def test_invalid_names_rejected_without_upstream_call(client, upstream, name):
    resp = client.get("/api/objects/resolve", params={"name": name})
    assert resp.status_code == 422 and err(resp) == "invalid_parameters"
    assert upstream.calls.call_count == 0


def test_missing_name_param(client):
    assert err(client.get("/api/objects/resolve")) == "invalid_parameters"


def test_resolver_timeout(client, upstream):
    upstream.get(SESAME).mock(side_effect=httpx.ReadTimeout("slow"))
    resp = client.get("/api/objects/resolve", params={"name": "M31"})
    assert resp.status_code == 504 and err(resp) == "upstream_timeout"


@pytest.mark.parametrize(
    "content",
    [b"<html>nope</html>", b"<Sesame><Target>", b"", b"<!DOCTYPE x [<!ENTITY a 'b'>]><Sesame>&a;</Sesame>",
     sesame_xml(ra="abc"), sesame_xml(dec="95")],
)
def test_malformed_resolver_responses(client, upstream, content):
    upstream.get(SESAME).respond(200, content=content)
    resp = client.get("/api/objects/resolve", params={"name": "M31"})
    assert resp.status_code == 502 and err(resp) == "upstream_invalid_response"


def test_resolver_http_error(client, upstream):
    upstream.get(SESAME).respond(500)
    assert err(client.get("/api/objects/resolve", params={"name": "M31"})) == "upstream_invalid_response"


def test_resolution_cache_hit_and_failures_not_cached(client, upstream):
    route = upstream.get(SESAME).mock(
        side_effect=[httpx.Response(200, content=SESAME_NOT_FOUND), httpx.Response(200, content=sesame_xml()),
                     httpx.Response(200, content=sesame_xml(ra="1"))]
    )
    assert client.get("/api/objects/resolve", params={"name": "M31"}).status_code == 404
    ok1 = client.get("/api/objects/resolve", params={"name": "M31"}).json()
    ok2 = client.get("/api/objects/resolve", params={"name": "  m31 "}).json()  # normalised key
    assert route.call_count == 2 and ok1 == ok2


# ------------------------------------------------------------------- nearby ----
def row(obj_id, ra, dec, typ=3):
    return {"objID": obj_id, "ra": ra, "dec": dec, "type": typ}


def test_nearby_sorted_by_true_separation_with_labels(client, upstream):
    # 10" north, 25" north, and 4" east at dec 60 (RA offset is shrunk by cos(dec)).
    rows = [
        row(1237674651002470811, 180.0, 0.5 + 25 / 3600, 3),
        row(1237674651002470799, 180.0, 0.5 + 10 / 3600, 6),
        row(1237674651002471520, 180.0 + 8 / 3600 / 0.99996, 0.5, 0),
    ]
    route = upstream.get(SDSS_SQL).respond(200, json=sql_payload(rows))
    resp = client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5, "radius_arcsec": 30, "limit": 8})
    assert resp.status_code == 200
    matches = resp.json()["matches"]
    assert [m["id"] for m in matches] == ["1237674651002471520", "1237674651002470799", "1237674651002470811"]
    assert [m["object_type"] for m in matches] == ["Unknown", "Star", "Galaxy"]
    assert [m["separation_arcsec"] for m in matches] == pytest.approx([8.0, 10.0, 25.0], abs=0.01)
    assert all(m["source"] == "SDSS DR18" for m in matches)
    assert all("name" not in m for m in matches)  # anonymous catalogue sources get no invented name
    cmd = route.calls.last.request.url.params["cmd"]
    assert "fGetNearbyObjEq(180.000000000,0.500000000,0.500000)" in cmd and "TOP 8" in cmd and "mode = 1" in cmd


def test_nearby_filters_results_beyond_radius(client, upstream):
    upstream.get(SDSS_SQL).respond(200, json=sql_payload([row(1, 180.0, 0.5 + 40 / 3600)]))
    assert client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5, "radius_arcsec": 30}).json() == {"matches": []}


def test_nearby_no_matches_is_success(client, upstream):
    upstream.get(SDSS_SQL).respond(200, json=sql_payload([]))
    resp = client.get("/api/objects/nearby", params={"ra": 50, "dec": -60})
    assert resp.status_code == 200 and resp.json() == {"matches": []}


def test_nearby_defaults_match_frontend(client, upstream):
    route = upstream.get(SDSS_SQL).respond(200, json=sql_payload([]))
    client.get("/api/objects/nearby", params={"ra": 1, "dec": 1})
    assert "TOP 8" in route.calls.last.request.url.params["cmd"]


@pytest.mark.parametrize(
    "params",
    [{"radius_arcsec": 0}, {"radius_arcsec": -1}, {"radius_arcsec": 121}, {"radius_arcsec": "nan"},
     {"limit": 0}, {"limit": 51}, {"limit": "x"}, {"ra": 360}, {"dec": 91}, {"ra": "inf"}],
)
def test_nearby_invalid_parameters(client, upstream, params):
    resp = client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5, **params})
    assert resp.status_code == 422 and err(resp) == "invalid_parameters"
    assert upstream.calls.call_count == 0


def test_nearby_service_failures_are_errors_not_empty_lists(client, upstream):
    route = upstream.get(SDSS_SQL)
    for effect, status in (
        (httpx.ReadTimeout("slow"), 502),
        (httpx.Response(500, json={"ErrorCode": 500, "ErrorMessage": "Invalid object name"}), 502),
        (httpx.Response(200, content=b"<html>"), 502),
        (httpx.Response(200, json={"unexpected": True}), 502),
        (httpx.Response(200, json=sql_payload([{"objID": 1, "ra": "x", "dec": 0, "type": 3}])), 502),
        (httpx.Response(200, json=sql_payload([{"objID": 1}])), 502),
        (httpx.Response(503), 502),
    ):
        route.mock(side_effect=[effect] * 3)
        resp = client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5, "limit": 1 + status % 7})
        assert resp.status_code == 502 and err(resp) == "catalogue_unavailable", effect


def test_nearby_cache(client, upstream):
    route = upstream.get(SDSS_SQL).respond(200, json=sql_payload([row(1, 180.0, 0.5)]))
    for _ in range(3):
        client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5})
    assert route.call_count == 1


def test_sql_is_built_from_numbers_only(client, upstream):
    route = upstream.get(SDSS_SQL).respond(200, json=sql_payload([]))
    client.get("/api/objects/nearby", params={"ra": "1; DROP TABLE x", "dec": 0})
    assert route.call_count == 0  # rejected by validation; injection text never reaches SQL


# --------------------------------------------------------------- geometry ----
def test_angular_separation_known_values():
    assert angular_separation_arcsec(0, 0, 1, 0) == pytest.approx(3600.0)
    assert angular_separation_arcsec(10, 20, 10, 20) == 0.0
    assert angular_separation_arcsec(0, 90, 123, 90) == pytest.approx(0.0, abs=1e-6)
    assert angular_separation_arcsec(0, -90, 0, 90) == pytest.approx(180 * 3600)
    # RA wrap-around: 0.0002 deg apart across the 0/360 seam.
    assert angular_separation_arcsec(359.9999, 0, 0.0001, 0) == pytest.approx(0.72, rel=1e-6)
    # High declination: 0.2 deg of RA at dec 89.9 is only ~ 0.2*cos(89.9) deg of sky.
    assert angular_separation_arcsec(10, 89.9, 10.2, 89.9) == pytest.approx(1.2566, rel=1e-3)


def test_normalize_ra():
    assert normalize_ra(-90) == 270 and normalize_ra(360) == 0 and normalize_ra(725) == 5
    assert normalize_ra(-1e-18) < 360
