# Sky Explorer frontend

React + strict TypeScript/Vite UI. Sky imagery is rendered by **Aladin Lite 3.8.2** (pinned; the version IRSA's own SPHEREx landing page uses) from the
NASA/IPAC SPHEREx all-sky cube HiPS. The existing floating Find / View / Inspect windows, dark theme and search experience are unchanged; Aladin's own
controls are disabled so there is a single set of controls.

## Run

```zsh
cd frontend && npm install && npm run dev        # http://localhost:5173
npm run typecheck && npm test && npm run build
```

`/api/*` is proxied to `http://127.0.0.1:8000` (set `VITE_API_BASE_URL` to change). The sky itself needs no backend: tiles come straight from IRSA
(`VITE_SPHEREX_HIPS_URL` overrides the HiPS URL). Search, targets and catalogue lookup use the FastAPI service.

## Structure

| Path | Role |
| --- | --- |
| `src/components/AladinSkyViewer.tsx` | React wrapper: creates one Aladin instance per verified survey, syncs state, shows loading/error states |
| `src/sky/aladin/controller.ts` | Owns the Aladin instance: view sync, channel switching, grid, selection marker, tile loading/failure signals |
| `src/sky/aladin/fov.ts` | `scale` (arcsec per CSS pixel) <-> Aladin field of view: `fov = viewportWidth x scale / 3600` |
| `src/sky/spherex/` | HiPS `properties` parsing/validation, channel table, frame <-> frequency mapping, service config |
| `src/components/WavelengthSelector.tsx` | Dropdown + slider + previous/next for the 102 channels (inside the View window) |
| `src/state/` | Zustand store and URL (de)serialisation |
| `src/api/client.ts` | HTTP + validation for the FastAPI routes |

### State synchronisation (no feedback loops)

Zustand holds the intended view (`ra`, `dec`, `scale`, `survey`, `grid`, `channel`). **App -> Aladin:** `controller.setView()` moves Aladin only if it is not
already there, and ignores the app echoing back the exact view the controller last reported. **Aladin -> App:** user pans/zooms are reported once, after
220 ms without movement (never mid-drag), as a `replace` history update, so continuous panning neither floods history nor makes the camera jump back.
Explicit actions (go to coordinates, targets, zoom buttons, channel change, reset) `push` history, so Back/Forward is meaningful.

### URL

`?ra=180&dec=-58&scale=2.5&survey=spherex&channel=30&grid=1`. `scale` is arcsec per CSS pixel of the viewer width; `channel` is the **0-based cube frame**
(omit for the service default); `grid` is 0/1. Old SDSS-prototype links (`survey=sdss-dr18`, `scale=0.4`) open as SPHEREx at the same position and the same
arcsec/pixel scale (never reinterpreted as degrees; values below the 0.2 limit are clamped).

## SPHEREx HiPS: verified behaviour

Verified live on 2026-11-14 (`<hips>/properties`, tiles, and IRSA's own landing page):

- `creator_did = ivo://IPAC/P/SPHEREx/DR1/cube`, `dataproduct_type = cube`, `hips_cube_depth = 102`, `hips_frame = equatorial`, `moc_sky_fraction = 1`.
- Tiles: 512 px **8-bit palette PNG**, HiPS orders 0-5, `Norder<N>/Dir<D>/Npix<P>_<frame>.png`; the **frame is 0-based** (`Npix<P>.png` is not a separate frame).
  Pixel cut 0-40 with asinh stretch is baked into the product (`hips_pixel_cut`, `hips_pixel_function`).
- **Channels are selectable in one HiPS** (Case B): the `data_cube_crval3_arr` property lists all 102 wavelengths in µm. Aladin Lite selects a frame with
  `hips.setFrequency({value, unit: 'Hz'})`, mapping frequency linearly onto frames between `c/em_max` and `c/em_min`; IRSA's landing page passes the middle of each
  frame's interval, which we reproduce (`frequencyForFrame`). Verified: frames 0, 1, 17, 30, 49, 52 and 101 each request exactly the matching `_<frame>.png` tiles.
  `setSliceNumber` does **not** give the expected frame (3 -> 84, 60 -> 9) and is not used.
- Aladin opens a cube on its middle frame, which is blank (frame 50), so the app selects the frame immediately after load; the default is the service's
  `hips_cube_firstframe` (frame 1, 0.771 µm), not a claim of a scientifically optimal band.
- Frames **50 and 51** (band 3 ch 17, band 4 ch 1) return HTTP 404 for every tile; they are shown in the selector as "no imagery" and skipped by previous/next.
- No `Cache-Control` header; `ETag` + `Last-Modified` + `access-control-allow-origin: *`, so the browser's heuristic HTTP cache applies.

### Caching (verified in Chrome with a cold profile)

No custom cache or service worker is needed. Tiles are plain URLs (no cache-busting parameters) that differ per frame, so channels cannot be confused. Measured:
first view = network downloads; no tile URL was ever downloaded from the network twice; revisiting a region was served from the HTTP cache or Aladin's in-memory
cache; switching to another channel and back re-used the first channel's cached tiles.

### Loading and errors

- Unloaded areas show `#292D35`; Aladin draws coarser parent tiles until detail arrives. Grey never means "no coverage".
- The HiPS `properties` document is fetched with TanStack Query and validated; unreachable/invalid metadata shows "SPHEREx imagery unavailable" with Retry and
  disables the wavelength selector. **No other survey is ever substituted.**
- Tile failures (network error or HTTP 5xx; a 404 is expected for blank frames) are detected with a scoped `window.fetch` wrapper installed for the controller's
  lifetime, shown as a transient notice, and expire after 15 s.
- Aladin starts with `survey: []` and `log: false`, so it contacts no CDS services.

## Known limitations

- Requires WebGL. The viewer shows an explanatory error if Aladin cannot start.
- Zoom beyond the HiPS pixel scale (~12.9"/px) magnifies pixels; scale is limited to 0.2-500 arcsec/px.
- The Aladin library is ~2.4 MB (840 kB gzip), lazy-loaded on first view.
