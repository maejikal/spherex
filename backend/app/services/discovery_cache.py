"""Bounded, atomic disk snapshots of successful IRSA discovery responses.

Snapshots are not authoritative coverage indexes: callers must revalidate their VOTables
and FITS before use. Only an upstream outage permits stale snapshot recovery.
"""

from __future__ import annotations

import hashlib
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("skyexplorer.irsa")


class DiscoveryCache:
    def __init__(self, directory: Path, max_entries: int, max_bytes: int) -> None:
        self._dir = directory
        self._max_entries = max_entries
        self._max_bytes = max_bytes

    def _path(self, key: str) -> Path:
        return self._dir / f"{hashlib.sha256(key.encode()).hexdigest()}.xml"

    def read(self, key: str) -> tuple[bytes, str] | None:
        try:
            with self._path(key).open("rb") as source:
                stat = os.fstat(source.fileno())
                if stat.st_size > self._max_bytes:
                    return None
                content = source.read(self._max_bytes + 1)
            if len(content) > self._max_bytes:
                return None
            saved = datetime.fromtimestamp(stat.st_mtime, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            return content, saved
        except OSError:
            return None

    def write(self, key: str, content: bytes) -> None:
        if len(content) > self._max_bytes:
            return
        target = self._path(key)
        temp = target.with_suffix(f".{uuid.uuid4().hex}.part")
        try:
            self._dir.mkdir(parents=True, exist_ok=True)
            temp.write_bytes(content)
            os.replace(temp, target)
            files = sorted(self._dir.glob("*.xml"), key=lambda p: p.stat().st_mtime, reverse=True)
            for path in files[self._max_entries:]:
                path.unlink(missing_ok=True)
        except OSError as exc:
            # Persistence is best-effort; a read-only/full disk must not break live discovery.
            log.warning("could not persist discovery cache: %s", exc)
        finally:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass
