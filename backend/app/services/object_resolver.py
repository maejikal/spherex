"""Name resolution with a bounded in-memory TTL cache. Failures are never cached."""

from __future__ import annotations

import unicodedata

from ..config import Settings
from ..providers.base import NameResolver, ResolvedName
from ..utils.ttl_cache import TTLCache
from ..utils.validation import clean_object_name


def normalize_key(name: str) -> str:
    # Case-fold and collapse whitespace only. "M31" and "M 31" stay distinct keys: Sesame is the
    # authority on whether they are equivalent, so we do not guess.
    return unicodedata.normalize("NFKC", name).casefold()


class ObjectResolverService:
    def __init__(self, resolver: NameResolver, settings: Settings) -> None:
        self._resolver = resolver
        self._max_len = settings.max_name_length
        self._cache: TTLCache[ResolvedName] = TTLCache(
            settings.memory_cache_max_entries, settings.resolver_cache_ttl_seconds
        )

    async def resolve(self, raw_name: str) -> ResolvedName:
        name = clean_object_name(raw_name, self._max_len)
        key = normalize_key(name)
        hit = self._cache.get(key)
        if hit is not None:
            return hit
        result = await self._resolver.resolve(name)
        self._cache.set(key, result)
        return result
