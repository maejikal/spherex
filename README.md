# Sky Explorer

Interactive astronomical sky explorer planned as a foundation for the NASA Space Apps SPHEREx challenge. This project aims to recreate useful SDSS Navigate workflows in an original, accessible dark interface, using real SDSS imagery rather than synthetic or decorative sky data.

> **Project status:** React frontend now runs independently. Search, imagery, catalogue, and coverage data require FastAPI routes, which are not implemented yet; frontend shows explicit unavailable states until then. See [`frontend/README.md`](frontend/README.md) for the frontend/API contract and [`project.md`](project.md) for the full specification.

## Scope

The first implementation targets a working SDSS DR18 explorer:

- Navigate by decimal-degree right ascension (RA) and declination (Dec); pan, zoom, recenter, and inspect cursor coordinates.
- Load real SDSS cutouts, resolve object names through a real astronomical service, explore verified targets, and select sky positions.
- Show catalogue matches and metadata only when returned by verified sources; clearly mark JPEG-derived click coordinates as approximate.
- Share validated view state through URL parameters; keep loading, upstream failure, invalid input, and no-coverage states distinct.

SPHEREx time blinking, spectral visualization, stacking, difference imaging, and automated discovery are future work. The current interface must not expose nonfunctional SPHEREx controls or imply SDSS covers SPHEREx science targets.

## Technology and architecture

Stack:

- **Frontend:** React, Vite, strict TypeScript, Tailwind CSS, Lucide React, TanStack Query, and Zustand. Implemented in `frontend/`.
- **Viewer:** HTML Canvas or another suitable renderer for cutouts, overlays, and pointer interactions; avoid complex WebGL without a demonstrated need.
- **Backend:** Planned Python 3.11+, FastAPI, Uvicorn, Pydantic, and httpx. Astropy is optional for future FITS/WCS work.

Keep UI, viewer state, coordinate/projection utilities, API clients, provider integrations, and backend business logic in distinct modules. Hide SDSS request/response details behind a provider boundary and reserve a separate future SPHEREx provider; never return SDSS data as fake SPHEREx data. Keep transient drag state separate from celestial coordinates, and do not put image binaries in global state.

## Local setup

Run the frontend shell now; API-backed features remain unavailable until the backend is added:

```zsh
cd spherex/frontend
npm install
npm run dev
```

Vite proxies `/api/*` to `http://127.0.0.1:8000` by default. Set `VITE_API_BASE_URL` in `frontend/.env.local` when FastAPI runs elsewhere. The complete monorepo setup below remains planned because `backend/` is not implemented.

```zsh
git clone <repository-url>
cd spherex

python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
npm --prefix frontend install
```

Start backend and frontend in separate terminals:

```zsh
cd spherex/backend
../.venv/bin/uvicorn app.main:app --reload
```

```zsh
cd spherex
npm --prefix frontend run dev
```

FastAPI OpenAPI UI is intended at `http://127.0.0.1:8000/docs`; Vite prints the frontend URL when it starts. No paid services or API keys are planned for the initial public-data integrations. Frontend environment variable: `VITE_API_BASE_URL` (optional API origin; empty uses the Vite `/api` proxy).

## API plan

The FastAPI backend is expected to expose:

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Service health |
| `GET /api/surveys` | Supported survey information |
| `GET /api/images/cutout` | Validated, cached image cutout proxy |
| `GET /api/objects/resolve` | Resolve an astronomical name to coordinates |
| `GET /api/objects/nearby` | Query catalogue objects around a sky position |
| `GET /api/targets/suggested` | Return curated, verified exploration targets |
| `GET /api/targets/random` | Choose a random position from verified covered locations |

These routes are planned, not implemented. Image requests must validate and normalize coordinates, scale, overlays, and bounded dimensions; apply timeouts; verify upstream status and image content type; and avoid caching failures indefinitely. Nearby queries must be bounded and server-constructed, never browser-submitted arbitrary SQL. Provide consistent JSON errors and FastAPI OpenAPI documentation.

