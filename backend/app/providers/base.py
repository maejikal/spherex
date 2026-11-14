"""Provider contracts.

Providers hide upstream request/response details. ``ImageProvider`` deliberately returns a
``CutoutResult`` that describes *what bytes were produced and what is truly known about them*, so
a future SPHEREx provider can return FITS-derived renderings together with timestamps, wavelengths
and WCS, while a JPEG-composite provider such as SDSS leaves those fields ``None``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True, slots=True)
class CutoutRequest:
    ra: float
    dec: float
    scale: float  # arcseconds per pixel
    width: int
    height: int
    grid: bool = False


@dataclass(frozen=True, slots=True)
class ImageMetadata:
    """Provenance of a rendered cutout. ``None`` means *unknown*, never a guess."""

    source_url: str | None = None
    projection: str | None = None
    coordinate_frame: str | None = None
    observation_time: str | None = None
    wavelength: str | None = None
    survey_release: str | None = None
    resampled: bool = False

    def to_dict(self) -> dict:
        return {
            "source_url": self.source_url,
            "projection": self.projection,
            "coordinate_frame": self.coordinate_frame,
            "observation_time": self.observation_time,
            "wavelength": self.wavelength,
            "survey_release": self.survey_release,
            "resampled": self.resampled,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ImageMetadata":
        return cls(**{k: data.get(k) for k in cls.__dataclass_fields__ if k != "resampled"}, resampled=bool(data.get("resampled")))


@dataclass(frozen=True, slots=True)
class CutoutResult:
    content: bytes
    media_type: str
    metadata: ImageMetadata = field(default_factory=ImageMetadata)


@dataclass(frozen=True, slots=True)
class SurveyInfo:
    id: str
    name: str
    release: str
    available: bool
    description: str


class ImageProvider(Protocol):
    """An imaging survey. Implementations must raise ``AppError`` subclasses, never return fakes."""

    survey: SurveyInfo

    async def get_cutout(self, request: CutoutRequest) -> CutoutResult: ...


@dataclass(frozen=True, slots=True)
class CatalogueMatch:
    id: str
    ra: float
    dec: float
    separation_arcsec: float
    object_type: str | None
    source: str


class CatalogueProvider(Protocol):
    async def nearby(self, ra: float, dec: float, radius_arcsec: float, limit: int) -> list[CatalogueMatch]: ...


@dataclass(frozen=True, slots=True)
class ResolvedName:
    name: str
    ra: float
    dec: float
    source: str
    object_type: str | None


class NameResolver(Protocol):
    async def resolve(self, name: str) -> ResolvedName: ...
