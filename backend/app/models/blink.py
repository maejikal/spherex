"""Response models for the blink viewer endpoint."""

from __future__ import annotations

from pydantic import BaseModel


class BlinkCoordinates(BaseModel):
    ra: float
    dec: float


class WavelengthRange(BaseModel):
    """Central wavelength (µm) of the detector pixels that fall inside this cutout."""

    min: float
    max: float
    mean: float


class BlinkFrame(BaseModel):
    id: str
    label: str
    date: str
    date_obs: str
    mjd: float
    obsid: str | None = None
    detector: int | None = None
    image_url: str
    coverage_fraction: float
    wavelength_um: WavelengthRange | None = None
    background_mjy_sr: float | None = None
    unit: str


class BlinkDisplay(BaseModel):
    method: str
    stretch_low_mjy_sr: float
    stretch_high_mjy_sr: float
    asinh_softening: float
    note: str


class BlinkResponse(BaseModel):
    coordinates: BlinkCoordinates
    image_size: int
    pixel_scale_arcsec: float
    field_of_view_arcmin: float
    orientation: str
    resampling: str
    display: BlinkDisplay
    frames: list[BlinkFrame]
    common_coverage_fraction: float
    warnings: list[str]
