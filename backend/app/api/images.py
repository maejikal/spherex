from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response

from ..providers.base import CutoutRequest
from ..utils.coordinates import normalize_ra
from .deps import Services, get_services

router = APIRouter(tags=["images"])

DEFAULT_SURVEY = "sdss-dr18"


@router.get(
    "/images/cutout",
    response_class=Response,
    responses={200: {"content": {"image/jpeg": {}}, "description": "Raw JPEG cutout"}},
)
async def cutout(
    services: Annotated[Services, Depends(get_services)],
    ra: Annotated[float, Query(ge=0, lt=360, allow_inf_nan=False, description="Right ascension, decimal degrees (ICRS/J2000)")],
    dec: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False, description="Declination, decimal degrees")],
    scale: Annotated[float, Query(ge=0.05, le=120, allow_inf_nan=False, description="Arcseconds per pixel")] = 0.4,
    width: Annotated[int, Query(ge=1, le=1536)] = 512,
    height: Annotated[int, Query(ge=1, le=1536)] = 512,
    survey: str = DEFAULT_SURVEY,
    grid: Annotated[int, Query(ge=0, le=1)] = 0,
) -> Response:
    request = CutoutRequest(
        ra=normalize_ra(round(ra, 6)),
        dec=round(dec, 6),
        scale=round(scale, 6),
        width=width,
        height=height,
        grid=bool(grid),
    )
    result, hit = await services.images.get_cutout(survey, request)

    meta = result.metadata
    headers = {
        "Cache-Control": "public, max-age=3600",
        "X-Backend-Cache": "HIT" if hit else "MISS",
    }
    for name, value in (
        ("X-Source-URL", meta.source_url),
        ("X-Projection", meta.projection),
        ("X-Coordinate-Frame", meta.coordinate_frame),
        ("X-Observation-Time", meta.observation_time),
        ("X-Wavelength", meta.wavelength),
        ("X-Survey-Release", meta.survey_release),
    ):
        if value:
            headers[name] = value
    if meta.resampled:
        headers["X-Image-Resampled"] = "1"
    return Response(content=result.content, media_type=result.media_type, headers=headers)
