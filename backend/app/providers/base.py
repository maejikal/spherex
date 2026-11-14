"""Provider contracts.

The application has two separate concerns:

* **Browser survey rendering** - Aladin Lite reads SPHEREx HiPS tiles straight from IRSA. No provider
  sits in that path.
* **Backend scientific services** - survey metadata, name resolution, catalogue lookups, and (later)
  FITS processing and observation discovery. These are the providers below.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True, slots=True)
class SpectralChannel:
    """One frame of a spectral cube. ``wavelength_um`` comes from the service, never computed."""

    frame: int  # 0-based; equals the tile-file suffix
    band: int
    band_channel: int
    wavelength_um: float
    has_data: bool


@dataclass(frozen=True, slots=True)
class SurveyInfo:
    id: str
    name: str
    release: str
    available: bool
    description: str
    data_source: str
    hips_url: str | None = None
    tile_format: str | None = None
    tile_width: int | None = None
    max_order: int | None = None
    coordinate_frame: str | None = None
    sky_fraction: float | None = None
    observation_window_mjd: tuple[float, float] | None = None
    channels: tuple[SpectralChannel, ...] = field(default_factory=tuple)


class SurveyProvider(Protocol):
    """A survey the backend can describe. Future providers (e.g. timestamped SPHEREx observations
    from IRSA FITS services) implement the same contract and register next to the HiPS cube."""

    survey_id: str

    async def describe(self) -> SurveyInfo: ...


@dataclass(frozen=True, slots=True)
class CatalogueMatch:
    id: str
    name: str
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
