import asyncio
import os
import time

from app.providers.base import CutoutResult, ImageMetadata
from app.services.image_cache import ImageCache, cache_key
from app.utils.ttl_cache import TTLCache
from conftest import SDSS_JPEG, make_jpeg

PARAMS = {"ra": 180, "dec": 0.5, "scale": 0.4, "width": 512, "height": 512, "survey": "sdss-dr18", "grid": 0}


def test_second_identical_request_is_served_from_cache(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    first = client.get("/api/images/cutout", params=PARAMS)
    second = client.get("/api/images/cutout", params=PARAMS)
    assert route.call_count == 1
    assert (first.headers["x-backend-cache"], second.headers["x-backend-cache"]) == ("MISS", "HIT")
    assert first.content == second.content
    for h in ("x-source-url", "x-survey-release", "x-coordinate-frame", "content-type"):
        assert first.headers[h] == second.headers[h]


def test_cache_key_distinguishes_every_parameter(client, upstream):
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    client.get("/api/images/cutout", params=PARAMS)
    for change in ({"ra": 181}, {"dec": 1}, {"scale": 0.5}, {"width": 400}, {"height": 400}, {"grid": 1}):
        client.get("/api/images/cutout", params={**PARAMS, **change})
    assert route.call_count == 7


def test_expired_entries_are_refetched(make_client, upstream):
    c = make_client(image_cache_ttl_seconds=0)
    route = upstream.get(SDSS_JPEG).respond(200, content=make_jpeg(512, 512), headers={"content-type": "image/jpeg"})
    c.get("/api/images/cutout", params=PARAMS)
    time.sleep(0.01)
    c.get("/api/images/cutout", params=PARAMS)
    assert route.call_count == 2


def test_disk_cache_is_bounded(tmp_path):
    cache = ImageCache(tmp_path, ttl_seconds=3600, max_bytes=5000)
    jpeg = make_jpeg(64, 64)

    async def run():
        for i in range(12):
            async def fetch():
                return CutoutResult(jpeg, "image/jpeg", ImageMetadata(survey_release="DR18"))
            await cache.get_or_fetch(cache_key("s", i, 0, 1, 64, 64, False), fetch)
            await asyncio.sleep(0.01)

    asyncio.run(run())
    assert cache.size_bytes() <= 5000 + len(jpeg) * 2
    assert len(list(tmp_path.glob("*.jpg"))) < 12


def test_corrupt_cache_entry_is_ignored(tmp_path):
    cache = ImageCache(tmp_path, ttl_seconds=3600, max_bytes=10**6)
    key = cache_key("s", 1, 1, 1, 64, 64, False)
    (tmp_path / f"{key}.jpg").write_bytes(b"not a jpeg")
    (tmp_path / f"{key}.json").write_text("{}")
    calls = []

    async def fetch():
        calls.append(1)
        return CutoutResult(make_jpeg(), "image/jpeg")

    result, hit = asyncio.run(cache.get_or_fetch(key, fetch))
    assert hit is False and calls == [1] and result.content.startswith(b"\xff\xd8\xff")


def test_concurrent_identical_misses_share_one_fetch(tmp_path):
    cache = ImageCache(tmp_path, ttl_seconds=3600, max_bytes=10**6)
    calls = []

    async def fetch():
        calls.append(1)
        await asyncio.sleep(0.05)
        return CutoutResult(make_jpeg(), "image/jpeg")

    async def run():
        return await asyncio.gather(*[cache.get_or_fetch("k", fetch) for _ in range(5)])

    results = asyncio.run(run())
    assert len(calls) == 1 and len(results) == 5


def test_ttl_cache_expiry_and_lru():
    now = [0.0]
    cache: TTLCache[int] = TTLCache(2, ttl_seconds=10, clock=lambda: now[0])
    cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3)
    assert cache.get("b") is None and cache.get("a") == 1 and cache.get("c") == 3
    now[0] = 11
    assert cache.get("a") is None
