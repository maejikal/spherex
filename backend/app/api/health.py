from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from ..models.errors import AppError
from ..models.responses import DependencyHealth, DependencyStatus, HealthResponse
from ..providers.base import CutoutRequest
from .deps import Services, get_services

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness of this service only. Deliberately independent of SDSS/CDS availability."""
    return HealthResponse(status="ok")


@router.get("/health/dependencies", response_model=DependencyHealth)
async def dependency_health(services: Services = Depends(get_services)) -> DependencyHealth:
    """Live probes of upstream services (diagnostic; slower, and not used by the frontend)."""

    async def probe(name: str, coro) -> DependencyStatus:
        try:
            await coro
            return DependencyStatus(name=name, ok=True, detail="reachable")
        except AppError as exc:
            return DependencyStatus(name=name, ok=False, detail=f"{exc.code}: {exc.message}")

    results = await asyncio.gather(
        probe("sdss-cutout", services.sdss.get_cutout(CutoutRequest(ra=180.0, dec=0.5, scale=0.4, width=64, height=64))),
        probe("cds-sesame", services.sesame.resolve("M31")),
    )
    return DependencyHealth(status="ok" if all(r.ok for r in results) else "degraded", dependencies=list(results))
