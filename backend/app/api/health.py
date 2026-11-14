from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends

from ..models.errors import AppError
from ..models.responses import DependencyHealth, DependencyStatus, HealthResponse
from .deps import Services, get_services

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    """Liveness of this service only. Deliberately independent of IRSA/CDS/SIMBAD availability."""
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
        probe("irsa-spherex-hips", services.spherex.describe()),
        probe("cds-sesame", services.sesame.resolve("M31")),
        probe("simbad", services.catalogue.nearby(10.6847083, 41.26875, 5.0, 1)),
    )
    return DependencyHealth(status="ok" if all(r.ok for r in results) else "degraded", dependencies=list(results))
