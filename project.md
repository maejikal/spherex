# Sky Explorer — project scope

Updated 2026-11-15 to describe the current working tree, not a future implementation prompt. Setup, configuration, API routes and attribution live in [README.md](README.md); component details live in [frontend/README.md](frontend/README.md) and [backend/README.md](backend/README.md).

## Purpose and current direction

Build a public-facing astronomical explorer for the NASA Space Apps SPHEREx challenge: explore real infrared imagery, inspect catalogue context, and compare suitable timestamped observations. The product is a working prototype, not a validated discovery or photometry pipeline.

SDSS Navigate inspired the interaction model, not the current data source. The earlier SDSS JPEG-cutout specification is superseded by the implemented SPHEREx HiPS and FITS workflows. SDSS imagery, SkyServer queries and the old `/api/images/cutout` endpoint are not part of the current application. No SDSS branding or source code is reused.

## Implemented experience

- **Explore:** Aladin Lite renders the NASA/IPAC IRSA SPHEREx DR1 all-sky HiPS cube. Pan, zoom, compass navigation, coordinate entry, reset, picking, grid and shareable URLs operate on celestial view state.
- **Choose wavelength:** a 102-frame selector uses the source wavelength table. Frames 50 and 51 are marked without imagery and skipped by previous/next. Wavelength selection is not time navigation or quantitative spectral extraction.
- **Find:** CDS Sesame resolves object names. Suggested and random destinations use the separately stored tile-verified target dataset. Tile signal is not proof of an individual object's detection.
- **Inspect:** selected coordinates remain distinct from SIMBAD catalogue positions. Analyze area requests nearby catalogue matches; these are not labelled SPHEREx detections.
- **Constellations:** selection triggers local Astropy IAU membership; optional sampled official boundaries and a read-only overview provide context independently of catalogue analysis.
- **Compare epochs:** Analyze area captures a position and opens a Blink viewer. Archive mode discovers and verifies an eligible pair; local demo compares two configured FITS exposures. Playback supports speed, stepping and display zoom. Moving the main camera does not retarget an open analysis.
- **Workspace:** dark, imagery-first Find / View / Inspect tools support floating and docked desktop layouts. Narrow screens use a single bottom sheet; blink and inspector remain separately accessible.

## Two distinct image paths

### All-sky exploration

The browser fetches HiPS metadata and tiles directly from IRSA through the Aladin integration. Zustand stores persistent celestial view; TanStack Query owns request state. The cube combines observations and has no single exposure epoch. Its 8-bit stretched tiles are visualization products, not calibrated photometry. There is no backend proxy for this main-sky tile path.

### Timestamped FITS analysis

FastAPI owns IRSA SIA discovery, observation grouping, detector calibration, candidate ranking, FITS downloads, exact pair verification, WCS resampling and PNG display generation. It returns genuine observation metadata and explicit rejection reasons.

Archive pairs must pass same-detector wavelength/bandwidth, position, calibration and coverage checks. Metadata-based predictions rank candidates; downloaded FITS checks decide acceptance. Shared output TAN grids can rotate to fit the field. The two local files provide a restricted-area demo, not a substitute for failed archive discovery.

Masking excludes NONFUNC and MISSING_DATA flags; other flags remain visible. Archive mode additionally excludes invalid science/variance and reports caution flags. Resampling is mask-aware bilinear interpolation, not flux conserving. Display uses additive per-frame background subtraction and a common clip/asinh stretch; underlying calibrated values are not multiplicatively normalized. Pair thresholds remain engineering heuristics, not scientifically validated variability criteria.

## Architecture and stack

