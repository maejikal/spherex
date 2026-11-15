from __future__ import annotations

from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response

import calendar
from pathlib import Path as FsPath

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

IMAGE_CACHE_CONTROL = "public, max-age=3600"


def _image_url(frame_id: str, ra: float, dec: float, size: int) -> str:
    return f"/api/blink/images/{frame_id}.png?" + urlencode({"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "size": size})


def _to_response(result: BlinkResult) -> BlinkResponse:
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
                image_url=_image_url(info.frame_id, cutouts.ra, cutouts.dec, cutouts.size),
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
def blink_cutouts(ra: Ra, dec: Dec, services: Annotated[Services, Depends(get_services)], size: Size = None) -> BlinkResponse:
    """Aligned May/December SPHEREx cutouts of one sky position, from the two configured local FITS files."""
    return _to_response(services.blink.cutouts(ra, dec, size))


@router.get("/blink/images/{frame_id}.png", response_class=Response, responses={200: {"content": {"image/png": {}}}})
def blink_image(
    frame_id: Annotated[str, Path(pattern=r"^\d{4}-\d{2}$")],
    ra: Ra,
    dec: Dec,
    services: Annotated[Services, Depends(get_services)],
    size: Size = None,
) -> Response:
    png = services.blink.image(ra, dec, size, frame_id)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": IMAGE_CACHE_CONTROL})


# --- Dynamic (NASA/IPAC archive) mode ------------------------------------------------------------------

DynFov = Annotated[float | None, Query(gt=0, le=10, allow_inf_nan=False, description="Square field of view in degrees (default 0.1; 0.02-0.5)")]


def _dynamic_image_url(fid: str, ra: float, dec: float, fov: float) -> str:
    return f"/api/blink/dynamic/images/{fid}.png?" + urlencode({"ra": f"{ra:.6f}", "dec": f"{dec:.6f}", "fov_deg": f"{fov:g}"})


def _dynamic_response(result: DynamicResult, settings) -> DynamicBlinkResponse:  # noqa: ANN001 - Settings
    frames = []
    for f, background in zip(result.frames, result.display.background):
        obs = f.cutout.obs
        year, month = int(obs.iso_date[:4]), int(obs.iso_date[5:7])
        valid_wl = f.wavelength_map[f.valid & (f.wavelength_map == f.wavelength_map)]
        frames.append(BlinkFrame(
            id=frame_id(f), label=f"{calendar.month_name[month]} {year}", date=obs.iso_date, date_obs=f.cutout.date_obs or obs.iso_date,
            mjd=obs.mjd, obsid=obs.obs_id, detector=int(obs.detector[1:]), image_url=_dynamic_image_url(frame_id(f), result.ra, result.dec, result.fov_deg),
            coverage_fraction=round(f.good_fraction, 4),
            wavelength_um=WavelengthRange(min=float(valid_wl.min()), max=float(valid_wl.max()), mean=f.centre_wavelength_um) if valid_wl.size else None,
            background_mjy_sr=background, unit="MJy / sr", bandwidth_um=f.centre_bandwidth_um, geometric_coverage=round(f.geometric_coverage, 4),
            suspect_fraction=round(f.suspect_fraction, 4), source_fraction=round(f.source_fraction, 4), calibration_version=f.cutout.calibration.version,
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
        fov_deg=result.fov_deg, rotation_deg=result.rotation_deg, wcs=result.wcs_header, geometric_coverage=round(result.common_geometric_coverage, 4),
        selection=PairSelectionInfo(
            predicted_gap_nm=round(pair.gap_nm, 3), actual_gap_nm=round(result.exact_gap_nm, 3), actual_gap_over_bandwidth=round(result.exact_gap_over_bandwidth, 4),
            field_gap_nm=round(result.field_gap_nm, 3), bandwidth_difference_fraction=round(pair.bandwidth_difference, 4),
            epoch_separation_days=round(pair.epoch_separation_days, 2), candidates_tried=result.candidates_tried, rejected_candidates=result.rejected,
            thresholds={"max_pair_gap_nm": settings.max_pair_gap_nm, "max_gap_over_bandwidth": settings.max_gap_over_bandwidth,
                        "max_field_gap_over_bandwidth": settings.max_field_gap_over_bandwidth, "min_common_good_fraction": settings.min_common_good_fraction},
        ),
        provenance=Provenance(
            source="NASA/IPAC Infrared Science Archive (IRSA)", collection=result.collection, release=result.release,
            archive_search="SIA2 position search, then IBE FITS cutouts",
            interpolation="Bilinear, mask-aware; flag bitmasks are sampled nearest-neighbour and never interpolated",
            flag_policy="Hard-invalid: OVERFLOW, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD, NONLINEAR, STREAK, BLOOM, SNOWBALL, plus non-finite or non-positive variance. "
                        "Caution (kept, reported): TRANSIENT, PERSIST, OUTLIER, HALO. Informational (kept): SOURCE, FULLSAMPLE.",
        ),
    )


@router.get("/blink/modes")
def blink_modes(services: Annotated[Services, Depends(get_services)]) -> dict:
    """Which blink modes this server offers: archive-driven (dynamic) and/or the two fixed local files."""
    local = [FsPath(p).expanduser().is_file() for p in services.settings.blink_fits_files]
    return {"dynamic_enabled": bool(services.settings.blink_dynamic_enabled and services.dynamic is not None), "local_demo_available": bool(local) and all(local)}


@router.get("/blink/dynamic", response_model=DynamicBlinkResponse, response_model_exclude_none=True)
def blink_dynamic(ra: Ra, dec: Dec, services: Annotated[Services, Depends(get_services)], fov_deg: DynFov = None) -> DynamicBlinkResponse:
    """Wavelength-matched two-epoch SPHEREx cutouts for any position the archive covers (IRSA discovery + cutouts)."""
    if not services.settings.blink_dynamic_enabled or services.dynamic is None:
        raise InvalidParameters("Archive (dynamic) blink analysis is disabled on this server.")
    return _dynamic_response(services.dynamic.analyse(ra, dec, fov_deg), services.settings)


@router.get("/blink/dynamic/images/{frame_id}.png", response_class=Response, responses={200: {"content": {"image/png": {}}}})
def blink_dynamic_image(
    frame_id: Annotated[str, Path(pattern=r"^\d{4}-\d{2}$")], ra: Ra, dec: Dec, services: Annotated[Services, Depends(get_services)], fov_deg: DynFov = None,
) -> Response:
    if services.dynamic is None:
        raise InvalidParameters("Archive (dynamic) blink analysis is disabled on this server.")
    png = services.dynamic.image(ra, dec, fov_deg, frame_id)
    return Response(content=png, media_type="image/png", headers={"Cache-Control": IMAGE_CACHE_CONTROL})
