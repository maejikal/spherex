# Sky Explorer frontend

React + strict TypeScript/Vite UI for the SDSS DR18 sky explorer. Frontend only; it consumes the FastAPI routes in the project brief and does not call SDSS services directly. A missing backend is shown as an unavailable-service state; no image, target, coordinate, or catalogue data is fabricated.

## Run

```zsh
cd frontend
npm install
npm run dev
```

Vite serves the UI at `http://localhost:5173` and proxies `/api/*` to `http://127.0.0.1:8000`. Set `VITE_API_BASE_URL` in `.env.local` only when the API is hosted elsewhere. Build and verify with:

```zsh
npm run typecheck
npm test
npm run build
```

## FastAPI contract expected by this UI

| Route | Expected response |
| --- | --- |
| `GET /api/health` | JSON with a string `status` field |
| `GET /api/images/cutout` | `image/jpeg` bytes; optional `X-Source-URL`, `X-Projection`, `X-Coordinate-Frame`, `X-Observation-Time`, `X-Wavelength`, and `X-Survey-Release` headers. Query: `ra`, `dec`, `scale`, `width`, `height`, `survey=sdss-dr18`, `grid=0|1` |
| `GET /api/targets/suggested` | `{ "targets": [{ "id?", "name", "ra", "dec", "description?" }] }`; entries must have verified coverage |
| `GET /api/targets/random` | `{ "target": { "name?", "ra", "dec" } }` or coordinate object; result must come from verified coverage |
| `GET /api/objects/resolve?name=...` | `{ "name", "ra", "dec", "source?", "object_type?" }` or same object nested under `object` |
| `GET /api/objects/nearby` | `{ "matches": [{ "id?", "name?", "ra", "dec", "object_type?", "separation_arcsec?", "source?" }] }`; UI fixes radius to 30 arcseconds and limit to 8 |

JSON errors should use `{ "error": { "code": "no_coverage", "message": "..." } }` (or equivalent top-level `code`/`message`). `no_coverage` distinguishes valid no-coverage from service failure. Image responses must not use a successful status for HTML or JSON errors. Only successful JPEG responses are cached locally, keyed by center, scale, dimensions, survey, and grid option.

## UI and astronomy boundaries

- Find, View, and Inspect are separate floating windows. Pointer drag and keyboard Move + arrow keys reposition them; mobile keeps the same controls without horizontal overflow.
- Cutout requests preserve the previous successful image while a new request loads. Pan/zoom requests are debounced into shareable URL updates; Back/Forward restores validated `ra`, `dec`, `scale`, `survey`, and `grid` state.
- Image scale is arcseconds per pixel. FOV is computed from requested dimensions and scale, so displayed FOV is marked approximate.
- Click coordinates use an inverse gnomonic approximation with north-up/east-left cutout orientation. They are labeled approximate; frontend makes no verified WCS or pixel-astrometry claim.
- Grid is requested from SDSS cutout service. Crosshair is a local overlay and stays separate from server imagery.
- Image provenance only reports request values and metadata returned by API. Projection, observation time, wavelength, and source URL stay unavailable unless returned.
- `src/api/` owns HTTP and response validation, `src/sky/` owns coordinate math, `src/state/` owns shareable viewer state, and components own UI-local drag/cache state. Image Blobs remain local to viewer rather than Zustand state.

Image-service reference: [SDSS SkyServer DR18 Visual Tools](https://skyserver.sdss.org/dr18/VisualTools/navi). The backend must verify the official DR18 cutout endpoint and expose its bytes through the proxy before imagery can load.
