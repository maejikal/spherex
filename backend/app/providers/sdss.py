"""SDSS DR18 providers: JPEG image cutouts and a SkyServer SQL catalogue search.

Behaviour verified against the live service (see backend/README.md, "Verified upstream behaviour"):

* ``getjpeg`` accepts ``ra``, ``dec``, ``scale`` [0.015, 60] arcsec/pixel, ``width``/``height`` [64, 2048]
  and ``opt=G`` for a coordinate grid.
* Outside the imaging footprint it answers **HTTP 404 with an ``image/jpeg`` body** whose pixels read
  "Requested (ra, dec) is outside the SDSS footprint." That status is the authoritative coverage
  signal; pixel brightness is never inspected.
* Malformed input is answered with HTTP 400 and a JSON body.
"""

from __future__ import annotations

import asyncio
import io
import json
import math
from dataclasses import dataclass
from typing import Any

import httpx
from PIL import Image, UnidentifiedImageError

from ..config import Settings
from ..models.errors import (
    CatalogueUnavailable,
    InvalidParameters,
    NoCoverage,
    UpstreamInvalidResponse,
    UpstreamTimeout,
    UpstreamUnavailable,
)
from ..utils.coordinates import angular_separation_arcsec
from .base import CatalogueMatch, CutoutRequest, CutoutResult, ImageMetadata, SurveyInfo
from .http import UpstreamClient

JPEG_MAGIC = b"\xff\xd8\xff"

# Documented SDSS image-cutout limits (verified live; the 400 body states them).
SDSS_MIN_SCALE = 0.015
SDSS_MAX_SCALE = 60.0
SDSS_MIN_DIM = 64
SDSS_MAX_DIM = 2048

# SDSS PhotoObj "type" codes (https://skyserver.sdss.org/dr18/en/help/browser/enum.aspx, PhotoType).
PHOTO_TYPE_NAMES = {0: "Unknown", 3: "Galaxy", 6: "Star"}


@dataclass(frozen=True, slots=True)
class UpstreamPlan:
    scale: float  # arcsec/pixel actually requested from SDSS
    width: int
    height: int
    # Requested field of view expressed in *upstream* pixels (may be fractional / smaller than the image).
    fov_w_px: float
    fov_h_px: float

    def needs_reshape(self, req: CutoutRequest) -> bool:
        return (
            self.width != req.width
            or self.height != req.height
            or abs(self.fov_w_px - self.width) > 1e-6
            or abs(self.fov_h_px - self.height) > 1e-6
        )


def plan_upstream_request(req: CutoutRequest) -> UpstreamPlan:
    """Choose an upstream scale/size that covers exactly the requested field of view.

    The frontend may ask for scales up to 120"/px and sizes below 64 px, both outside SDSS limits.
    We request an image *inside* SDSS limits that contains the same sky area, then centre-crop and/or
    resample it to the requested size (see ``_reshape``).
    """
    fov_w = req.width * req.scale
    fov_h = req.height * req.scale
    scale = min(req.scale, SDSS_MAX_SCALE)
    up_w = math.ceil(fov_w / scale - 1e-9)
    up_h = math.ceil(fov_h / scale - 1e-9)
    if max(up_w, up_h) > SDSS_MAX_DIM:
        scale = max(fov_w, fov_h) / SDSS_MAX_DIM
        if scale > SDSS_MAX_SCALE:
            raise InvalidParameters(
                "Requested field of view is too large for the SDSS cutout service; "
                "zoom in or request a smaller image."
            )
        up_w = max(1, round(fov_w / scale))
        up_h = max(1, round(fov_h / scale))
    return UpstreamPlan(
        scale=scale,
        width=min(SDSS_MAX_DIM, max(up_w, SDSS_MIN_DIM)),
        height=min(SDSS_MAX_DIM, max(up_h, SDSS_MIN_DIM)),
        fov_w_px=fov_w / scale,
        fov_h_px=fov_h / scale,
    )


def _reshape(content: bytes, plan: UpstreamPlan, width: int, height: int) -> bytes:
    """Centre-crop the upstream image to the requested field of view and resample to ``width x height``."""
    with Image.open(io.BytesIO(content)) as image:
        image.load()
        rgb = image.convert("RGB")
    left = max(0.0, (rgb.width - plan.fov_w_px) / 2.0)
    top = max(0.0, (rgb.height - plan.fov_h_px) / 2.0)
    right = min(float(rgb.width), left + plan.fov_w_px)
    bottom = min(float(rgb.height), top + plan.fov_h_px)
    out = rgb.resize((width, height), Image.Resampling.LANCZOS, box=(left, top, right, bottom))
    buffer = io.BytesIO()
    out.save(buffer, format="JPEG", quality=92)
    return buffer.getvalue()


def _validate_jpeg(content: bytes) -> None:
    if not content:
        raise UpstreamInvalidResponse("SDSS returned an empty image.")
    if not content.startswith(JPEG_MAGIC):
        raise UpstreamInvalidResponse("SDSS did not return a JPEG image.")
    try:
        with Image.open(io.BytesIO(content)) as image:
            image.load()
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise UpstreamInvalidResponse("SDSS returned a corrupt JPEG image.") from exc