- **Frontend:** React 19, strict TypeScript, Vite 6, Tailwind CSS 4, Lucide React, TanStack Query, Zustand and pinned Aladin Lite 3.8.2. WebGL is required for spherical HiPS rendering.
- **Backend:** Python 3.11+, FastAPI, Uvicorn, Pydantic/settings, httpx, defusedxml, Astropy and NumPy (installed through Astropy). Tests use pytest/respx; frontend tests use Node's test runner.
- **Boundaries:** React presentation, persistent view state, API validation, Aladin controller and SPHEREx channel logic remain separate. Backend routes delegate to providers/services; FITS alignment is separate from PNG display and HTTP response construction.
- **Storage:** curated targets and constellation tables are repository data; optional FITS files remain outside version control. Archive FITS/calibration files use a bounded disk cache; service results also use process-local caches. No database or account system is configured.

Actual module map and commands are in the root README. Preserve these boundaries through incremental changes; do not replace the implemented viewer with the obsolete SDSS architecture.

## Astronomy and integrity contract

1. Use ICRS coordinates: RA wraps at 360 degrees, Dec remains within ±90 degrees. Never confuse RA hours with degrees. Main-sky projection belongs to Aladin; FITS alignment uses Astropy WCS rather than a universal small-angle approximation.
2. Keep scale in arcseconds per CSS pixel for the main view. Blink output has its own reported pixel scale, field size and orientation. Neither zoom nor reprojection creates spatial resolution.
3. Never fabricate images, catalogue matches, wavelengths, timestamps, coverage or classifications. Preserve identifiers, source, units and per-observation times; unavailable metadata stays unavailable.
4. Do not equate all-sky HiPS coverage with local FITS coverage or an acceptable archive pair. Distinguish missing data, quality rejection and upstream failure.
5. Never present wavelength channels as simultaneous ordinary-filter exposures or independent time frames. A visually changing source is not automatically astrophysical variability.
6. Bound and validate service inputs, construct catalogue queries server-side, allowlist upstream downloads, and keep local FITS paths server-configured.
7. Show meaningful loading/error/retry states, avoid stale responses, and never silently change data sources.
8. Preserve keyboard access, visible focus, semantic labels, responsive control access and non-color-only status cues. No placeholder controls.

## Current limits

- HiPS order-5 imagery is approximately 12.9 arcseconds/pixel, coarser than native detector sampling. Deep zoom magnifies existing pixels.
- Local demo files are not bundled; their footprint limits analysis. Archive mode depends on live IRSA availability and can be expensive on first access.
- Same-detector wavelength matching reduces, but does not eliminate, false variability from spectral response, quality flags, backgrounds and interpolation.
- Sampled constellation outlines and the overview are visual context, not precision boundary tests; membership comes from Astropy.
- Shared URLs restore the sky view, not a complete analysis session or desktop layout. Caches and random-selection history are not coordinated between workers.
- Current implementation is documented from source. Prior service-verification notes are not a guarantee of present availability; mocked tests do not replace live integration checks.

## Next work — not current features

1. Validate archive-pair selection and flag policy across representative fields, detectors and epochs; record scientific acceptance criteria and reproducible reference cases.
2. Add calibrated difference imaging, uncertainty propagation and artifact controls before quantitative variability claims.
3. Extend beyond two-frame playback to observation sequences and light curves while retaining independent timestamps and wavelength provenance.
4. Explore stacking, quantitative spectral visualization and assisted discovery as separate analysis capabilities, not reinterpretations of HiPS tiles.
5. Harden deployment, cache/concurrency behavior, accessibility and service diagnostics with measured tests.

Continue using official IRSA observation products for future analysis. The current FITS service boundary already supports timestamped data; a fictional SPHEREx provider backed by another survey is never acceptable.

## Verification and delivery

Run backend tests, frontend tests, type checking and production build after code changes; use `git diff --check` for documentation-only changes. Test coordinate/state behavior and scientific processing with deterministic fixtures and mocked services. Validate live services separately before claiming integrations work, including the FITS pipeline rather than only health probes.

Keep README commands and API descriptions aligned with source. Preserve unrelated work, ask before adding dependencies outside the agreed stack, and document limitations rather than inventing successful data or hiding failed checks.
