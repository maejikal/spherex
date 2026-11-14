# Sky Explorer backend

FastAPI service for scientific data that is not rendered in the browser. **Sky imagery is not served here**: Aladin Lite reads the NASA/IPAC SPHEREx HiPS
tiles directly from IRSA. The backend provides SPHEREx survey metadata, CDS Sesame name resolution, SIMBAD nearby-object lookup and tile-verified SPHEREx
targets. Nothing astronomical is generated or guessed; if an upstream cannot answer, the API returns a structured error.

## Run

```zsh
# from the repository root
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
../.venv/bin/uvicorn app.main:app --reload          # http://127.0.0.1:8000  (docs: /docs)
../.venv/bin/python -m pytest                        # mocked, no network needed
```

Configuration is via `SKY_*` environment variables or `backend/.env` (see `.env.example`).

## Endpoints

| Route | Notes |
| --- | --- |
| `GET /api/health` | `{"status":"ok"}`. Independent of IRSA/CDS/SIMBAD. |
| `GET /api/health/dependencies` | Diagnostic live probe of IRSA HiPS, Sesame and SIMBAD. |
| `GET /api/surveys` | Verified SPHEREx description read from the HiPS `properties`: release, tile format/order, observation window, and all 102 channels (`frame`, `band`, `band_channel`, `wavelength_um`, `has_data`). 502 if IRSA is unreachable or the metadata is not the SPHEREx cube. |
| `GET /api/objects/resolve?name=` | CDS Sesame (SIMBAD/NED/VizieR). |
| `GET /api/objects/nearby` | SIMBAD cone search. `ra, dec, radius_arcsec=30 (max 120), limit=8 (max 50)`. |
| `GET /api/targets/suggested` | Barnard's Star, Epsilon Indi B, WISE 0855-0714, RW Aurigae, R Draconis, M31, M42. |
| `GET /api/targets/random` | One of 40 tile-verified positions drawn uniformly on the sphere; never the same twice in a row. |

Errors always use `{"error": {"code", "message"}}`: `invalid_parameters` (422), `unsupported_survey` (400), `object_not_found` (404), `upstream_timeout` (504),
`upstream_unavailable` / `upstream_invalid_response` / `catalogue_unavailable` (502), `internal_error` (500), `not_found` (404).

## Removed in the SPHEREx migration

SDSS cutout provider, SDSS coverage detection, SDSS SkyServer SQL, SDSS targets, the disk image cache, `GET /api/images/cutout` (it returned SDSS JPEGs; with
Aladin reading HiPS tiles directly there is no consumer, so it is removed rather than left misleading) and the Pillow dependency.

## Verified upstream behaviour (checked live, 2026-11-14)

* **IRSA HiPS** `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube/properties`: a HiPS cube, 102 frames, 512 px PNG tiles, orders 0-5, all-sky MOC.
  `data_cube_crval3_arr` has the wavelength of every frame; `obs_description` documents blank frames 50 and 51 (0-based). `access-control-allow-origin: *`.
* **CDS Sesame** `cds.unistra.fr/cgi-bin/nph-sesame/-oxp/SNV?<name>` returns XML and redirects to a mirror (followed only to an allowlisted host set).
* **SIMBAD TAP** `POST <tap>/sync` (`request=doQuery&lang=adql&format=json`). The CDS primary host served an HTML "page unavailable" page at verification time, so the
  provider fails over to the official Harvard mirror. ADQL errors arrive as a VOTable (`QUERY_STATUS=ERROR`) and are treated as failures, never as "no matches".
  ADQL does not allow expressions in `ORDER BY`; use a column alias.

## Architecture

```
app/api/        routes (thin)                 app/providers/   spherex.py (HiPS metadata), sesame.py, simbad.py, http.py, base.py (contracts)
app/services/   caching, validation, targets  app/models/      error envelope + response schemas
app/data/verified_targets.json                scripts/verify_targets.py   regenerates it from live services
```

`providers/base.py` separates *browser rendering* (Aladin, no provider) from *backend services*. `SurveyProvider.describe()` is the seam for a future
timestamped-observation / FITS provider (IRSA), which can return wavelengths, observation times and WCS without touching routes.

## Targets

`scripts/verify_targets.py` (`pip install -r requirements-scripts.txt`) resolves each name via Sesame, applies SIMBAD proper motion to the cube's mid-epoch
(2025.84) when an object has moved more than 20", and **fetches the real HiPS tiles** for the position (HEALPix NESTED index via `astropy-healpix`, orders 3 and 5,
one frame per detector band). A position is kept only if every tile exists, decodes as PNG and is not blank. Random positions use uniform-on-the-sphere sampling
(z = sin(dec) uniform) and pass the same check. Barnard's Star (10.39"/yr), WISE 0855 (8.15"/yr) and ε Indi B (4.68"/yr) are propagated and say so in their descriptions.
Verification shows tiles with signal exist, not that an object is detected; a combined cube cannot show motion.

## Known limitations

* In-memory caches (survey info, name resolution, catalogue) and the "no immediate repeat" random pick are per process, not shared between workers.
* SIMBAD object types are SIMBAD's descriptions; matches are catalogue records, never labelled as SPHEREx detections.
* `object_type` from Sesame is SIMBAD's short code (e.g. `AGN`, `BY*`), returned as-is.


## Local constellation lookup

`GET /api/constellations/at?ra=83.822&dec=-5.391` returns selected ICRS coordinates, constellation name/abbreviation,
Wikipedia URL, source attribution and closed ICRS boundary rings. RA must be finite in `[0, 360)`, Dec in `[-90, 90]`;
invalid input returns the normal 422 JSON error. Astropy is installed by `requirements.txt`; no remote service, key,
or environment setting is involved. Membership: Roman (1987) via Astropy. Boundaries: bundled CDS VI/49 B1875 vertices,
sampled before transformation; see the root README for provenance, polar seams, and display precision limitations.

Focused tests: `../.venv/bin/python -m pytest tests/test_constellations.py -q` (from `backend`).
