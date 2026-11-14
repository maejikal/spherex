"""Orchestrates survey selection, cache lookup and the image provider."""

from __future__ import annotations

from ..models.errors import UnsupportedSurvey
from ..providers.base import CutoutRequest, CutoutResult, ImageProvider, SurveyInfo
from .image_cache import ImageCache, cache_key


class ImageService:
    def __init__(self, providers: dict[str, ImageProvider], cache: ImageCache) -> None:
        self._providers = providers
        self._cache = cache

    def surveys(self) -> list[SurveyInfo]:
        return [p.survey for p in self._providers.values()]

    async def get_cutout(self, survey: str, request: CutoutRequest) -> tuple[CutoutResult, bool]:
        provider = self._providers.get(survey)
        if provider is None:
            raise UnsupportedSurvey(f"Unsupported survey '{survey}'. Supported: {', '.join(self._providers)}.")
        key = cache_key(survey, request.ra, request.dec, request.scale, request.width, request.height, request.grid)
        return await self._cache.get_or_fetch(key, lambda: provider.get_cutout(request))
