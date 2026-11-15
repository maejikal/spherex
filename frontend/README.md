# Sky Explorer frontend

React + strict TypeScript/Vite UI. Sky imagery is rendered by **Aladin Lite 3.8.2** (pinned; the version IRSA's own SPHEREx landing page uses) from the
NASA/IPAC SPHEREx all-sky cube HiPS. Find / View / Inspect share a dark observatory theme and can float or dock beside the imagery. Aladin's own
controls are disabled so there is a single set of controls.

## Run

```zsh
cd frontend && npm install && npm run dev        # http://localhost:5173
npm run typecheck && npm test && npm run build
```

`/api/*` is proxied to `http://127.0.0.1:8000` (set `VITE_API_BASE_URL` to change). The sky itself needs no backend: tiles come straight from IRSA
(`VITE_SPHEREX_HIPS_URL` overrides the HiPS URL). Search, targets and catalogue lookup use the FastAPI service.

## Typography

The interface uses self-hosted **Oxanium** (variable weights 200–800), with system sans-serif fallbacks and `font-display: swap`.
Tabular lining figures keep coordinates and measurements aligned. The font is preloaded locally; no Google Fonts runtime requests or package dependencies.
Assets, source URL and SIL Open Font License are in `public/fonts/oxanium/`. The earlier comparison remains at `/type-study/index.html`.

## Compare workspace layouts

Use **Layout: Floating / Docked** in the desktop header. Floating remains the default; the choice is session-only and is not part of shared sky URLs.

- **Floating:** existing draggable, keyboard-movable windows retain their positions when switching back from Docked.
- **Docked:** Find and View use the left rail (stacked when both are open); Inspect uses the right rail. Closing tools returns their space to the sky.
- **Mobile (760px and below):** either preference uses one scrollable bottom sheet, with a reachable sky viewport above it. Toolbar buttons switch sheets.

Layout is local React presentation state, separate from the Zustand celestial view. The same viewer and tool instances remain mounted during desktop
layout changes, preserving search drafts, selection, channel, overlays, center and scale. The viewport gets narrower when docking: angular field of view
changes to retain the same arcseconds per pixel. `src/workspace.css` owns the presentation layer; no provider or coordinate changes are needed.

Manual checks: open a destination; enable a grid in View; type an unsubmitted object name in Find; switch layouts; verify the draft, grid, center, scale
and URL remain unchanged. Open all three tools to check stacked scrolling. At 390px and 320px, verify one sheet opens at a time, its contents scroll,
the close button returns space to the sky, and no horizontal scrolling occurs.

## Structure

| Path | Role |
| --- | --- |
| `src/components/AladinSkyViewer.tsx` | React wrapper: creates one Aladin instance per verified survey, syncs state, shows loading/error states |
| `src/sky/aladin/controller.ts` | Owns the Aladin instance: view sync, channel switching, grid, selection marker, tile loading/failure signals |
| `src/sky/aladin/fov.ts` | `scale` (arcsec per CSS pixel) <-> Aladin field of view: `fov = viewportWidth x scale / 3600` |
| `src/sky/spherex/` | HiPS `properties` parsing/validation, channel table, frame <-> frequency mapping, service config |
| `src/components/WavelengthSelector.tsx` | Dropdown + slider + previous/next for the 102 channels (below Go to coordinates in the Find window) |
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

## Blink viewer

Choosing **Analyze area** keeps its existing behaviour (Inspect window + SIMBAD search) and also opens the **Blink viewer**, a floating
window placed bottom-aligned immediately left of Inspect. It captures that position without starting a blink observation request.
Choose the source, channel/wavelength and archive **Field of view**, then press **Load observations**. Square-field presets are
0.02°, 0.05°, 0.1° (default), 0.2°, 0.3° and 0.5° per side. Blink settings, visible-field readouts and observation details display degrees. This changes the requested sky area, not display zoom.
Only the lightweight mode/channel metadata can load before submission; observation discovery and cutout downloads wait for Load.
Draft FOV/channel changes do not alter an existing request or loaded pair until applied. Submitted settings, including FOV, own the
query/cache key and loading clock. New Analyze positions and source switches require Load again. Local SPHEREx retains its
256 × 256 pixel cutouts; its angular FOV depends on server pixel scale, so no unsupported angular selector is shown.
Observation settings collapse after a pair loads to preserve image space; expand them to change settings. Panning the sky or
selecting elsewhere never replaces an open analysis.
Both aligned PNGs are loaded and decoded before playback is allowed; frames are stacked and toggled with `visibility`, so a switch is
instantaneous with no layout change. Controls: Play/Pause, 0.25 / 0.5 / 1 / 2 s per frame, previous/next, direct frame buttons (these pause),
1x/2x/4x zoom (pixel-preserving when zoomed), keyboard (Space, arrow keys). Pure logic lives in `src/sky/blink/` (`response.ts`, `playback.ts`,
`errors.ts`) with tests in `tests/blink.test.mjs`. On a phone-sized screen only one sheet fits, so the Blink viewer takes it and Inspect is one tap away.
Local coverage is limited to configured FITS pairs; outside those fields the viewer explains this and offers a "Go to covered region" button.

The display initially fits the tight union of both PNG alpha bounds on one shared rectangular viewport, with no artificial padding. The stage preserves that rectangle’s aspect ratio so sky imagery is never stretched; rectangular fields show both angular dimensions.
This removes transparent padding without independently centering epochs or altering their celestial alignment. **Full field** restores the
original extent; visible FOV updates with fit/zoom, while metadata retains full-field FOV and coverage. Blank areas mean no usable data,
not dark sky. Pixel-read failures fall back to full field. Display geometry lives in `src/sky/blink/viewport.ts`, tested in
`tests/blinkViewport.test.mjs`; FITS extraction and backend responses are unchanged. Observation details and original warnings remain expandable.
On narrow screens, Blink uses the available workspace rather than a half-height sheet; closing it restores the sky view.

### Archive mode and local SPHEREx

The Blink Viewer has an observation-source switch. **SPHEREx archive** (the default) calls `/api/blink/dynamic` for the analysed position and shows a
wavelength-matched pair from NASA/IPAC, with detector, observation ids, central wavelength and bandwidth, the wavelength gap, coverage, provenance and
warnings. **Local SPHEREx** uses locally stored SPHEREx FITS observation pairs, including configured target pairs such as Barnard’s Star. The original two-file D5 pair is labeled **Local demo (real SPHEREx)**; it was supplied locally, not queried from NASA by the app. Barnard’s Star is a separate cached NASA/IPAC observation pair, not a demo. Both contain real SPHEREx observations; coverage is limited to the configured files. The mode only changes when the user switches it (or the server reports archive mode
off); a failed archive request is explained in the viewer, with a Retry where it can help and an explicit "Use local SPHEREx instead" button, and **never**
falls back to local data silently. Pure logic: `src/sky/blink/mode.ts`, `response.ts`, `errors.ts`; tests in `tests/blink.test.mjs`.

## Known limitations

- Requires WebGL. The viewer shows an explanatory error if Aladin cannot start.
- Zoom beyond the HiPS pixel scale (~12.9"/px) magnifies pixels; scale is limited to 0.2-500 arcsec/px.
- The Aladin library is ~2.4 MB (840 kB gzip), lazy-loaded on first view.


## Selected constellation

App owns one React Query lookup keyed by selected RA/Dec, plus an independent session-only boundary preference enabled by default.
It passes the lookup to `ConstellationCard` in both the selected-position tray and Inspect, without enabling SIMBAD analysis. The API client validates ICRS
rings and link origins. `AladinController.setConstellationBoundary` owns one reusable graphics layer; new selection, failure, clearing,
or disabling the toggle removes old geometry. Aladin projects the sampled coordinates; no DOM pixel tracing or separate renderer.
Wikipedia links are external and explicitly labelled. Name, loading, failure/retry and checkbox remain keyboard-accessible.

Manual check: select Orion; outline should appear by default. Toggle off and back on, then zoom out; verify gold region boundary
(not star connections). Select Andromeda and confirm no Orion outline remains, then clear selection. Inspect and tray checkboxes stay in sync. Change spectral channel and layout;
selection/outline persist. With backend stopped, a new selection shows retry instead of the previous name or boundary. Test at 390px.

### Constellation overview window

Enabling **Official boundary outline** also shows a small read-only overview in the lower-left of the viewer. It fits the complete selected
constellation and marks the lookup position with a cyan dot/cross, independently of the main camera's center/zoom. Disabling the toggle,
clearing selection, or a pending/failed new lookup hides the window instead of retaining stale geometry. The window is smaller on mobile.

`src/sky/constellationOverview.ts` projects the existing sampled ICRS rings using spherical azimuthal equidistant coordinates centered on
the mean boundary unit vector, then uniformly fits them into an SVG viewBox. RA wrap, polar regions and disconnected Serpens rings are
handled without planar RA/Dec bounding boxes. North up/east left describes orientation at chart center; projection distorts shapes away
from center. This is a context map, not WCS or a measured field of view. No invented stars, figure connections or new dependencies.

Local SPHEREx automatically loads a usable configured observation pair for the analysed coordinates; no pair picker is needed. Selection uses backend WCS/valid-pixel coverage, not object-name matching. Targets without usable local coverage show a no-coverage message.

## Community review prototype

Load a blink pair, then choose **Flag for review**. The dialog pauses blinking and shows the full original images, independent of blink zoom/cropping. Click/tap or click and drag each image to position a fine crosshair. Each image supports independent 1×–8× zoom centered on its mark; scroll the zoomed image to inspect detail. Focus an image and press Enter to place a crosshair; arrow keys move 0.1 original pixel (Shift: 1 pixel; Alt: 0.01 pixel), Delete clears. Fractional coordinates are annotation positions, not extra image resolution or astrometric precision. Image URLs remain in stored provenance but are not displayed in review metadata. Existing integer-pixel marks remain compatible. Mark one anomaly per case, independently in each frame, or explicitly choose **Not visible**. A title, description, and at least one crosshair are required.

**Community review** opens a queue saved **only in this browser/origin**. IndexedDB database `spherex-community-review` stores immutable analysis metadata and original image blobs atomically, separately from votes. The `review=<case-id>` URL reopens a case on that browser; it does **not** share evidence with other people/devices. Browser privacy restrictions, quota limits, clearing site data, or changing origin can make cases unavailable. Publishing errors retain the draft; drafts are not persistent across reloads. Source URLs remain in metadata, but reviewing saved evidence does not depend on upstream image caches.

Use **Demo account** in the explorer header or review dialog to switch between six fictional profiles: Alex, Maya, Sam, Jordan, Riley and Casey. No login, password, or account creation is required. Selection persists in localStorage on this browser (falls back to memory if storage is blocked); profiles share the same browser-local review queue. Any selected account can author an observation or review another account’s case. Drafts capture the author when opened. Existing author/reviewer IDs remain compatible; old cases now display their corresponding profile names. Self-review is blocked; one editable decision per other demo account. All decisions count toward five required reviews; only **Warrants further investigation** counts toward the exact 80% threshold. The author closes voting when eligible. This is not identity verification, abuse protection, or scientific confirmation. Other tabs must reload a case to see changes; revision checking prevents stale overwrites.

After closure, author-only **Simulate MPC submission**, **Simulate MPC acceptance**, and **Simulate observatory referral** record local application timestamps in order. Nothing is sent externally, and no real MPC/observatory integration or validation is claimed. Real submission eligibility (including whether a candidate belongs with MPC at all) needs a separate scientific and service-integration design.

Architecture: `src/review/model.ts` owns validation/workflow and original-image pixel mapping; `storage.ts` owns native IndexedDB and validated image snapshots; `route.ts` preserves explorer URL parameters. `src/components/review/` owns accessible native dialogs, annotations, queue and case screens. No backend/API changes or added dependencies. A future shared implementation must replace the storage boundary with authenticated backend persistence, durable evidence storage, server-enforced review permissions/thresholds, moderation and audited external integrations. Never treat demo identities as production authentication.

Verification: `npm test`, `npm run typecheck`, `npm run build`. No lint script is configured. Manual checks: create case; independently mark both images or mark one Not visible; test keyboard/Cancel/Escape; switch through five reviewers (four positive, one uncertain); switch to author, close and advance all simulated stages; reload to confirm evidence and votes remain; check narrow-screen stacking and missing local case URLs. Do not interpret test descriptions or demo votes as scientific observations.


Each community review entry and case detail offers **Open in blink viewer**. It opens a focused popup above the current review with that case’s original IndexedDB image evidence. The case or queue remains mounted underneath, preserving scroll and unsaved review input. The sky view and URL do not change. No archive pair is rediscovered. Playback, frame stepping, zoom, coverage and observation details remain available; **Back to review**, the popup close button, or Escape closes only the popup and restores focus to its opener. Missing evidence reports an error with retry/return controls rather than substituting other images. Closing the popup stops playback and releases its temporary image URLs. Saved evidence cannot be reflagged from this player; annotate a fresh analysis for a new case.


### Blink spectral selection

The archive Blink viewer has linked **Channel** and **Wavelength** selectors from the verified IRSA cube channel table. Either selector updates the same nominal channel; **Automatic** restores unrestricted pair selection. Blink selection is independent of the main map's channel and captured sky coordinates. Cube-blank channels do not establish archive coverage and are not disabled here. If metadata is unavailable, automatic analysis remains usable and the channel list can be retried.

Selections request `wavelength_um` from the backend, isolate query caches, and cancel/ignore stale requests. Actual observation wavelengths remain visible in Observation details; they need not equal the requested nominal wavelength. Both observations must include it within their calibrated passbands at the target. No matching verified pair produces an explicit error, not substitute imagery. Local FITS pairs retain fixed wavelengths and explain why switching requires archive mode. No new dependencies.

Archive blink also offers **Detector** (Automatic or 1–6). Detector changes are drafts until **Load observations**, independent of nominal channel/wavelength; incompatible selections report no matching observations rather than substituting another detector. Local FITS detector selection remains fixed.

**Field of view** changes the displayed area and required spatial/quality coverage, not wavelength matching. Pair wavelengths are calculated from metadata/calibration at the target's detector position and verified against each FITS file. Wavelength variation elsewhere in the field is reported as a warning, not a matching failure; apparent changes away from the target may reflect different wavelengths rather than variability.
