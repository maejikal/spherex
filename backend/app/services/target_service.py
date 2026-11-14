"""Curated, coverage-verified targets.

All coordinates come from ``app/data/verified_targets.json``, produced by
``backend/scripts/verify_targets.py``, which resolves names through CDS Sesame and checks SDSS imaging
coverage against the live cutout service. Nothing here is generated at request time.
"""

from __future__ import annotations

import json
import random
import threading
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DATA_FILE = Path(__file__).resolve().parent.parent / "data" / "verified_targets.json"


@dataclass(frozen=True, slots=True)
class Target:
    id: str
    name: str
    ra: float
    dec: float
    description: str | None = None


class TargetService:
    def __init__(self, data_file: Path = DEFAULT_DATA_FILE, rng: random.Random | None = None) -> None:
        data = json.loads(Path(data_file).read_text())
        self.suggested = [Target(**t) for t in data["suggested"]]
        self.random_fields = [Target(**t) for t in data["random_fields"]]
        if not self.random_fields:
            raise ValueError("verified_targets.json contains no random fields")
        self.provenance = data.get("provenance", {})
        self._rng = rng or random.Random()
        # Process-wide "previous pick": not shared across multiple workers, and shared by all clients.
        self._last_id: str | None = None
        self._lock = threading.Lock()

    def random_target(self) -> Target:
        with self._lock:
            pool = [t for t in self.random_fields if t.id != self._last_id] or self.random_fields
            choice = self._rng.choice(pool)
            self._last_id = choice.id
            return choice
