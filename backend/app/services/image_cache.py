"""Bounded filesystem cache for rendered cutouts, plus in-flight request coalescing.

Each entry is two files, ``<sha256>.jpg`` and ``<sha256>.json`` (the provenance metadata), so a cache
hit reproduces exactly the same image *and* headers as the original upstream fetch. Only successful
responses are ever stored; errors are never cached.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

from ..providers.base import CutoutResult, ImageMetadata

log = logging.getLogger("skyexplorer.cache")

JPEG_MAGIC = b"\xff\xd8\xff"


def cache_key(survey: str, ra: float, dec: float, scale: float, width: int, height: int, grid: bool) -> str:
    raw = f"{survey}|{ra:.6f}|{dec:.6f}|{scale:.6f}|{width}|{height}|{int(grid)}"
    return hashlib.sha256(raw.encode()).hexdigest()


class ImageCache:
    def __init__(self, directory: Path, *, ttl_seconds: float, max_bytes: int, clock=time.time) -> None:
        self._dir = directory
        self._ttl = ttl_seconds
        self._max_bytes = max_bytes
        self._clock = clock
        self._inflight: dict[str, asyncio.Task[CutoutResult]] = {}

    # -- synchronous disk operations (run in a worker thread) ----------------------------------
    def _paths(self, key: str) -> tuple[Path, Path]:
        return self._dir / f"{key}.jpg", self._dir / f"{key}.json"

    def _read(self, key: str) -> CutoutResult | None:
        image_path, meta_path = self._paths(key)
        try:
            if self._clock() - image_path.stat().st_mtime > self._ttl:
                self._remove(key)
                return None
            content = image_path.read_bytes()
            meta = json.loads(meta_path.read_text())
        except (FileNotFoundError, ValueError, OSError):
            return None
        if not content.startswith(JPEG_MAGIC):
            self._remove(key)
            return None
        try:
            os.utime(image_path, None)  # not used for expiry (mtime is); touch atime for LRU eviction
        except OSError:
            pass
        return CutoutResult(content=content, media_type="image/jpeg", metadata=ImageMetadata.from_dict(meta))

    def _write(self, key: str, result: CutoutResult) -> None:
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            image_path, meta_path = self._paths(key)
            for path, data in ((meta_path, json.dumps(result.metadata.to_dict()).encode()), (image_path, result.content)):
                tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
                tmp.write_bytes(data)
                os.replace(tmp, path)  # image last: its presence marks a complete entry
            self._evict()
        except OSError:
            log.warning("could not write image cache entry", exc_info=True)

    def _remove(self, key: str) -> None:
        for path in self._paths(key):
            try:
                path.unlink()
            except OSError:
                pass

    def _evict(self) -> None:
        entries = []
        total = 0
        for path in self._dir.glob("*.jpg"):
            try:
                st = path.stat()
            except OSError:
                continue
            meta = path.with_suffix(".json")
            meta_size = meta.stat().st_size if meta.exists() else 0
            entries.append((st.st_atime, path, st.st_size + meta_size))
            total += st.st_size + meta_size
        if total <= self._max_bytes:
            return
        entries.sort(key=lambda e: e[0])  # least recently used first
        for _, path, size in entries:
            if total <= self._max_bytes:
                break
            self._remove(path.stem)
            total -= size

    def size_bytes(self) -> int:
        return sum(p.stat().st_size for p in self._dir.glob("*") if p.is_file()) if self._dir.exists() else 0

    # -- async API -------------------------------------------------------------------------------
    async def get_or_fetch(
        self, key: str, fetch: Callable[[], Awaitable[CutoutResult]]
    ) -> tuple[CutoutResult, bool]:
        """Return ``(result, was_cache_hit)``; concurrent identical misses share one upstream fetch."""
        cached = await asyncio.to_thread(self._read, key)
        if cached is not None:
            return cached, True

        task = self._inflight.get(key)
        if task is None:
            task = asyncio.ensure_future(self._fetch_and_store(key, fetch))
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        # shield: a client disconnect (the viewer aborts stale pan requests) must not cancel the
        # shared fetch other waiters depend on.
        return await asyncio.shield(task), False

    async def _fetch_and_store(self, key: str, fetch: Callable[[], Awaitable[CutoutResult]]) -> CutoutResult:
        result = await fetch()
        await asyncio.to_thread(self._write, key, result)
        return result
