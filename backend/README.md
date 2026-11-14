# Sky Explorer backend

FastAPI service for the Sky Explorer frontend. It serves **real SDSS DR18 imagery and catalogue data** and
resolves object names through **CDS Sesame**. Nothing astronomical is generated or guessed: if an upstream
cannot answer, the API returns a structured error.

## Run

```zsh
# from the repository root
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

cd backend
../.venv/bin/uvicorn app.main:app --reload          # http://127.0.0.1:8000  (docs: /docs)

# second terminal
cd frontend && npm install && npm run dev            # http://localhost:5173 (proxies /api -> :8000)
```

Tests (no network needed; all upstreams are mocked): `cd backend && ../.venv/bin/python -m pytest`

Configuration is via `SKY_*` environment variables or `backend/.env` (see `.env.example`).

## Endpoints

| Route | Notes |
| --- | --- |
| `GET /api/health` | `{"status":"ok"}`. Independent of SDSS/CDS. |
| `GET /api/health/dependencies` | Diagnostic live probe of SDSS and Sesame (not used by the frontend). |
| `GET /api/surveys` | Only `sdss-dr18`. SPHEREx is not listed until implemented. |
| `GET /api/images/cutout` | `ra, dec` required; `scale=0.4, width=512, height=512, survey=sdss-dr18, grid=0` optional. Returns raw `image/jpeg`. |
| `GET /api/objects/resolve?name=` | CDS Sesame (SIMBAD/NED/VizieR). |
| `GET /api/objects/nearby` | `ra, dec, radius_arcsec=30 (max 120), limit=8 (max 50)`. SDSS SkyServer SQL, built server-side. |
| `GET /api/targets/suggested` | Curated, coverage-verified targets. |
| `GET /api/targets/random` | Random verified field; never the same one twice in a row. |

Errors always look like `{"error": {"code", "message"}}`: `invalid_parameters` (422), `unsupported_survey` (400),
`no_coverage` (404), `object_not_found` (404), `upstream_timeout` (504), `upstream_unavailable` /
`upstream_invalid_response` / `catalogue_unavailable` (502), `internal_error` (500).

Cutout response headers (only when truly known): `X-Source-URL`, `X-Coordinate-Frame` (`J2000`),
`X-Survey-Release` (`DR18`). Extras: `X-Backend-Cache: HIT|MISS`, `X-Image-Resampled: 1`.
`X-Projection`, `X-Observation-Time` and `X-Wavelength` are never sent for SDSS JPEG composites.

## Verified upstream behaviour (checked live, 2026-11-14)

* **Cutout** `skyserver.sdss.org/dr18/SkyServerWS/ImgCutout/getjpeg`: `ra, dec, scale, width, height`, `opt=G` adds a grid.
  Limits: scale 0.015-60 "/px, width/height 64-2048.
* **Coverage:** outside the footprint SDSS returns **HTTP 404 with an `image/jpeg` body** reading "Requested (ra, dec) is outside the SDSS footprint."
  That status is the only coverage signal used; image darkness is never inspected (a dark image is a valid image).
  A 404 with a non-JPEG body is treated as an upstream fault, not as missing coverage.
* **Catalogue:** `SearchTools/SqlSearch` with `dbo.fGetNearbyObjEq` joined to `PhotoObjAll` (primary detections, `type` in 0/3/6).
  Empty results arrive as an empty `Table1`; failures arrive as JSON with `ErrorCode`.
* **Resolver:** `cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?<name>` returns XML and redirects to a mirror; redirects are followed only to an allowlisted host set.

## Architecture

```
app/api/        routes (thin)              app/providers/   upstream-specific code: sdss.py, sesame.py, http.py
app/services/   caching, validation,       app/models/      error envelope + response schemas
                target selection           app/utils/       haversine, TTL cache, retry
app/data/verified_targets.json             scripts/verify_targets.py   regenerates that file from live services
```

* **Providers behind a contract** (`providers/base.py`): `ImageProvider.get_cutout` returns a `CutoutResult` (bytes, media type,
  `ImageMetadata` whose unknown fields are `None`). A SPHEREx provider can return FITS-derived renderings with timestamps and
  wavelengths without touching routes or caching. Not every provider has to emit JPEG natively.
* **Image cache:** bounded filesystem cache (`backend/.cache/images`, 256 MB, 24 h TTL, LRU eviction), keyed on survey/RA/Dec/scale/size/grid,
  storing metadata next to the image. Identical concurrent misses share one upstream fetch. Errors are never cached.
  Coordinates are rounded to 1e-6 deg (about 4 mas) so keys are stable.
* **Resilience:** 5 s connect / 20 s read timeouts; 2 retries with exponential backoff + jitter for connect errors and 502/503/504 (not for read timeouts or other statuses);
  upstream size caps; JPEG signature **and** full decode check; max 6 concurrent upstream calls.
* **Security:** fixed upstream hosts, no user-supplied URLs, SQL built only from validated numbers, NaN/inf rejected, name length/control-character limits,
  defused XML parsing, CORS limited to configured origins.

## Targets

`app/data/verified_targets.json` is produced by `scripts/verify_targets.py`, which resolves names with Sesame and checks coverage with the live cutout service
(centre plus four points around it). Run `cd backend && ../.venv/bin/python scripts/verify_targets.py` after changing the release.

**NGC 891 is not offered: SDSS DR18 has no imaging there** (verified). COSMOS field, Lockman Hole, M101 and M13 were added as verified alternatives.
Random fields are sampled uniformly on the sphere inside two broad footprint regions and kept only if five points per field return real imagery.
The "previous pick" memory is process-wide, not per user, and not shared across multiple workers.

## Known limitations

* **Image scale vs SDSS limits.** The frontend allows 0.05-120 "/px and any size; SDSS accepts 0.015-60 "/px and 64-2048 px. The backend requests an equivalent in-range image and
  centre-crops/resamples it (flagged by `X-Image-Resampled`). If the requested field of view exceeds what SDSS can supply in one image
  (roughly scale x max(width, height) > 122,880"; e.g. 1536 px at more than 80 "/px), the API returns `invalid_parameters` rather than a wrong-scale image.
  Images under 64 px are cropped from a 64 px image, which can introduce at most a half-pixel centre offset.
* JPEG cutouts carry no verified WCS or projection; the API sends none. Clicked coordinates remain approximate in the frontend.
* `object_type` from Sesame is SIMBAD's short code (e.g. `AGN`, `Sy2`, `BY*`) returned as-is. Catalogue `object_type` is limited to SDSS photometric classes
  Star / Galaxy / Unknown; catalogue matches have an SDSS `objID` but no common name.
* Nearby search uses primary photometric detections only, so a spectroscopic or named counterpart is not joined in.
* The coverage guarantee is "SDSS DR18's cutout service returned imagery", not data quality. Multiple workers do not share the in-memory caches.
