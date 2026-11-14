from __future__ import annotations

from fastapi import APIRouter, Depends

from ..models.responses import ChannelOut, SurveyOut, SurveysResponse
from .deps import Services, get_services

router = APIRouter(tags=["surveys"])


@router.get("/surveys", response_model=SurveysResponse, response_model_exclude_none=True)
async def list_surveys(services: Services = Depends(get_services)) -> SurveysResponse:
    """Verified SPHEREx survey description, read live from the NASA/IPAC HiPS (cached for an hour).

    If IRSA cannot be reached the request fails with ``upstream_unavailable`` rather than listing a
    survey whose availability and channels are unverified. Only SPHEREx is listed.
    """
    info = await services.spherex.describe()
    return SurveysResponse(
        surveys=[
            SurveyOut(
                id=info.id,
                name=info.name,
                release=info.release,
                available=info.available,
                description=info.description,
                data_source=info.data_source,
                hips_url=info.hips_url,
                tile_format=info.tile_format,
                tile_width=info.tile_width,
                max_order=info.max_order,
                coordinate_frame=info.coordinate_frame,
                sky_fraction=info.sky_fraction,
                observation_window_mjd=info.observation_window_mjd,
                channels=[
                    ChannelOut(
                        frame=c.frame, band=c.band, band_channel=c.band_channel,
                        wavelength_um=c.wavelength_um, has_data=c.has_data,
                    )
                    for c in info.channels
                ],
            )
        ]
    )
