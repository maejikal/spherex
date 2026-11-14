"""CDS Sesame name resolver (SIMBAD / NED / VizieR).

Verified live: ``GET <base>/-oxp/SNV?<name>`` returns XML. ``cds.unistra.fr`` answers with a 302 to a
regional mirror (for example ``vizier.idia.ac.za``), so redirects are followed manually and only
to hosts on an explicit allowlist. An unresolved name yields a ``<Target>`` with an ``<INFO>`` message
and no ``<Resolver>`` element.
"""

from __future__ import annotations

import math

import httpx
from urllib.parse import quote, urlsplit

import defusedxml.ElementTree as SafeET
from defusedxml.common import DefusedXmlException
from xml.etree.ElementTree import ParseError

from ..config import Settings
from ..models.errors import ObjectNotFound, UpstreamInvalidResponse
from ..utils.coordinates import normalize_ra
from .base import ResolvedName
from .http import UpstreamClient, UpstreamResponse

MAX_REDIRECTS = 3

_SOURCE_NAMES = {"S": "SIMBAD", "N": "NED", "V": "VizieR"}


def _source_label(resolver_name: str | None) -> str:
    # Resolver names look like "S=Simbad, IDIA (via url)" / "N=NED ..." / "V=VizieR ...".
    if resolver_name and len(resolver_name) > 1 and resolver_name[1] == "=":
        label = _SOURCE_NAMES.get(resolver_name[0])
        if label:
            return f"CDS Sesame ({label})"
    return "CDS Sesame"


class SesameResolver:
    def __init__(self, upstream: UpstreamClient, settings: Settings) -> None:
        self._upstream = upstream
        self._settings = settings

    async def resolve(self, name: str) -> ResolvedName:
        response = await self._fetch(name)
        return self.parse(response.body, fallback_name=name)

    async def _fetch(self, name: str) -> UpstreamResponse:
        # Sesame takes the target as a bare query string; quote() encodes spaces, apostrophes and Unicode.
        url = f"{self._settings.sesame_url.rstrip('/')}/-oxp/SNV?{quote(name, safe='')}"
        allowed = {h.lower() for h in self._settings.sesame_allowed_hosts}
        for _ in range(MAX_REDIRECTS + 1):
            host = (urlsplit(url).hostname or "").lower()
            if urlsplit(url).scheme != "https" or host not in allowed:
                raise UpstreamInvalidResponse("Name resolver redirected to an untrusted host.")
            response = await self._upstream.get(
                url, max_bytes=self._settings.max_upstream_json_bytes, accept="text/xml, application/xml, */*"
            )
            if response.status in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    raise UpstreamInvalidResponse("Name resolver sent a redirect without a location.")
                url = str(httpx.URL(url).join(location))
                continue
            if response.status != 200:
                raise UpstreamInvalidResponse(f"Name resolver returned HTTP {response.status}.")
            return response
        raise UpstreamInvalidResponse("Name resolver redirected too many times.")

    @staticmethod
    def parse(body: bytes, fallback_name: str) -> ResolvedName:
        try:
            root = SafeET.fromstring(body)
        except (ParseError, DefusedXmlException, ValueError) as exc:
            raise UpstreamInvalidResponse("Name resolver returned malformed XML.") from exc
        if root.tag != "Sesame":
            raise UpstreamInvalidResponse("Name resolver returned an unexpected document.")

        for resolver in root.iter("Resolver"):
            ra_text = (resolver.findtext("jradeg") or "").strip()
            dec_text = (resolver.findtext("jdedeg") or "").strip()
            if not ra_text or not dec_text:
                continue
            try:
                ra, dec = float(ra_text), float(dec_text)
            except ValueError as exc:
                raise UpstreamInvalidResponse("Name resolver returned non-numeric coordinates.") from exc
            if not (math.isfinite(ra) and math.isfinite(dec)) or not -90.0 <= dec <= 90.0:
                raise UpstreamInvalidResponse("Name resolver returned out-of-range coordinates.")
            resolved_name = (resolver.findtext("oname") or "").strip() or fallback_name
            # SIMBAD marks common-name identifiers with a "NAME " catalogue prefix; it is not part of the name.
            if resolved_name.startswith("NAME ") and len(resolved_name) > 5:
                resolved_name = resolved_name[5:]
            object_type = (resolver.findtext("otype") or "").strip() or None
            return ResolvedName(
                name=resolved_name,
                ra=normalize_ra(ra),
                dec=dec,
                source=_source_label(resolver.get("name")),
                object_type=object_type,
            )

        raise ObjectNotFound(f"No astronomical object named '{fallback_name}' was found.")
