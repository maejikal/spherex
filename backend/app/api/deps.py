from __future__ import annotations

from dataclasses import dataclass

import httpx
from fastapi import Request

from ..providers.sdss import SDSSImageProvider
from ..providers.sesame import SesameResolver
from ..services.catalogue_search import CatalogueSearchService
from ..services.image_service import ImageService
from ..services.object_resolver import ObjectResolverService
from ..services.target_service import TargetService


@dataclass
class Services:
    http: httpx.AsyncClient
    images: ImageService
    sdss: SDSSImageProvider
    sesame: SesameResolver
    resolver: ObjectResolverService
    catalogue: CatalogueSearchService
    targets: TargetService


def get_services(request: Request) -> Services:
    return request.app.state.services
