import httpx
import pytest

from app.utils.coordinates import angular_separation_arcsec, normalize_ra
from conftest import SESAME, SESAME_NOT_FOUND, SIMBAD_MIRROR, SIMBAD_PRIMARY, sesame_xml, tap_json


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


# ------------------------------------------------------------------- nearby (SIMBAD) ----
def row(main_id, ra, dec, otype="G", desc="Galaxy"):
    return [main_id, ra, dec, otype, desc, 0.0]


def test_nearby_returns_simbad_records_sorted_by_true_separation(client, upstream):
    # 25" north, 10" north and 8" east at dec 60 (RA offset is shrunk by cos(dec) in the geometry).
    rows = [
        row("NGC 1 B", 180.0, 60.0 + 25 / 3600),
        row("*  alf Tst", 180.0, 60.0 + 10 / 3600, "*", "Star"),
        row("2MASS J12000000+6000000", 180.0 + 8 / 3600 / 0.5, 60.0, "IR", "Infra-Red source"),
    ]
    route = upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json(rows))
    resp = client.get("/api/objects/nearby", params={"ra": 180, "dec": 60, "radius_arcsec": 30, "limit": 8})
    assert resp.status_code == 200
    matches = resp.json()["matches"]
    assert [m["name"] for m in matches] == ["2MASS J12000000+6000000", "* alf Tst", "NGC 1 B"]
    assert [m["object_type"] for m in matches] == ["Infra-Red source", "Star", "Galaxy"]
    assert [m["separation_arcsec"] for m in matches] == pytest.approx([8.0, 10.0, 25.0], abs=0.01)
    assert all(m["source"] == "SIMBAD" for m in matches)
    assert matches[1]["id"] == "* alf Tst"  # whitespace-normalised SIMBAD main identifier, not invented
    adql = route.calls.last.request.url.params["query"]
    assert "CIRCLE('ICRS', 180.000000000, 60.000000000, 0.008333333)" in adql and "TOP 8" in adql
    assert route.calls.last.request.url.params["lang"] == "adql" and route.calls.last.request.url.params["format"] == "json"


def test_nearby_strips_the_simbad_name_prefix_but_keeps_the_identifier(client, upstream):
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([row("NAME Barnard's Star c", 180.0, 0.5, "Pl", "Extra-solar Planet")]))
    m = client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5}).json()["matches"][0]
    assert (m["name"], m["id"]) == ("Barnard's Star c", "NAME Barnard's Star c")


def test_nearby_filters_results_beyond_radius(client, upstream):
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([row("FAR", 180.0, 0.5 + 40 / 3600)]))
    assert client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5, "radius_arcsec": 30}).json() == {"matches": []}


def test_nearby_skips_records_without_usable_coordinates(client, upstream):
    rows = [row("NOCOORD", None, None), row("OK", 180.0, 0.5)]
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json(rows))
    names = [m["name"] for m in client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5}).json()["matches"]]
    assert names == ["OK"]


def test_nearby_falls_back_to_object_type_code_without_description(client, upstream):
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([["OBJ", 180.0, 0.5, "Sy2", None, 0.0]]))
    assert client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5}).json()["matches"][0]["object_type"] == "Sy2"


def test_nearby_no_matches_is_success(client, upstream):
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([]))
    resp = client.get("/api/objects/nearby", params={"ra": 50, "dec": -60})
    assert resp.status_code == 200 and resp.json() == {"matches": []}


def test_nearby_defaults_match_frontend(client, upstream):
    route = upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([]))
    client.get("/api/objects/nearby", params={"ra": 1, "dec": 1})
    q = route.calls.last.request.url.params["query"]
    assert "TOP 8" in q and "0.008333333" in q  # 30 arcsec


def test_nearby_fails_over_to_the_mirror_when_primary_serves_html(client, upstream):
    primary = upstream.get(SIMBAD_PRIMARY).respond(200, content=b"<html>Page unavailable</html>", headers={"content-type": "text/html"})
    mirror = upstream.get(SIMBAD_MIRROR).respond(200, json=tap_json([row("M  31", 10.6847083, 41.26875, "AGN", "Active Galaxy Nucleus")]))
    resp = client.get("/api/objects/nearby", params={"ra": 10.6847, "dec": 41.2688, "radius_arcsec": 10})
    assert resp.status_code == 200 and resp.json()["matches"][0]["name"] == "M 31"
    assert primary.call_count == 1 and mirror.call_count == 1


def test_nearby_fails_over_on_connection_error_and_5xx(client, upstream):
    upstream.get(SIMBAD_PRIMARY).mock(side_effect=httpx.ConnectError("down"))
    upstream.get(SIMBAD_MIRROR).respond(200, json=tap_json([]))
    assert client.get("/api/objects/nearby", params={"ra": 1, "dec": 1}).json() == {"matches": []}


@pytest.mark.parametrize(
    "params",
    [{"radius_arcsec": 0}, {"radius_arcsec": -1}, {"radius_arcsec": 121}, {"radius_arcsec": "nan"},
     {"limit": 0}, {"limit": 51}, {"limit": "x"}, {"ra": 360}, {"dec": 91}, {"ra": "inf"}],
)
def test_nearby_invalid_parameters(client, upstream, params):
    resp = client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5, **params})
    assert resp.status_code == 422 and err(resp) == "invalid_parameters"
    assert upstream.calls.call_count == 0


@pytest.mark.parametrize(
    "effect",
    [
        httpx.ReadTimeout("slow"),
        httpx.Response(500, text="boom"),
        httpx.Response(200, content=b"<html>"),
        httpx.Response(200, content=b'<?xml version="1.0"?><VOTABLE><INFO name="QUERY_STATUS" value="ERROR">Incorrect ADQL</INFO></VOTABLE>'),
        httpx.Response(200, json={"unexpected": True}),
        httpx.Response(200, json={"metadata": [{"name": "other"}], "data": []}),
        httpx.Response(200, json=tap_json([["ONLY_ID"]])),
        httpx.Response(503),
    ],
)
def test_nearby_service_failures_are_errors_not_empty_lists(client, upstream, effect):
    upstream.get(SIMBAD_PRIMARY).mock(side_effect=[effect] * 3)
    upstream.get(SIMBAD_MIRROR).mock(side_effect=[effect] * 3)
    resp = client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5})
    assert resp.status_code == 502 and err(resp) == "catalogue_unavailable"


def test_nearby_cache(client, upstream):
    route = upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([row("X", 180.0, 0.5)]))
    for _ in range(3):
        client.get("/api/objects/nearby", params={"ra": 180, "dec": 0.5})
    assert route.call_count == 1


def test_adql_is_built_from_numbers_only(client, upstream):
    route = upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([]))
    resp = client.get("/api/objects/nearby", params={"ra": "1; DROP TABLE basic", "dec": 0})
    assert resp.status_code == 422 and route.call_count == 0


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
