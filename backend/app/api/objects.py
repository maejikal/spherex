from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from ..models.responses import MatchOut, NearbyResponse, ResolveResponse
from .deps import Services, get_services

router = APIRouter(tags=["objects"])


@router.get("/objects/resolve", response_model=ResolveResponse, response_model_exclude_none=True)
async def resolve(
    services: Annotated[Services, Depends(get_services)],
    name: Annotated[str, Query(description="Astronomical object name, e.g. 'M31'")],
) -> ResolveResponse:
    resolved = await services.resolver.resolve(name)
    return ResolveResponse(
        name=resolved.name,
        ra=resolved.ra,
        dec=resolved.dec,
        source=resolved.source,
        object_type=resolved.object_type,
    )


@router.get("/objects/nearby", response_model=NearbyResponse, response_model_exclude_none=True)
async def nearby(
    services: Annotated[Services, Depends(get_services)],
    ra: Annotated[float, Query(ge=0, lt=360, allow_inf_nan=False)],
    dec: Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False)],
    radius_arcsec: Annotated[float, Query(allow_inf_nan=False)] = 30.0,
    limit: int = 8,
) -> NearbyResponse:
    matches = await services.catalogue.nearby(ra, dec, radius_arcsec, limit)
    return NearbyResponse(
        matches=[
            MatchOut(
                id=m.id,
                name=m.name,
                ra=m.ra,
                dec=m.dec,
                object_type=m.object_type,
                separation_arcsec=round(m.separation_arcsec, 3),
                source=m.source,
            )
            for m in matches
        ]
    )
