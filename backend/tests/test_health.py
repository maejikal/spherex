import httpx

from conftest import PROPERTIES, PROPERTIES_URL, SESAME, SIMBAD_MIRROR, SIMBAD_PRIMARY, sesame_xml, tap_json


def test_health_is_ok_and_makes_no_upstream_calls(client, upstream):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert upstream.calls.call_count == 0


def test_health_stays_ok_when_upstreams_are_down(client, upstream):
    upstream.get(PROPERTIES_URL).mock(side_effect=httpx.ConnectError("down"))
    assert client.get("/api/health").json() == {"status": "ok"}


def test_dependency_diagnostics_report_degraded(client, upstream):
    upstream.get(PROPERTIES_URL).mock(side_effect=httpx.ConnectError("down"))
    upstream.get(SESAME).respond(200, content=sesame_xml())
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([]))
    body = client.get("/api/health/dependencies").json()
    assert body["status"] == "degraded"
    by_name = {d["name"]: d for d in body["dependencies"]}
    assert by_name["irsa-spherex-hips"]["ok"] is False
    assert by_name["cds-sesame"]["ok"] is True and by_name["simbad"]["ok"] is True


def test_dependency_diagnostics_all_ok(client, upstream):
    upstream.get(PROPERTIES_URL).respond(200, text=PROPERTIES)
    upstream.get(SESAME).respond(200, content=sesame_xml())
    upstream.get(SIMBAD_PRIMARY).respond(200, json=tap_json([]))
    assert client.get("/api/health/dependencies").json()["status"] == "ok"
