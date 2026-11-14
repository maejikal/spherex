from conftest import SDSS_JPEG, SESAME, make_jpeg, sesame_xml
import httpx


def test_health_is_ok_and_makes_no_upstream_calls(client, upstream):
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
    assert upstream.calls.call_count == 0


def test_health_stays_ok_when_upstreams_are_down(client, upstream):
    upstream.get(SDSS_JPEG).mock(side_effect=httpx.ConnectError("down"))
    assert client.get("/api/health").json() == {"status": "ok"}


def test_dependency_diagnostics_report_degraded(client, upstream):
    upstream.get(SDSS_JPEG).mock(side_effect=httpx.ConnectError("down"))
    upstream.get(SESAME).respond(200, content=sesame_xml())
    body = client.get("/api/health/dependencies").json()
    assert body["status"] == "degraded"
    by_name = {d["name"]: d for d in body["dependencies"]}
    assert by_name["sdss-cutout"]["ok"] is False and by_name["cds-sesame"]["ok"] is True


def test_surveys_lists_only_sdss(client):
    body = client.get("/api/surveys").json()
    assert [s["id"] for s in body["surveys"]] == ["sdss-dr18"]
    assert body["surveys"][0]["release"] == "DR18" and body["surveys"][0]["available"] is True
