import logging

from conftest import PROPERTIES_URL


def test_unknown_route_uses_error_envelope(client):
    resp = client.get("/api/nope")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


def test_removed_sdss_image_route_is_gone(client, upstream):
    resp = client.get("/api/images/cutout", params={"ra": 180, "dec": 0.5})
    assert resp.status_code == 404 and resp.json()["error"]["code"] == "not_found"
    assert upstream.calls.call_count == 0


def test_method_not_allowed_uses_envelope(client):
    resp = client.post("/api/health")
    assert resp.status_code == 405 and set(resp.json()) == {"error"}


def test_unexpected_exception_is_hidden_and_logged(client, caplog):
    def boom(*a, **k):
        raise RuntimeError("secret internal detail /etc/passwd")

    client.app.state.services.targets.random_target = boom
    with caplog.at_level(logging.ERROR):
        resp = client.get("/api/targets/random")
    assert resp.status_code == 500
    assert resp.json() == {"error": {"code": "internal_error", "message": "An unexpected error occurred."}}
    assert "secret" not in resp.text and "Traceback" not in resp.text
    assert "secret internal detail" in caplog.text  # logged server-side


def test_errors_are_not_cacheable(client, upstream):
    upstream.get(PROPERTIES_URL).respond(503)
    resp = client.get("/api/surveys")
    assert resp.headers["cache-control"] == "no-store"


def test_cors_allows_only_configured_origins(client, upstream):
    ok = client.get("/api/health", headers={"Origin": "http://localhost:5173"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:5173"
    other = client.get("/api/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_openapi_is_served_and_lists_only_current_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    for p in ("/api/health", "/api/surveys", "/api/objects/resolve", "/api/objects/nearby",
              "/api/targets/suggested", "/api/targets/random"):
        assert p in paths
    assert "/api/images/cutout" not in paths
