# Sky Explorer

Interactive sky explorer for the NASA Space Apps **SPHEREx** challenge. It shows real **NASA SPHEREx** all-sky infrared imagery in an
original dark interface (floating Find / View / Inspect windows), with a **wavelength selector** over the SPHEREx spectral channels.
The interaction model is inspired by SDSS Navigate; SDSS data is not used.

- **Imagery:** the NASA/IPAC IRSA [SPHEREx DR1 all-sky data cube HiPS](https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube),
  rendered in the browser by [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/) 3.8.2. Tiles are fetched directly from IRSA (CORS is open), so no
  backend image proxy exists.
- **Constellations:** selected-position IAU membership via local Astropy, Wikipedia links, and optional official boundary outlines.
- **Backend (FastAPI):** survey metadata, CDS Sesame name resolution, SIMBAD nearby-object lookup, and coverage-verified SPHEREx targets.

> Does the SPHEREx HiPS provide direct access to all 102 spectral channels? **Yes.** It is a HiPS *cube* (`dataproduct_type = cube`,
> `hips_cube_depth = 102`) with one tile file per frame. 100 channels have imagery; frames 50 and 51 (the dichroic boundary channels,
> 2.399 and 2.445 µm) are documented by IRSA as blank and have no tiles. See [frontend/README.md](frontend/README.md#spherex-hips-verified-behaviour).

## Run

```zsh
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
npm --prefix frontend install

cd backend && ../.venv/bin/uvicorn app.main:app --reload     # http://127.0.0.1:8000  (docs: /docs)
cd frontend && npm run dev                                   # http://localhost:5173  (proxies /api -> :8000)
```

Needs a browser with WebGL. Tests: `cd backend && ../.venv/bin/python -m pytest` and `cd frontend && npm run typecheck && npm test && npm run build`.

## Architecture

| Concern | Where |
| --- | --- |
| Sky rendering, pan/zoom, grid, picking | Aladin Lite inside `frontend/src/components/AladinSkyViewer.tsx`, controlled by `frontend/src/sky/aladin/controller.ts` |
| SPHEREx metadata + channel table | `frontend/src/sky/spherex/` (reads the HiPS `properties` document directly) |
| App state / URL / history | Zustand store + `frontend/src/state/` |
| Name resolution, nearby objects, targets, survey info | FastAPI in `backend/app/` |

Keep UI, viewer state, provider integrations and backend logic in separate modules. A future SPHEREx FITS/IRSA-observation provider plugs into
`backend/app/providers/base.py` (`SurveyProvider`) without touching routes.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Service liveness (independent of upstreams) |
| `GET /api/health/dependencies` | Live probe of IRSA, Sesame and SIMBAD |
| `GET /api/surveys` | Verified SPHEREx description and the 102-channel table, read live from IRSA |
| `GET /api/objects/resolve?name=` | CDS Sesame name resolution |
| `GET /api/constellations/at?ra=&dec=` | Local IAU membership and sampled ICRS boundary geometry |
| `GET /api/objects/nearby` | SIMBAD objects near a position (`radius_arcsec`, `limit`) |
| `GET /api/targets/suggested` | Curated, tile-verified SPHEREx targets |
| `GET /api/targets/random` | Random tile-verified sky position (uniform on the sphere) |

## Data sources and provenance

- **Images:** NASA/IPAC IRSA SPHEREx DR1 all-sky cube HiPS (a *visualization* product: 8-bit PNG tiles, fixed asinh stretch, HiPS order <= 5).
- **Wavelengths:** the `data_cube_crval3_arr` table in the HiPS properties; nothing is computed or invented.
- **Names:** CDS Sesame (SIMBAD/NED/VizieR). **Objects:** SIMBAD TAP (CDS primary, Harvard mirror fallback). SIMBAD results are *not* SPHEREx detections.
- **Observation time:** the cube combines a year of observations (MJD 60789.75-61174.49). It has no single epoch and cannot show motion or time variation.

## Constellations

Select a sky position (click, or focus the viewer and press Enter). Its constellation appears in the selected-position tray and Inspect,
without running SIMBAD analysis. Enable **Official boundary outline** to draw that constellation in gold. The toggle persists across
navigation during the session; clearing the selection hides the outline. Close zoom can put the boundary outside the viewport; zoom out
to see it. The selected position, not the viewport center or a catalogue match, determines membership. Boundaries work independently of
SPHEREx channel/coverage. No star figures, artwork, or zodiac/astrological inference is used.

The synchronous FastAPI route runs in a worker thread. Astropy `get_constellation` transforms ICRS positions to B1875 and uses Roman (1987)
for membership, with its defined edge tie-breaking. Display names normalize three spelling errors in Astropy's bundled names. Geometry uses
bundled [CDS VI/49](https://cdsarc.cds.unistra.fr/viz-bin/cat/VI/49) B1875 vertices (Davenhall & Leggett 1989, based on Delporte 1930), retrieved
from the [Harvard VizieR mirror](https://vizier.cfa.harvard.edu/ftp/cats/VI/49/) on 2026-11-14. Original data and catalogue documentation are
preserved in `backend/app/data/constellations/`. Serpens retains two separate rings. Octans' documented artificial projection seam to the
south pole is removed. Each parallel/meridian is sampled at at most 0.25 degrees in B1875 before Astropy transforms it to ICRS; Aladin handles
spherical projection. This is a tessellated visual guide, not a precision astrometric boundary test. Original tables have finite coordinate
precision; use Astropy membership rather than point-in-polygon on the display outline, especially near edges.

No runtime external call or API key is needed for constellation lookup. Transformed geometry is cached per constellation (bounded to 88),
and React Query caches exact selected-position requests, cancels obsolete fetches, and clears old geometry on selection changes. Wikipedia
opens only when requested; article titles are explicitly mapped to avoid ambiguous names. No new environment variables.

## Limitations

- Wavelength channels are not observation times; there is no time slider or blinking. Time-domain features need timestamped observations from IRSA.
- The HiPS pixel scale (order 5, ~12.9"/px) is coarser than SPHEREx's native 6.2"/px; zooming beyond it magnifies pixels. The imagery is for exploration, not photometry.
- High-proper-motion targets (Barnard's Star, ε Indi B, WISE 0855) are placed at their position at the cube's mid-epoch (propagated with SIMBAD proper motion), stated in each description.
- WebGL is required; behaviour and performance depend on the browser GPU.

## License

See [`LICENSE`](LICENSE). Aladin Lite is LGPL-3.0 (CDS). Do not reuse SDSS branding, logos or proprietary assets.
