"""Discovery persistence: bounds, isolation, and best-effort atomic writes."""
from app.services.discovery_cache import DiscoveryCache


def test_discovery_cache_round_trip_isolated_and_bounded(tmp_path):
    cache = DiscoveryCache(tmp_path, max_entries=2, max_bytes=20)
    cache.write("one", b"first")
    cache.write("two", b"second")
    cache.write("three", b"third")
    assert cache.read("one") is None
    assert cache.read("two")[0] == b"second"
    assert cache.read("three")[1].endswith(" UTC")
    assert cache.read("unrelated") is None
    assert len(list(tmp_path.glob("*.xml"))) == 2
    assert not list(tmp_path.glob("*.part"))


def test_oversized_snapshots_are_never_used(tmp_path):
    cache = DiscoveryCache(tmp_path, max_entries=2, max_bytes=4)
    cache.write("key", b"too large")
    assert cache.read("key") is None
    cache.write("key", b"okay")
    next(tmp_path.glob("*.xml")).write_bytes(b"too large")
    assert cache.read("key") is None


def test_failed_atomic_write_preserves_previous_snapshot(tmp_path, monkeypatch):
    cache = DiscoveryCache(tmp_path, max_entries=2, max_bytes=20)
    cache.write("key", b"original")
    def fail(*_args):
        raise OSError("Disk full")
    monkeypatch.setattr("app.services.discovery_cache.os.replace", fail)
    cache.write("key", b"replacement")
    assert cache.read("key")[0] == b"original"
    assert not list(tmp_path.glob("*.part"))