## Data sources and provenance

- **Images:** Intended primary source is the official [SDSS DR18 Image Cutout service](https://skyserver.sdss.org/dr18/SkyServerWS/ImgCutout/getjpeg). Verify availability and response behavior before claiming the integration works. Preserve source URL, release, center, image dimensions, pixel scale, projection, and coordinate system where known. Observation time, wavelength, calibration, and quality flags must remain unavailable when the source does not provide them.
- **Object names:** Use a real resolver such as [CDS Sesame](https://cds.unistra.fr/cgi-bin/Sesame) or SIMBAD. Never fabricate resolved positions or metadata.
- **Catalogue matches:** Use a documented catalogue service and show only returned fields. A clicked position is not itself proof of an object.
- **Future SPHEREx:** Use official [IRSA SPHEREx archive services](https://irsa.ipac.caltech.edu/Missions/spherex.html) and the [SPHEREx data access documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/). Preserve the distinctions between timestamped individual images, combined products, and spectral cubes.

Suggested targets (M31, M51, M87, NGC 891, and a verified SDSS deep field) must be separately curated and coverage-checked. Random navigation must select from verified covered positions, not uniform all-sky coordinates, and should avoid immediately repeating the previous destination where possible. Do not imply SDSS covers Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, or R Draconis.

## Coordinate and image limitations

- Use ICRS/equatorial coordinates. RA is in decimal degrees, normalized to `0 <= RA < 360`; Dec is signed and constrained to `-90 <= Dec <= 90` degrees.
- Respect RA-hours versus RA-degrees, RA wraparound, celestial east/west orientation, and the `cos(Dec)` factor in small-field RA offsets.
- A local tangent-plane approximation is acceptable only for small fields and away from problematic polar conditions. Derive navigation from absolute sky coordinates to prevent drift; preserve a projection boundary for future Astropy WCS support.
- SDSS JPEG cutouts do not by themselves guarantee precise WCS or pixel-perfect astrometry. Label click coordinates approximate unless supported by real geometry. Report scale in arcseconds per pixel (smaller scale means greater zoom) and show approximate FOV only when meaningful.
- SDSS coverage is not all-sky. A valid dark image is not the same as missing coverage or a service failure. Never fabricate a star field, coordinates, classifications, magnitudes, timestamps, wavelengths, or coverage.

## UX, accessibility, and reliability

Use a compact header, collapsible navigation sidebar, primary image viewer, and collapsible/drawer inspector. Keep imagery visually primary and preserve access to important controls on narrow screens. Every visible control must work. Provide keyboard access, visible focus, semantic labels, sufficient contrast, descriptive errors, and non-color-only status cues; explain astronomy terms in concise tooltips.

Preserve the previous image while a new request loads where practical. Debounce wheel navigation, cancel or ignore stale requests, cache successful repeated cutouts, bound image dimensions, and clean up event listeners. URL state should include at least RA, Dec, scale, survey, and grid visibility; update after navigation settles so drag/wheel interaction does not spam history, and make Back/Forward sensible.

## Testing and development

Mock external services in unit tests. Planned coverage includes backend validation, proxy status/content type/timeouts/cache, resolver and nearby-query failures, coordinate edge cases (including RA wrap and high Dec), FOV, pan and zoom consistency, URL parsing, search, overlays, and loading/error states. Screenshots alone do not validate astronomy math. Verify external services before reporting successful integrations; document access limitations and a verification path when unavailable.

Implementation order: inspect/setup; verify real SDSS image retrieval; build coordinate-accurate viewer; add interface; add search and curated targets; add inspection; finish errors, responsive/accessibility polish, tests, and documentation. Do not stop at scaffolding when implementation is requested.

## License

See [`LICENSE`](LICENSE). Do not reuse SDSS branding, logos, proprietary assets, or source code.
