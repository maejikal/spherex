import json

import pytest

from app.services.target_service import DEFAULT_DATA_FILE, TargetService


def test_suggested_schema_and_ranges(client):
    body = client.get("/api/targets/suggested").json()
    assert set(body) == {"targets"} and body["targets"]
    for t in body["targets"]:
        assert isinstance(t["name"], str) and t["name"]
        assert 0 <= t["ra"] < 360 and -90 <= t["dec"] <= 90
        assert set(t) <= {"id", "name", "ra", "dec", "description"}


def test_suggested_are_the_spherex_challenge_targets_not_sdss_ones(client):
    ids = {t["id"] for t in client.get("/api/targets/suggested").json()["targets"]}
    assert {"barnards-star", "eps-indi-b", "wise-0855", "rw-aur", "r-dra"} <= ids
    assert "ngc891" not in ids and "cosmos" not in ids and "lockman" not in ids


def test_high_proper_motion_targets_state_the_epoch_adjustment(client):
    by_id = {t["id"]: t for t in client.get("/api/targets/suggested").json()["targets"]}
    for key in ("barnards-star", "eps-indi-b", "wise-0855"):
        assert "proper motion" in by_id[key]["description"].lower() and "propagated" in by_id[key]["description"]
    # Barnard's Star moves ~10.4"/yr: ~4.5' by the cube epoch, so its position must differ from J2000.
    assert (by_id["barnards-star"]["ra"], by_id["barnards-star"]["dec"]) != (269.452077, 4.693365)
    assert "moving" not in by_id["barnards-star"]["description"].lower().replace("proper motion", "")


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


def test_random_positions_are_spread_over_both_hemispheres_of_the_sky():
    fields = json.loads(DEFAULT_DATA_FILE.read_text())["random_fields"]
    decs = [f["dec"] for f in fields]
    ras = [f["ra"] for f in fields]
    assert min(decs) < -20 and max(decs) > 20
    assert max(ras) - min(ras) > 180
    # Uniform on the sphere puts about half of the points within |dec| < 30 deg (not 1/3 as uniform-in-dec would).
    assert 0.25 < sum(abs(d) < 30 for d in decs) / len(decs) < 0.75


def test_verification_provenance_is_recorded():
    prov = json.loads(DEFAULT_DATA_FILE.read_text())["provenance"]
    for key in ("generated_at", "script", "survey", "coverage_method", "limitations"):
        assert prov[key]
    assert "SPHEREx" in prov["survey"] and "tiles" in prov["coverage_method"].lower()


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
