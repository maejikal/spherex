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
| `GET /api/blink/cutouts?ra=&dec=&size=256` | Aligned May/December SPHEREx cutouts of one position from the two local FITS files (see "Blink viewer"). `size` 32-512 px. |
| `GET /api/blink/dynamic?ra=&dec=&fov_deg=0.1` | **Archive mode.** Discovers SPHEREx DR1 observations at any position through NASA/IPAC IRSA, picks a wavelength-matched two-epoch pair, downloads cutouts, verifies the exact wavelength, and returns aligned frames + provenance. `fov_deg` 0.02-0.5. See "Dynamic blink". |
| `GET /api/blink/dynamic/images/{frame_id}.png?ra=&dec=&fov_deg=` | PNG for one archive frame (URLs come from the endpoint above). |
| `GET /api/blink/modes` | `{dynamic_enabled, local_demo_available}`: which blink modes this server offers. |
| `GET /api/blink/images/{frame_id}.png?ra=&dec=&size=` | The PNG for one frame (`image/png`, grey + alpha, north up, east left). URLs come from `/blink/cutouts`. |

Errors always use `{"error": {"code", "message"}}`: `invalid_parameters` (422), `unsupported_survey` (400), `object_not_found` (404), `upstream_timeout` (504),
`upstream_unavailable` / `upstream_invalid_response` / `catalogue_unavailable` (502), `internal_error` (500), `not_found` (404),
`no_fits_coverage` (404), `fits_unavailable` (503), `fits_processing_error` (500). Archive mode adds the 404 reasons
`no_observations`, `insufficient_coverage`, `wavelength_mismatch`, `invalid_calibration` and `quality_failure` (the viewer shows the message), and
reports an unreachable archive as `upstream_unavailable` (502) / `upstream_timeout` (504).

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

## Blink viewer (local SPHEREx FITS)

Two real SPHEREx Level-2 detector images of the same field, observed about six months apart, are compared by
blinking. They are read from **fixed server-side paths**; no request can name a file.

| Variable | Default |
| --- | --- |
| `SKY_BLINK_FITS_FILES` (JSON list) | `["~/Downloads/spherex_D5_2025_05_full.fits","~/Downloads/spherex_D5_2025_12_full.fits"]` |
| `SKY_BLINK_PIXEL_SCALE_ARCSEC` | `6.15` (native is about 6.14-6.15) |
| `SKY_BLINK_DEFAULT_SIZE` / `_MIN_SIZE` / `_MAX_SIZE` | `256` / `32` / `512` pixels |
| `SKY_BLINK_MIN_COVERAGE_FRACTION` | `0.10`; a frame with less usable data than this in the cutout is "no coverage" |
| `SKY_BLINK_FULL_COVERAGE_FRACTION` | `0.95`; below this the response carries a partial-coverage warning |
| `SKY_BLINK_CACHE_ENTRIES` / `_TTL_SECONDS` | `24` / `3600` |

The files are large (about 65 MB) and git-ignored (`*.fits`); keep them outside the repository.

**Processing** (`services/fits_cutout.py`, `fits_display.py`, `blink_service.py`):

1. Each file is validated once: `IMAGE` HDU, 2-D, `BUNIT = MJy / sr`, celestial RA/Dec TAN(-SIP) WCS in ICRS, usable data, observation time.
   Metadata is cached and re-checked against the file's mtime/size; pixels are never held in memory between requests.
