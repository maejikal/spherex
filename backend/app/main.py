"""FastAPI application factory for the Sky Explorer backend."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api import blink, constellations, health, objects, surveys, targets
from .api.deps import Services
from .config import Settings, get_settings
from .models.errors import AppError
from .providers.http import UpstreamClient
from .providers.sesame import SesameResolver
from .providers.simbad import SimbadCatalogue
from .providers.spherex import SphereXHiPSProvider
from .services.blink_service import BlinkService
from .services.catalogue_search import CatalogueSearchService
from .services.object_resolver import ObjectResolverService
from .services.target_service import DEFAULT_DATA_FILE, TargetService

log = logging.getLogger("skyexplorer")



def _error_response(code: str, message: str, status: int, headers: dict[str, str] | None = None) -> JSONResponse:
    merged = {"Cache-Control": "no-store", **(headers or {})}
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=merged)


def build_services(settings: Settings, targets_file: Path = DEFAULT_DATA_FILE) -> Services:
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=settings.connect_timeout, read=settings.read_timeout, write=5.0, pool=5.0),
        headers={"User-Agent": settings.user_agent},
        follow_redirects=False,
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
    )
    semaphore = asyncio.Semaphore(settings.max_upstream_concurrency)

    def upstream(service: str) -> UpstreamClient:
        return UpstreamClient(
            client, service=service, retries=settings.max_retries, backoff_base=settings.retry_backoff_base, semaphore=semaphore
        )

    spherex = SphereXHiPSProvider(upstream("SPHEREx HiPS (IRSA)"), settings)
    sesame = SesameResolver(upstream("CDS Sesame"), settings)
    return Services(
        http=client,
        spherex=spherex,
        sesame=sesame,
        resolver=ObjectResolverService(sesame, settings),
        catalogue=CatalogueSearchService(SimbadCatalogue(upstream("SIMBAD"), settings), settings),
        targets=TargetService(targets_file),
        blink=BlinkService(settings),
    )


def create_app(settings: Settings | None = None, targets_file: Path = DEFAULT_DATA_FILE) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        services = build_services(settings, targets_file)
        app.state.services = services
        try:
            yield
        finally:
            await services.http.aclose()

    app = FastAPI(
        title="Sky Explorer API",
        version="0.1.0",
        description="Backend scientific services for the Sky Explorer frontend: SPHEREx survey metadata, "
        "CDS Sesame name resolution, SIMBAD object lookup and verified SPHEREx targets. Sky imagery itself is "
        "rendered in the browser by Aladin Lite from the NASA/IPAC IRSA SPHEREx HiPS. No data is fabricated.",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET"],
        allow_headers=["Accept", "Content-Type"],
    )

    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        if exc.status_code >= 500:
            log.warning("%s: %s", exc.code, exc.message, exc_info=exc.__cause__)
        return _error_response(exc.code, exc.message, exc.status_code, exc.headers)

    @app.exception_handler(RequestValidationError)
    async def handle_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        parts = []
        for err in exc.errors():
            loc = ".".join(str(p) for p in err["loc"] if p != "query")
            parts.append(f"{loc}: {err['msg']}")
        return _error_response("invalid_parameters", "Invalid request parameters. " + "; ".join(parts), 422)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else "http_error"
        return _error_response(code, str(exc.detail), exc.status_code)

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s", request.url.path, exc_info=exc)
        return _error_response("internal_error", "An unexpected error occurred.", 500)

    for router in (health.router, surveys.router, objects.router, targets.router, constellations.router, blink.router):
        app.include_router(router, prefix="/api")

    return app


app = create_app()
