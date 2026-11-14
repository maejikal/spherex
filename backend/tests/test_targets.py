import json

import pytest

from app.services.target_service import DEFAULT_DATA_FILE, TargetService

FORBIDDEN = {"barnard", "epsilon indi", "wise 0855", "rw aur", "r dra"}


def test_suggested_schema_and_ranges(client):
    body = client.get("/api/targets/suggested").json()
    assert set(body) == {"targets"} and body["targets"]
    for t in body["targets"]:
        assert isinstance(t["name"], str) and t["name"]
        assert 0 <= t["ra"] < 360 and -90 <= t["dec"] <= 90
        assert set(t) <= {"id", "name", "ra", "dec", "description"}


def test_suggested_excludes_unverified_and_spherex_targets(client):
    names = " ".join(t["name"].lower() for t in client.get("/api/targets/suggested").json()["targets"])
    assert not any(bad in names for bad in FORBIDDEN)
    ids = {t["id"] for t in client.get("/api/targets/suggested").json()["targets"]}
    assert "ngc891" not in ids  # verified to have no SDSS imaging
    assert {"m31", "m51", "m87"} <= ids


def test_random_schema(client):
    body = client.get("/api/targets/random").json()
    assert set(body) == {"target"}
    t = body["target"]
    assert 0 <= t["ra"] < 360 and -90 <= t["dec"] <= 90


def test_random_never_repeats_immediately_and_varies(client):
    picks = [client.get("/api/targets/random").json()["target"]["id"] for _ in range(60)]
    assert all(a != b for a, b in zip(picks, picks[1:]))
    assert len(set(picks)) > 10


def test_random_comes_only_from_verified_fields(client):
    verified = {f["id"] for f in json.loads(DEFAULT_DATA_FILE.read_text())["random_fields"]}
    for _ in range(20):
        assert client.get("/api/targets/random").json()["target"]["id"] in verified


def test_verification_provenance_is_recorded():
    prov = json.loads(DEFAULT_DATA_FILE.read_text())["provenance"]
    for key in ("generated_at", "script", "coverage_method", "limitations"):
        assert prov[key]


def test_single_field_pool_still_works(tmp_path):
    f = tmp_path / "t.json"
    f.write_text(json.dumps({"suggested": [], "random_fields": [{"id": "a", "name": "A", "ra": 1, "dec": 2}]}))
    svc = TargetService(f)
    assert svc.random_target().id == svc.random_target().id == "a"


def test_empty_random_pool_is_rejected(tmp_path):
    f = tmp_path / "t.json"
    f.write_text(json.dumps({"suggested": [], "random_fields": []}))
    with pytest.raises(ValueError):
        TargetService(f)
