from __future__ import annotations

from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response

import calendar

from ..models.errors import InvalidParameters
from ..models.blink import (
    BlinkCoordinates, BlinkDisplay, BlinkFrame, BlinkResponse, DynamicBlinkResponse, PairSelectionInfo, Provenance, WavelengthRange,
)
from ..services.blink_service import BlinkResult
from ..services.dynamic_blink import DynamicResult, frame_id
from .deps import Services, get_services

router = APIRouter(tags=["blink"])

Ra = Annotated[float, Query(ge=0, lt=360, allow_inf_nan=False, description="ICRS right ascension, degrees")]
Dec = Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False, description="ICRS declination, degrees")]
Size = Annotated[int | None, Query(ge=1, le=4096, description="Cutout edge in pixels (default from settings)")]
LocalProfile = Annotated[str | None, Query(min_length=1, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]

IMAGE_CACHE_CONTROL = "public, max-age=3600"


def _image_url(frame_id: str, ra: float, dec: float, size: int, profile_id: str) -> str:
    return f"/api/blink/images/{frame_id}.png?" + urlencode({"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "size": size, "profile": profile_id})


def _to_response(result: BlinkResult, profile_id: str) -> BlinkResponse:
    cutouts = result.cutouts
    frames = []
    for frame, background in zip(cutouts.frames, result.display.background):
        info = frame.info
        wave = frame.wavelength_um
        frames.append(
            BlinkFrame(
                id=info.frame_id,
                label=info.label,
                date=info.date,
                date_obs=info.date_obs,
                mjd=info.mjd,
                obsid=info.obsid,
                detector=info.detector,
                image_url=_image_url(info.frame_id, cutouts.ra, cutouts.dec, cutouts.size, profile_id),
                coverage_fraction=round(frame.coverage_fraction, 4),
                wavelength_um=WavelengthRange(min=wave[0], max=wave[1], mean=wave[2]) if wave else None,
                background_mjy_sr=background,
                unit=info.bunit,
            )
        )
    return BlinkResponse(
        coordinates=BlinkCoordinates(ra=cutouts.ra, dec=cutouts.dec),
        image_size=cutouts.size,
        pixel_scale_arcsec=cutouts.pixel_scale_arcsec,
        field_of_view_arcmin=round(cutouts.size * cutouts.pixel_scale_arcsec / 60.0, 3),
        orientation="North up, east left",
        resampling="Bilinear interpolation onto a shared TAN grid (not flux-conserving)",
        display=BlinkDisplay(
            method="Per-frame median background removed; common percentile clip and asinh stretch",
            stretch_low_mjy_sr=result.display.low,
            stretch_high_mjy_sr=result.display.high,
            asinh_softening=result.display.asinh_softening,
            note="Display scaling only. Not photometric calibration; calibrated values are unchanged.",
        ),
        frames=frames,
        common_coverage_fraction=round(result.common_coverage_fraction, 4),
        warnings=list(result.warnings),
    )


# Plain ``def`` handlers: FastAPI runs them in its thread pool, so FITS/NumPy work never blocks the event loop.
@router.get("/blink/cutouts", response_model=BlinkResponse, response_model_exclude_none=True)
def blink_cutouts(
    ra: Ra,
    dec: Dec,
    services: Annotated[Services, Depends(get_services)],
    size: Size = None,
    profile: LocalProfile = None,
) -> BlinkResponse:
    """Auto-match a usable local FITS pair to the position, or request an explicit profile."""
    if profile is None:
        profile, result = services.blink.select_cutouts(ra, dec, size)
    else:
        result = services.blink.cutouts(ra, dec, size, profile)
    return _to_response(result, profile)


@router.get("/blink/images/{frame_id}.png", response_class=Response, responses={200: {"content": {"image/png": {}}}})
def blink_image(
    frame_id: Annotated[str, Path(pattern=r"^\d{4}-\d{2}$")],
    ra: Ra,
    dec: Dec,
    services: Annotated[Services, Depends(get_services)],
    size: Size = None,
    profile: LocalProfile = "default",
) -> Response:
    png = services.blink.image(ra, dec, size, frame_id, profile)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": IMAGE_CACHE_CONTROL})


# --- Dynamic (NASA/IPAC archive) mode ------------------------------------------------------------------

DynFov = Annotated[float | None, Query(gt=0, le=10, allow_inf_nan=False, description="Square field of view in degrees (default 0.1; 0.02-0.5)")]

DynDetector = Annotated[int | None, Query(ge=1, le=6, description="SPHEREx detector (1–6); omit for automatic selection.")]

DynWavelength = Annotated[float | None, Query(ge=0.75, le=5.0, allow_inf_nan=False, description="Requested wavelength in micrometres; must lie within each observation's calibrated centre passband. Omit for automatic selection.")]


def _dynamic_image_url(fid: str, ra: float, dec: float, fov: float, wavelength_um: float | None = None, detector: int | None = None) -> str:
    params = {"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "fov_deg": f"{fov:g}"}
    if wavelength_um is not None:
        params["wavelength_um"] = str(wavelength_um)
    if detector is not None:
        params["detector"] = str(detector)
    return f"/api/blink/dynamic/images/{fid}.png?" + urlencode(params)


def _dynamic_response(result: DynamicResult, settings) -> DynamicBlinkResponse:  # noqa: ANN001 - Settings
    frames = []
    for f, background in zip(result.frames, result.display.background):
        obs = f.cutout.obs
        year, month = int(obs.iso_date[:4]), int(obs.iso_date[5:7])
        valid_wl = f.wavelength_map[f.valid & (f.wavelength_map == f.wavelength_map)]
        frames.append(BlinkFrame(
            id=frame_id(f), label=f"{calendar.month_name[month]} {year}", date=obs.iso_date, date_obs=f.cutout.date_obs or obs.iso_date,
            mjd=obs.mjd, obsid=obs.obs_id, detector=int(obs.detector[1:]), image_url=_dynamic_image_url(frame_id(f), result.ra, result.dec, result.fov_deg, result.requested_wavelength_um, result.requested_detector),
            coverage_fraction=round(f.good_fraction, 4),
            wavelength_um=WavelengthRange(min=float(valid_wl.min()), max=float(valid_wl.max()), mean=f.centre_wavelength_um) if valid_wl.size else None,
            background_mjy_sr=background, unit="MJy / sr", bandwidth_um=f.centre_bandwidth_um, geometric_coverage=round(f.geometric_coverage, 4),
            suspect_fraction=round(f.suspect_fraction, 4), source_fraction=round(f.source_fraction, 4), calibration_version=f.cutout.calibration.version,
            detector_position=[round(v, 2) for v in f.centre_xy], full_image_crpix=list(f.mapping.full_crpix) if f.mapping else None,
            footprint_error_px=round(f.mapping.prediction_error_px, 1) if f.mapping else None,
        ))
    pair = result.pair
    return DynamicBlinkResponse(
        coordinates=BlinkCoordinates(ra=result.ra, dec=result.dec), image_size=result.size, pixel_scale_arcsec=result.pixel_scale_arcsec,
        field_of_view_arcmin=round(result.size * result.pixel_scale_arcsec / 60.0, 3),
        orientation="North up, east left" if result.rotation_deg == 0 else f"Rotated {result.rotation_deg} degrees from north-up",
        resampling=f"Bilinear interpolation onto a shared TAN grid, renormalised over valid neighbours (a pixel needs at least {settings.dynamic_interp_min_weight:.0%} valid weight); not flux-conserving",
        display=BlinkDisplay(
            method="Per-frame median background removed; common percentile clip and asinh stretch",
            stretch_low_mjy_sr=result.display.low, stretch_high_mjy_sr=result.display.high, asinh_softening=result.display.asinh_softening,
            note="Display scaling only. Not photometric calibration; calibrated values are unchanged.",
        ),
        frames=frames, common_coverage_fraction=round(result.common_good_fraction, 4), warnings=result.warnings,
        requested_detector=result.requested_detector, requested_wavelength_um=result.requested_wavelength_um, fov_deg=result.fov_deg, rotation_deg=result.rotation_deg, wcs=result.wcs_header, geometric_coverage=round(result.common_geometric_coverage, 4),
        selection=PairSelectionInfo(
            predicted_gap_nm=round(pair.gap_nm, 3), actual_gap_nm=round(result.exact_gap_nm, 3), actual_gap_over_bandwidth=round(result.exact_gap_over_bandwidth, 4),
            field_gap_nm=round(result.field_gap_nm, 3), bandwidth_difference_fraction=round(pair.bandwidth_difference, 4),
            epoch_separation_days=round(pair.epoch_separation_days, 2), candidates_tried=result.candidates_tried, rejected_candidates=result.rejected,
            thresholds={"max_pair_gap_nm": settings.max_pair_gap_nm, "max_gap_over_bandwidth": settings.max_gap_over_bandwidth,
                        "min_common_good_fraction": settings.min_common_good_fraction},
        ),
        provenance=Provenance(
            source="NASA/IPAC Infrared Science Archive (IRSA)", collection=result.collection, release=result.release,
            archive_search="SIA2 position search, then IBE FITS cutouts",
            interpolation="Bilinear, mask-aware; flag bitmasks are sampled nearest-neighbour and never interpolated",
            flag_policy="Transparent flags: NONFUNC, MISSING_DATA. All other flags (including SOURCE) remain visible. Non-finite science/variance or non-positive variance are also excluded. "
                        "Caution (kept, reported): OVERFLOW, TRANSIENT, PERSIST, OUTLIER, HALO. Informational (kept): SOURCE, FULLSAMPLE.",
        ),
    )


@router.get("/blink/modes")
def blink_modes(services: Annotated[Services, Depends(get_services)]) -> dict:
    """Which blink modes and named local FITS pairs this server offers."""
    local_profiles = services.blink.available_profiles()
    return {
        "dynamic_enabled": bool(services.settings.blink_dynamic_enabled and services.dynamic is not None),
        "local_demo_available": bool(local_profiles),
        "local_profiles": local_profiles,
    }


@router.get("/blink/dynamic", response_model=DynamicBlinkResponse, response_model_exclude_none=True)
def blink_dynamic(ra: Ra, dec: Dec, services: Annotated[Services, Depends(get_services)], fov_deg: DynFov = None, wavelength_um: DynWavelength = None, detector: DynDetector = None) -> DynamicBlinkResponse:
    """Wavelength-matched two-epoch SPHEREx cutouts for any position the archive covers (IRSA discovery + cutouts)."""
    if not services.settings.blink_dynamic_enabled or services.dynamic is None:
        raise InvalidParameters("Archive (dynamic) blink analysis is disabled on this server.")
    return _dynamic_response(services.dynamic.analyse(ra, dec, fov_deg, wavelength_um=wavelength_um, detector=detector), services.settings)


@router.get("/blink/dynamic/images/{frame_id}.png", response_class=Response, responses={200: {"content": {"image/png": {}}}})
def blink_dynamic_image(
    frame_id: Annotated[str, Path(pattern=r"^\d{4}-\d{2}$")], ra: Ra, dec: Dec, services: Annotated[Services, Depends(get_services)], fov_deg: DynFov = None, wavelength_um: DynWavelength = None, detector: DynDetector = None,
) -> Response:
    if services.dynamic is None:
        raise InvalidParameters("Archive (dynamic) blink analysis is disabled on this server.")
    png = services.dynamic.image(ra, dec, fov_deg, frame_id, wavelength_um=wavelength_um, detector=detector)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": IMAGE_CACHE_CONTROL})
