from __future__ import annotations

from fastapi import APIRouter, Depends

from ..models.responses import SurveyOut, SurveysResponse
from .deps import Services, get_services

router = APIRouter(tags=["surveys"])


@router.get("/surveys", response_model=SurveysResponse)
async def list_surveys(services: Services = Depends(get_services)) -> SurveysResponse:
    """Surveys with a working image provider. SPHEREx is not listed until it is implemented."""
    return SurveysResponse(
        surveys=[
            SurveyOut(id=s.id, name=s.name, release=s.release, available=s.available, description=s.description)
            for s in services.images.surveys()
        ]
    )
