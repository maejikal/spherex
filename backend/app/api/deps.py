from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import Request

from ..providers.spherex import SphereXHiPSProvider
from ..providers.sesame import SesameResolver
from ..services.blink_service import BlinkService
from ..services.catalogue_search import CatalogueSearchService
from ..services.object_resolver import ObjectResolverService
from ..services.target_service import TargetService


@dataclass
class Services:
    http: httpx.AsyncClient
    spherex: SphereXHiPSProvider
    sesame: SesameResolver
    resolver: ObjectResolverService
    catalogue: CatalogueSearchService
    targets: TargetService
    blink: BlinkService


def get_services(request: Request) -> Services:
    return request.app.state.services
