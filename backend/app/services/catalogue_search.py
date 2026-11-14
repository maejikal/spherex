"""Nearby-object search with validation and a short TTL cache (successful queries only)."""

from __future__ import annotations

from ..config import Settings
from ..models.errors import InvalidParameters
from ..providers.base import CatalogueMatch, CatalogueProvider
from ..utils.ttl_cache import TTLCache


class CatalogueSearchService:
    def __init__(self, provider: CatalogueProvider, settings: Settings) -> None:
        self._provider = provider
        self._max_radius = settings.max_nearby_radius_arcsec
        self._max_limit = settings.max_nearby_limit
        self._cache: TTLCache[list[CatalogueMatch]] = TTLCache(
            settings.memory_cache_max_entries, settings.catalogue_cache_ttl_seconds
        )

    async def nearby(self, ra: float, dec: float, radius_arcsec: float, limit: int) -> list[CatalogueMatch]:
        if not 0 < radius_arcsec <= self._max_radius:
            raise InvalidParameters(f"radius_arcsec must be greater than 0 and at most {self._max_radius:g}.")
        if not 1 <= limit <= self._max_limit:
            raise InvalidParameters(f"limit must be between 1 and {self._max_limit}.")
        key = f"{ra:.7f}|{dec:.7f}|{radius_arcsec:.3f}|{limit}"
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        matches = await self._provider.nearby(ra, dec, radius_arcsec, limit)
        self._cache.set(key, matches)
        return matches
