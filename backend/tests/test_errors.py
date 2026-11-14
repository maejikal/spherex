import logging

from conftest import SDSS_JPEG


def test_unknown_route_uses_error_envelope(client):
    resp = client.get("/api/nope")
    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "not_found"


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
    upstream.get(SDSS_JPEG).respond(404, content=b"\xff\xd8\xff", headers={"content-type": "image/jpeg"})
    resp = client.get("/api/images/cutout", params={"ra": 1, "dec": 1})
    assert resp.headers["cache-control"] == "no-store"


def test_openapi_is_served(client):
    paths = client.get("/openapi.json").json()["paths"]
    for p in ("/api/health", "/api/surveys", "/api/images/cutout", "/api/objects/resolve",
              "/api/objects/nearby", "/api/targets/suggested", "/api/targets/random"):
        assert p in paths
