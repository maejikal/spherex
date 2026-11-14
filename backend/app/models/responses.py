"""Response schemas. Field names match ``frontend/src/api/client.ts`` parsers exactly."""

from __future__ import annotations

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"


class DependencyStatus(BaseModel):
    name: str
    ok: bool
    detail: str


class DependencyHealth(BaseModel):
    status: str
    dependencies: list[DependencyStatus]


class ChannelOut(BaseModel):
    frame: int = Field(description="0-based cube frame; equals the HiPS tile-file suffix and the frontend `channel` URL parameter")
    band: int
    band_channel: int
    wavelength_um: float
    has_data: bool


class SurveyOut(BaseModel):
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
    observation_window_mjd: tuple[float, float] | None = Field(
        default=None, description="Span of the combined cube; it is not the time of any single exposure"
    )
    channels: list[ChannelOut] = []


class SurveysResponse(BaseModel):
    surveys: list[SurveyOut]


class TargetOut(BaseModel):
    id: str | None = None
    name: str | None = None
    ra: float = Field(ge=0, lt=360)
    dec: float = Field(ge=-90, le=90)
    description: str | None = None


class SuggestedTargetsResponse(BaseModel):
    targets: list[TargetOut]


class RandomTargetResponse(BaseModel):
    target: TargetOut


class ResolveResponse(BaseModel):
    name: str
    ra: float
    dec: float
    source: str
    object_type: str | None = None


class MatchOut(BaseModel):
    id: str
    ra: float
    dec: float
    separation_arcsec: float
    source: str
    object_type: str | None = None
    name: str | None = None


class NearbyResponse(BaseModel):
    matches: list[MatchOut]
