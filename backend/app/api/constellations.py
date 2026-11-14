from typing import Annotated

from fastapi import APIRouter, Query

from ..models.responses import ConstellationResponse
from ..services.constellations import constellation_at

router = APIRouter(tags=['constellations'])


@router.get('/constellations/at', response_model=ConstellationResponse)
def at(
    ra: Annotated[float, Query(ge=0, lt=360, allow_inf_nan=False)],
    dec: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False)],
) -> ConstellationResponse:
    """IAU membership via Astropy/Roman (1987); local CDS VI/49 outline in ICRS.

    No remote calls or imagery coverage requirements. Boundaries are visual guides.
    """
    return constellation_at(ra, dec)
