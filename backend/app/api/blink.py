from __future__ import annotations

from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response

from ..models.blink import BlinkCoordinates, BlinkDisplay, BlinkFrame, BlinkResponse, WavelengthRange
from ..services.blink_service import BlinkResult
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