2. A shared **north-up, east-left TAN grid** is built around the requested position (default 256 x 256 at 6.15"/px, about 26').
3. Every output pixel is mapped into each exposure with astropy's full SIP-aware `all_world2pix` and sampled by **bilinear interpolation**,
   reading only the needed sub-image through memory mapping. The May and December images are rotated about 180 degrees relative to each
   other, so this step (not raw pixel blinking) is what makes stars coincide. Bilinear sampling is **not flux-conserving** reprojection:
   it slightly smooths data and correlates noise. Invalid pixels never leak into neighbours (normalised weights).
4. **Masking**: non-finite pixels, pixels outside an exposure's footprint, and pixels whose `FLAGS` plane is named OVERFLOW, SUR_ERROR,
   NONFUNC, MISSING_DATA, HOT, NONLINEAR, STREAK, BLOOM or SNOWBALL (resolved from the file's own `MSKN####` header cards). `SOURCE`
   (about 31 % of pixels, the stars themselves) and the soft/informational planes (TRANSIENT, HALO, OUTLIER, COLD, PERSIST, ...) are **not** masked.
   Masked pixels are transparent in the PNG, never black sky.
5. **Display**: a per-frame median **additive** background is removed (the two files differ by about 0.05 MJy/sr), then one **common**
   percentile clip (1-99.7 %) and asinh stretch is applied to both frames. There is no multiplicative rescaling, so real brightness changes
   survive. This is display scaling, not photometric calibration; calibrated arrays stay in MJy/sr inside the service for future differencing.
6. **Wavelength**: SPHEREx uses linear variable filters, so wavelength varies across the detector (`WCS-WAVE`, 3.8-4.4 um for detector 5).
   Because the exposures are rotated, the same sky position can fall at different wavelengths in the two frames; the response reports the
   per-frame mean and adds a warning when they differ by 0.05 um or more.

Coverage: no usable data in either frame returns `404 no_fits_coverage`; partial coverage returns the frames plus a warning.
CPU-bound work runs in FastAPI's thread pool behind one lock; results (JSON and both PNGs) are cached in a bounded TTL cache keyed by
position, size and file signatures.

## Dynamic blink (NASA/IPAC archive)

`GET /api/blink/dynamic` builds a two-epoch blink for any position the archive covers. Nothing is hard-coded to a target.

**Why wavelength matters.** SPHEREx uses linear variable filters: the central wavelength at a pixel depends on where on the detector the
position fell, so two exposures of one field can sample different wavelengths and produce false "variability". The pipeline therefore
selects pairs by wavelength and re-checks the exact wavelength from the downloaded FITS before accepting a pair.

**Pipeline** (`services/pair_selection.py`, `spherex_calibration.py`, `irsa_archive.py`, `dynamic_blink.py`):

1. **Discovery.** IRSA SIA2 (`COLLECTION=spherex_dr1`, `POS=CIRCLE ra dec 0.001`) returns a VOTable. Rows are validated (each is skipped and reported if
   unusable), duplicates collapsed (the archive lists every observation twice), `s_region` polygons parsed (RA wrap, closing vertex), and
   observations grouped into epochs by their actual timestamps (a new epoch after a gap > `SKY_EPOCH_GAP_DAYS`).
2. **Prediction from metadata only.** The polygon's four vertices are taken as the detector corners and fitted with an affine map (in a sky-offset
   frame) to predict the target's detector position (accurate to roughly 10 px, not a bound), the wavelength/bandwidth there, and for which of 12 orientations
   (0-165 deg) the whole field fits inside the detector minus a 20-pixel buffer. The tested footprint is taken from the output grid's own WCS.
3. **Calibration.** Each detector's `WCS-WAVE` table (X, Y control points, VALUES = [wavelength um, bandwidth um]) is cached per detector and version
   (the header's `[CALIB] spectral_wcs <id>`), never shared between detectors. It is seeded from local full images when present
   (`SKY_BLINK_CALIBRATION_SEED_FILES`), else bootstrapped from one tiny IRSA cutout per detector (about 8 s, once, then cached on disk).
4. **Ranking.** Cross-epoch, same-detector pairs, deterministic: wavelength gap relative to the bandwidth, bandwidth match, detector-edge margin, epoch
   separation, rotation closest to north-up, observation ids. The wavelength spread *across the field* is checked as well as at the target.
5. **Verification (best candidate first, up to `SKY_TOP_PAIRS_TO_TRY`).** Cutouts (1.5x the field, `center=ra,dec d&size=`) are downloaded, validated and cached atomically.
   Cutout pixel positions are converted to full-detector positions (`x_full = x_local + CRPIX_full - CRPIX_cutout`, with `CRPIX_full = (detector size + 1) / 2`
   from the archive's `s_xel`, **not** a constant) before the calibration lookup, and cross-checked against the metadata prediction (`SKY_MAX_POSITION_ERROR_PX`);
   a mismatch rejects the candidate. Then: exact wavelength/bandwidth gap, geometric coverage, common good-quality coverage. A failing pair falls through to the next one;
   if none passes, the error reason says why. Nothing is ever substituted from another source.
6. **Reprojection** reuses the tested mask-aware bilinear resampler (SIP-aware `all_world2pix`) onto one shared TAN grid (odd size, target on the centre pixel, optional rotation).
   Hard-invalid pixels (OVERFLOW, SUR_ERROR, NONFUNC, MISSING_DATA, HOT, COLD, NONLINEAR, STREAK, BLOOM, SNOWBALL, non-finite or non-positive variance) are excluded; caution flags
   (TRANSIENT, PERSIST, OUTLIER, HALO) are kept and reported; **SOURCE and FULLSAMPLE are never masked**. Flag bitmasks are sampled nearest-neighbour, never interpolated.
   Display scaling is the same additive-background + shared asinh stretch as the local mode; calibrated values are not modified.

Settings (all `SKY_`-prefixed; pair-selection values are provisional engineering heuristics, not scientific thresholds): `BLINK_DYNAMIC_ENABLED`, `IRSA_SIA_URL`,
`IRSA_COLLECTION`, `IRSA_MAX_RETRIES`, `IRSA_BACKOFF_BASE`, `BLINK_CACHE_DIR` (default `backend/.cache/blink`, git-ignored), `BLINK_CACHE_MAX_BYTES` (1 GiB, LRU),
`DYNAMIC_FOV_DEFAULT/MIN/MAX`, `DYNAMIC_OVERSCAN`, `DYNAMIC_DETECTOR_BUFFER_PX`, `MAX_PAIR_GAP_NM`, `MAX_GAP_OVER_BANDWIDTH`, `MAX_FIELD_GAP_OVER_BANDWIDTH`,
`MAX_BANDWIDTH_DIFFERENCE_FRACTION`, `MIN_EPOCH_SEPARATION_DAYS`, `MIN_GEOMETRIC_COVERAGE`, `MIN_COMMON_GOOD_FRACTION`, `DYNAMIC_INTERP_MIN_WEIGHT` (default 0.99; 0.75 was
measured to recover about 2 points of coverage on the M101 reference pair but is not validated as a universal default).

The archive returns HTTP 502/503 intermittently. Calls have connect/read timeouts and bounded retries with exponential backoff; if IRSA stays down the API answers
`upstream_unavailable` and the local demo remains available only when the user chooses it. The first request for a new field downloads ~2 cutouts (about 10-20 s each);
repeats are served from the disk cache.
