"""SIMBAD cone search through its TAP service (ADQL), used for nearby-object inspection.

Verified live (2026-11-14): ``POST <tap>/sync`` with ``request=doQuery&lang=adql&format=json`` returns
``{"metadata": [...], "data": [[...]]}``; ADQL errors come back as a VOTable with ``QUERY_STATUS=ERROR``.
The CDS primary host was serving an HTML "page unavailable" document at verification time, so
endpoints are tried in order with the official Harvard mirror as fallback.

Results are SIMBAD records, not SPHEREx detections, and are labelled that way.
"""

from __future__ import annotations

import json
import math

from ..config import Settings
from ..models.errors import (
    CatalogueUnavailable,
    InvalidParameters,
    UpstreamInvalidResponse,
    UpstreamTimeout,
    UpstreamUnavailable,
)
from ..utils.coordinates import angular_separation_arcsec
from .base import CatalogueMatch
from .http import UpstreamClient

SOURCE = "SIMBAD"


class SimbadCatalogue:
    def __init__(self, upstream: UpstreamClient, settings: Settings) -> None:
        self._upstream = upstream
        self._settings = settings

    @staticmethod
    def build_query(ra: float, dec: float, radius_arcsec: float, limit: int) -> str:
        """ADQL built only from validated numbers; the browser never supplies query text."""
        for value in (ra, dec, radius_arcsec):
            if not math.isfinite(value):
                raise InvalidParameters("Search coordinates must be finite numbers.")
        radius_deg = radius_arcsec / 3600.0
        return (
            f"SELECT TOP {int(limit)} b.main_id, b.ra, b.dec, b.otype, o.description AS otype_description, "
            f"DISTANCE(POINT('ICRS', b.ra, b.dec), POINT('ICRS', {ra:.9f}, {dec:.9f})) AS dist "
            f"FROM basic AS b LEFT JOIN otypedef AS o ON b.otype = o.otype "
            f"WHERE b.ra IS NOT NULL AND b.dec IS NOT NULL AND "
            f"CONTAINS(POINT('ICRS', b.ra, b.dec), CIRCLE('ICRS', {ra:.9f}, {dec:.9f}, {radius_deg:.9f})) = 1 "
            f"ORDER BY dist"
        )

    async def nearby(self, ra: float, dec: float, radius_arcsec: float, limit: int) -> list[CatalogueMatch]:
        query = self.build_query(ra, dec, radius_arcsec, limit)
        last_error: Exception | None = None
        for endpoint in self._settings.simbad_tap_urls:
            try:
                rows = await self._query(endpoint, query)
            except (UpstreamTimeout, UpstreamUnavailable, UpstreamInvalidResponse) as exc:
                last_error = exc
                continue
            return self._matches(rows, ra, dec, radius_arcsec, limit)
        raise CatalogueUnavailable("SIMBAD could not be reached or returned an unusable response.") from last_error

    async def _query(self, endpoint: str, query: str) -> list[list]:
        response = await self._upstream.get(
            endpoint,
            params={"request": "doQuery", "lang": "adql", "format": "json", "query": query},
            max_bytes=self._settings.max_upstream_text_bytes,
            accept="application/json",
        )
        if response.status != 200:
            raise UpstreamInvalidResponse(f"SIMBAD returned HTTP {response.status}.")
        try:
            data = json.loads(response.body)
        except ValueError as exc:  # HTML error page or VOTable error document
            raise UpstreamInvalidResponse("SIMBAD returned a non-JSON response.") from exc
        if not isinstance(data, dict) or not isinstance(data.get("data"), list) or not isinstance(data.get("metadata"), list):
            raise UpstreamInvalidResponse("SIMBAD returned an unexpected JSON structure.")
        names = [m.get("name") if isinstance(m, dict) else None for m in data["metadata"]]
        wanted = ("main_id", "ra", "dec", "otype", "otype_description")
        if "main_id" not in names:
            # Zero-row results may omit columns only for requests that selected nothing useful; our
            # query always selects main_id, so a missing column means the response is not ours.
            raise UpstreamInvalidResponse("SIMBAD response is missing expected columns.")
        index = {n: names.index(n) for n in wanted if n in names}
        rows = []
        for row in data["data"]:
            try:
                rows.append([row[index[k]] if k in index else None for k in wanted])
            except (IndexError, TypeError) as exc:
                raise UpstreamInvalidResponse("SIMBAD returned a malformed row.") from exc
        return rows

    def _matches(self, rows: list[list], ra: float, dec: float, radius_arcsec: float, limit: int) -> list[CatalogueMatch]:
        matches: list[CatalogueMatch] = []
        for main_id, m_ra, m_dec, otype, description in rows:
            try:
                m_ra, m_dec = float(m_ra), float(m_dec)
            except (TypeError, ValueError):
                continue  # a record without usable coordinates cannot be placed on the sky
            if not (math.isfinite(m_ra) and math.isfinite(m_dec)) or not isinstance(main_id, str) or not main_id.strip():
                continue
            name = " ".join(main_id.split())
            if name.startswith("NAME ") and len(name) > 5:  # SIMBAD marks common names with a "NAME " prefix
                name = name[5:]
            label = description if isinstance(description, str) and description.strip() else (otype if isinstance(otype, str) and otype else None)
            matches.append(
                CatalogueMatch(
                    id=" ".join(main_id.split()),
                    name=name,
                    ra=m_ra % 360.0,
                    dec=m_dec,
                    separation_arcsec=angular_separation_arcsec(ra, dec, m_ra, m_dec),
                    object_type=label,
                    source=SOURCE,
                )
            )
        matches.sort(key=lambda m: m.separation_arcsec)
        return [m for m in matches if m.separation_arcsec <= radius_arcsec + 1e-6][:limit]
