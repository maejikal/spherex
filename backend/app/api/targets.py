from __future__ import annotations

from fastapi import APIRouter, Depends

from ..models.responses import RandomTargetResponse, SuggestedTargetsResponse, TargetOut
from ..services.target_service import Target
from .deps import Services, get_services

router = APIRouter(tags=["targets"])


def _out(t: Target) -> TargetOut:
    return TargetOut(id=t.id, name=t.name, ra=t.ra, dec=t.dec, description=t.description)


@router.get("/targets/suggested", response_model=SuggestedTargetsResponse, response_model_exclude_none=True)
async def suggested(services: Services = Depends(get_services)) -> SuggestedTargetsResponse:
    return SuggestedTargetsResponse(targets=[_out(t) for t in services.targets.suggested])


@router.get("/targets/random", response_model=RandomTargetResponse, response_model_exclude_none=True)
async def random_target(services: Services = Depends(get_services)) -> RandomTargetResponse:
    return RandomTargetResponse(target=_out(services.targets.random_target()))