class SDSSImageProvider:
    survey = SurveyInfo(
        id="sdss-dr18",
        name="Sloan Digital Sky Survey",
        release="DR18",
        available=True,
        description="SDSS DR18 colour JPEG cutouts (u/g/r/i/z composite). Not all-sky: imaging footprint only.",
    )

    def __init__(self, upstream: UpstreamClient, settings: Settings) -> None:
        self._upstream = upstream
        self._settings = settings

    async def get_cutout(self, request: CutoutRequest) -> CutoutResult:
        plan = plan_upstream_request(request)
        params = {
            "ra": f"{request.ra:.8f}",
            "dec": f"{request.dec:.8f}",
            "scale": f"{plan.scale:.6f}",
            "width": str(plan.width),
            "height": str(plan.height),
        }
        if request.grid:
            params["opt"] = "G"

        response = await self._upstream.get(
            self._settings.sdss_cutout_url,
            params=params,
            max_bytes=self._settings.max_upstream_image_bytes,
            accept="image/jpeg",
        )

        if response.status == 404 and response.content_type == "image/jpeg":
            # Verified SDSS behaviour: 404 + footprint-notice JPEG == no imaging at this position.
            raise NoCoverage("No SDSS imaging is available for this sky region.")
        if response.status != 200:
            raise UpstreamInvalidResponse(f"SDSS cutout service returned HTTP {response.status}.")
        if response.content_type != "image/jpeg":
            raise UpstreamInvalidResponse("SDSS cutout service did not return image/jpeg.")

        await asyncio.to_thread(_validate_jpeg, response.body)

        content = response.body
        resampled = plan.needs_reshape(request)
        if resampled:
            content = await asyncio.to_thread(_reshape, response.body, plan, request.width, request.height)

        return CutoutResult(
            content=content,
            media_type="image/jpeg",
            metadata=ImageMetadata(
                source_url=str(httpx.URL(self._settings.sdss_cutout_url, params=params)),
                coordinate_frame="J2000",
                survey_release="DR18",
                resampled=resampled,
            ),
        )


class SDSSCatalogueProvider:
    """Nearby PhotoObj sources via the documented SkyServer ``SqlSearch`` endpoint.

    The SQL text is built here from validated numbers only; the browser never supplies SQL.
    """

    source = "SDSS DR18"

    def __init__(self, upstream: UpstreamClient, settings: Settings) -> None:
        self._upstream = upstream
        self._settings = settings

    @staticmethod
    def build_query(ra: float, dec: float, radius_arcsec: float, limit: int) -> str:
        for value in (ra, dec, radius_arcsec):
            if not math.isfinite(value):
                raise InvalidParameters("Search coordinates must be finite numbers.")
        radius_arcmin = radius_arcsec / 60.0
        top = int(limit)
        return (
            f"SELECT TOP {top} p.objID, p.ra, p.dec, p.type "
            f"FROM dbo.fGetNearbyObjEq({ra:.9f},{dec:.9f},{radius_arcmin:.6f}) n "
            f"JOIN PhotoObjAll p ON p.objID = n.objID "
            f"WHERE p.mode = 1 AND p.type IN (0, 3, 6) "
            f"ORDER BY n.distance"
        )

    async def nearby(self, ra: float, dec: float, radius_arcsec: float, limit: int) -> list[CatalogueMatch]:
        query = self.build_query(ra, dec, radius_arcsec, limit)
        try:
            response = await self._upstream.get(
                self._settings.sdss_sql_url,
                params={"cmd": query, "format": "json"},
                max_bytes=self._settings.max_upstream_json_bytes,
                accept="application/json",
            )
        except (UpstreamTimeout, UpstreamUnavailable, UpstreamInvalidResponse) as exc:
            raise CatalogueUnavailable(f"The SDSS catalogue service is unavailable: {exc.message}") from exc

        rows = self._parse(response.status, response.body)
        matches = []
        for row in rows:
            m_ra, m_dec = float(row["ra"]), float(row["dec"])
            matches.append(
                CatalogueMatch(
                    id=str(row["objID"]),
                    ra=m_ra % 360.0,
                    dec=m_dec,
                    separation_arcsec=angular_separation_arcsec(ra, dec, m_ra, m_dec),
                    object_type=PHOTO_TYPE_NAMES.get(int(row["type"])),
                    source=self.source,
                )
            )
        matches.sort(key=lambda m: m.separation_arcsec)
        return [m for m in matches if m.separation_arcsec <= radius_arcsec + 1e-6][:limit]

    @staticmethod
    def _parse(status: int, body: bytes) -> list[dict[str, Any]]:
        try:
            data = json.loads(body)
        except ValueError as exc:
            raise CatalogueUnavailable("The SDSS catalogue service returned malformed JSON.") from exc
        if status != 200 or (isinstance(data, dict) and "ErrorCode" in data):
            raise CatalogueUnavailable("The SDSS catalogue query failed.")
        if not isinstance(data, list):
            raise CatalogueUnavailable("The SDSS catalogue service returned an unexpected structure.")
        table = next((t for t in data if isinstance(t, dict) and t.get("TableName") == "Table1"), None)
        if table is None or not isinstance(table.get("Rows"), list):
            # An empty result set is reported by SDSS without Table1 rows; be explicit about what we accept.
            raise CatalogueUnavailable("The SDSS catalogue service returned an unexpected structure.")
        rows = []
        for row in table["Rows"]:
            try:
                ra, dec, _id, typ = row["ra"], row["dec"], row["objID"], row["type"]
                if not (math.isfinite(float(ra)) and math.isfinite(float(dec))):
                    raise ValueError
                int(typ)
            except (KeyError, TypeError, ValueError) as exc:
                raise CatalogueUnavailable("The SDSS catalogue returned an incomplete row.") from exc
            rows.append(row)
        return rows
