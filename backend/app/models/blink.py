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
    # Fields below the first group are filled by the dynamic (archive) endpoint only.
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
    bandwidth_um: float | None = None
    geometric_coverage: float | None = None
    suspect_fraction: float | None = None
    source_fraction: float | None = None
    calibration_version: str | None = None
    detector_position: list[float] | None = None  # exact zero-based full-detector pixel of the target (archive-header verified)
    full_image_crpix: list[float] | None = None  # the full image's own reference pixel (not always the detector centre)
    footprint_error_px: float | None = None  # SIA-polygon prediction vs the verified position


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


class PairSelectionInfo(BaseModel):
    predicted_gap_nm: float
    actual_gap_nm: float
    actual_gap_over_bandwidth: float
    field_gap_nm: float
    bandwidth_difference_fraction: float
    epoch_separation_days: float
    candidates_tried: int
    rejected_candidates: list[str]
    thresholds: dict[str, float]


class Provenance(BaseModel):
    source: str
    collection: str
    release: str
    archive_search: str
    interpolation: str
    flag_policy: str


class DynamicBlinkResponse(BlinkResponse):
    mode: str = "dynamic"
    fov_deg: float
    rotation_deg: int
    wcs: dict
    geometric_coverage: float
    selection: PairSelectionInfo
    provenance: Provenance
