# **PROJECT: NASA Space Apps — Interactive Astronomical Sky Explorer**

## **Your role**

You are a senior full-stack engineer specializing in React, TypeScript, interactive scientific visualization, and API integration.

Build a complete, functional astronomical sky exploration web application inspired by:

**Reference:** [https\://skyserver.sdss.org/dr18/VisualTools/navi](https://skyserver.sdss.org/dr18/VisualTools/navi)

The application is the starting foundation for a NASA Space Apps Challenge project focused on visualizing SPHEREx observations and discovering changes in the sky.

**This iteration must replicate the core functionality of SDSS Navigate, but with a modern, polished, dark-themed interface.**

It is NOT yet necessary to implement SPHEREx time blinking, spectral visualization, image stacking, or automated astronomical discovery.

However, the architecture must allow these features to be introduced later without major refactoring.

This is a working scientific application, not a static mockup.

---

# **1\. Core principles**

1. Real astronomical imagery is mandatory.  
2. All navigation controls must work.  
3. Astronomical coordinates must remain scientifically meaningful.  
4. Do not generate synthetic star fields and present them as real data.  
5. Do not fabricate object metadata, magnitudes, classifications, or observation timestamps.  
6. Use public astronomical data services and document the sources.  
7. Implement actual frontend and backend functionality.  
8. Prioritize reliability and usability over decorative effects.  
9. Keep astronomy-specific functionality modular and replaceable.  
10. Deliver a locally runnable project with clear setup instructions.

Inspect the existing repository before creating files. Preserve existing useful code, dependencies, and conventions where practical.

If browser access is available, inspect the reference SDSS Navigate website to understand its layout, controls, and interaction patterns.

Do not copy SDSS branding, logos, proprietary assets, or source code. Reimplement the functionality with an original interface.

---

# **2\. Technology stack**

## **Frontend**

* React  
* Vite  
* TypeScript with strict typing  
* Tailwind CSS  
* Lucide React for icons  
* TanStack Query for API request state and caching  
* Zustand or React Context for global viewer state

Use HTML Canvas or another suitable rendering approach for displaying images, coordinate interactions, overlays, and pointer interactions.

Do not introduce a complex WebGL engine unless it provides a clear benefit.

## **Backend**

Use Python 3.11+ with FastAPI.

Recommended packages:

* FastAPI  
* Uvicorn  
* httpx  
* Pydantic  
* Astropy  
* NumPy  
* Pillow  
* pytest

Astropy should be available for future FITS and World Coordinate System (WCS) integration.

Do not require Astropy for operations that can be safely implemented using simpler methods, but do not substitute simplistic coordinate approximations where accurate transformations are necessary.

## **Project organization**

Use a monorepo structure:

```
project/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   ├── viewer/
│   │   │   ├── navigation/
│   │   │   ├── search/
│   │   │   └── objects/
│   │   ├── hooks/
│   │   ├── services/
│   │   ├── stores/
│   │   ├── types/
│   │   ├── utils/
│   │   └── App.tsx
│   └── package.json
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── api/
│   │   ├── providers/
│   │   ├── services/
│   │   ├── models/
│   │   └── utils/
│   ├── tests/
│   └── requirements.txt
├── README.md
└── .env.example
```

Use clean separation between UI components, state management, astronomical coordinate utilities, external API providers, and backend business logic.

---

# **3\. Visual design**

Create a professional astronomy exploration interface.

The application should feel like a modern scientific research tool, but remain approachable for beginners.

## **Visual direction**

* Dark theme by default.  
* Near-black backgrounds.  
* Deep navy and charcoal panels.  
* Muted borders.  
* Cool blue/cyan accent color.  
* Subtle shadows and hover states.  
* Clean typography.  
* Compact but readable controls.  
* Rounded panels, approximately 8–12px radius.  
* No excessive gradients, glowing effects, or decorative animations.

The actual astronomical imagery must be the visual focus.

## **Desktop layout**

Design primarily for a 1440×900 desktop viewport, while remaining responsive.

Use three main regions:

### **A. Top navigation bar**

Height approximately 56–64px.

Left:

* Temporary project logo/icon.  
* Product name: "Sky Explorer".  
* Subtitle or badge: "NASA Space Apps Prototype".

Center:

* Prominent object search field.  
* Search icon.  
* Keyboard shortcut hint if implemented.

Right:

* Current data source: "SDSS DR18".  
* Help button.  
* Copy/share link button.

The header should remain fixed.

### **B. Left sidebar**

Width approximately 280–320px.

Contains navigation controls, coordinates, viewing options, and suggested destinations.

### **C. Main viewer and right inspector**

The viewer should occupy most of the available screen.

The right inspector should be approximately 300–340px wide and display selected-object information.

Allow the right inspector to collapse.

The viewer should expand to fill available space.

## **Responsive layout**

At narrower viewport widths:

* Left sidebar becomes collapsible.  
* Right inspector becomes a drawer.  
* Viewer remains the primary element.  
* Important controls remain accessible.  
* Avoid horizontal page overflow.

---

# **4\. Main astronomical viewer**

This is the most important component.

## **Image display**

Display real astronomical imagery retrieved from SDSS.

Initial default position:

* RA: 180.0 degrees  
* Dec: 0.5 degrees  
* Scale: 0.4 arcseconds per pixel

If this location lacks usable coverage, use another verified SDSS-covered location.

Render the image inside a black or near-black viewer container.

The viewer must support:

1. Drag-to-pan.  
2. Mouse-wheel zoom.  
3. Trackpad scrolling/zooming.  
4. Directional navigation buttons.  
5. Zoom in and zoom out buttons.  
6. Reset view.  
7. Recenter on coordinates.  
8. Clicking on sky positions.  
9. Coordinate display under the cursor.  
10. Loading and error states.

## **Image rendering strategy**

SDSS provides rectangular JPEG cutouts centered at specified sky coordinates.

Implement an image request system that retrieves a new cutout when the sky position or scale changes.

For responsiveness:

* During dragging, visually translate the existing image.  
* On pointer release, calculate the new celestial center.  
* Request the new image.  
* Replace the old image when the new image has loaded.  
* Preserve the old image while the request is pending.  
* Prevent outdated requests from overwriting newer navigation results.

Use a similar approach for zooming.

Debounce wheel-based navigation and avoid issuing excessive requests.

Do not make an API request for every pointer movement.

## **Coordinate accuracy**

Use Right Ascension and Declination in the ICRS/equatorial coordinate system.

RA:

* 0 ≤ RA \< 360 degrees.  
* Wrap around correctly at 0/360 degrees.

Dec:

* \-90 ≤ Dec ≤ \+90 degrees.

The initial implementation may use a documented local tangent-plane approximation for small fields of view.

However:

* Do not use the same approximation indiscriminately near the celestial poles.  
* Account for the cos(Dec) factor in RA offsets.  
* Treat RA as increasing toward celestial east; the displayed orientation must be explicit.  
* Handle axis orientation consistently.  
* Avoid introducing coordinate drift through repeated pixel-based translations.  
* Derive new positions from the current absolute sky coordinates and image projection.

For accurate pixel-to-sky conversions, especially for future FITS integration, create an abstraction that can use Astropy WCS.

For SDSS JPEG cutouts, do not claim that an exact FITS WCS is available unless one has actually been retrieved or derived from documented image geometry.

## **Zoom behavior**

The SDSS image service uses scale in arcseconds per pixel.

Smaller scale values mean higher zoom.

Provide:

* Zoom in.  
* Zoom out.  
* Mouse-wheel zoom.  
* A visible zoom/scale indicator.

Suggested initial zoom levels:

0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4 arcseconds/pixel.

Treat these as configurable values, not guaranteed universally supported service limits.

If the service rejects a requested scale, handle the error gracefully.

Zoom should ideally preserve the sky position under the pointer, not merely zoom toward the center.

## **Field of view**

Display the approximate angular field of view.

For a small projected image:

FOV width ≈ image width × scale / 3600 degrees.

FOV height ≈ image height × scale / 3600 degrees.

Label this as approximate when projection effects matter.

---

# **5\. Navigation sidebar**

## **Section 1: Coordinates**

Heading: "Navigate to Coordinates"

Inputs:

* Right Ascension  
* Declination

Default display format: decimal degrees.

Allow signed decimal input.

Provide:

* "Go to location" button.  
* Clear validation errors.  
* Coordinate range hints.  
* Optional sexagesimal input mode.

Example:  
RA: 180.000000°  
Dec: \+0.500000°

Support sexagesimal coordinates if implemented:

RA: HH:MM  
Dec: ±DD:MM

Use correct conversion rules.

Do not interpret RA hours as degrees.

Pressing Enter in either input should submit the navigation request.

## **Section 2: Directional navigation**

Provide an eight-direction compass control:

NW, N, NE, W, E, SW, S, SE.

Also provide a central recenter button if useful.

Directional buttons should shift the current field by approximately 50% of the visible field of view.

The shift amount must depend on the current zoom level.

Directions should be defined in celestial coordinates and correspond to the displayed sky orientation.

## **Section 3: Zoom**

Provide:

* Zoom in.  
* Zoom out.  
* Zoom slider or discrete scale control.  
* Current arcseconds/pixel.  
* Reset zoom.

## **Section 4: Image overlays**

Provide independently configurable options:

* Coordinate grid.  
* Coordinate labels.  
* Photometric object markers.  
* Spectroscopic object markers.  
* Image information labels.  
* Field outlines, if supported.

For SDSS-provided overlays, use the documented ImgCutout options where appropriate.

Known SDSS drawing options include:

* G: Grid  
* L: Labels  
* P: Photometric objects  
* S: Spectroscopic objects  
* O: Object outlines  
* B: Bounding boxes  
* F: Field outlines  
* M: Masks  
* Q: Plates  
* I: Invert image

Do not assume every option is supported identically in every data release.

Prefer drawing the grid and crosshair as separate frontend overlays when that improves interactivity.

Avoid duplicating a grid in both the image service and frontend.

Overlay state must persist when panning and zooming.

---

# **6\. Real SDSS image integration**

## **Primary service**

Investigate and integrate the SDSS DR18 Image Cutout service.

Candidate endpoint:

```
https://skyserver.sdss.org/dr18/SkyServerWS/ImgCutout/getjpeg
```

Example parameters:

```
ra=180.0
dec=0.5
scale=0.4
width=512
height=512
opt=
```

Before relying on the endpoint, verify it actually responds correctly.

If the endpoint has changed, use the current official equivalent and document the change.

Do not silently replace it with random internet images.

## **Backend image endpoint**

Implement:

```
GET /api/images/cutout
```

Parameters:

```
ra: number
dec: number
scale: number
width: integer
height: integer
overlays: string (optional)
survey: string (default "sdss")
```

The backend should:

1. Validate parameters.  
2. Normalize RA appropriately.  
3. Reject invalid Dec and scale values.  
4. Enforce reasonable image dimension limits.  
5. Construct the SDSS request.  
6. Fetch the image.  
7. Verify HTTP status and content type.  
8. Return the image with the correct MIME type.  
9. Cache repeated requests.  
10. Return meaningful errors.

Set sensible request timeouts.

Do not return a successful response containing an HTML error page.

## **Caching**

Implement a lightweight cache for image requests.

A filesystem cache or bounded in-memory cache is sufficient for the prototype.

Cache keys must include all parameters that affect image output.

Use request deduplication where practical.

Do not cache failures indefinitely.

## **Coverage**

SDSS does not cover every location in the sky.

When a user navigates to a location without imagery:

* Do not fabricate a star field.  
* Display an informative empty state.  
* Explain that SDSS coverage is unavailable at that position.  
* Offer a suggested location with known coverage.

Do not confuse a valid dark image with an API failure.

---

# **7\. Named-object search**

Implement a functional search field that accepts astronomical object names.

Examples:

* M31  
* M51  
* M87  
* NGC 891  
* Barnard's Star  
* Polaris

Use a real astronomical name-resolution service, such as CDS Sesame/SIMBAD, where appropriate.

Create:

```
GET /api/objects/resolve?name=M31
```

Return:

```
{
  "name": "M31",
  "ra": 0,
  "dec": 0,
  "resolver": "CDS Sesame",
  "resolved": true
}
```

The zero values above are schema placeholders, not actual M31 coordinates.

Use the real returned coordinates.

## **Search behavior**

* User types an object name.  
* Presses Enter or clicks Search.  
* Backend resolves the name.  
* Frontend navigates to the coordinates.  
* Search field displays the resolved name.  
* Show a clear error if the name cannot be resolved.

Support loading states.

Never fabricate search results.

If the service is temporarily unavailable, display an appropriate error.

Optional: implement autocomplete if a suitable real service is available.

Do not make autocomplete a dependency for completing the initial application.

---

# **8\. Suggested astronomical targets**

Create a "Explore the Universe" section.

Display a collection of suggested objects.

Suggested initial targets:

* Andromeda Galaxy (M31)  
* Whirlpool Galaxy (M51)  
* Messier 87  
* NGC 891  
* A verified SDSS deep-field location

Each target card should show:

* Object name.  
* Object category.  
* Short description.  
* "Explore" action.

Clicking Explore should navigate to the target's coordinates.

Use a small curated dataset of verified positions.

Do not invent coordinates.

Do not assume all suggested targets have SDSS imagery.

For the initial version, prioritize objects and fields with confirmed coverage.

Suggested targets should be configured separately from UI components so additional SPHEREx targets can be added later.

---

# **9\. Random sky location**

Add a prominent button:

"Take me somewhere random"

The button should navigate to a random astronomical field.

Important: SDSS does not provide uniform all-sky image coverage.

Therefore, do not simply choose uniform random RA and Dec values and assume imagery will exist.

For this iteration:

* Maintain a curated list of verified SDSS-covered sky positions.  
* Randomly select from that list.  
* Avoid repeating the immediately previous destination when possible.  
* Display the selected coordinates.  
* Load the actual SDSS image.

Later, this can be replaced with a coverage-aware random sampling system.

Keep the random-location logic independent of the SDSS provider.

---

# **10\. Object selection and inspection**

Replicate the useful object-inspection workflow of SDSS Navigate.

## **Clicking the image**

When a user clicks on a sky location:

1. Determine the clicked pixel position.  
2. Convert it to an estimated celestial coordinate.  
3. Display a crosshair or selection marker.  
4. Open/update the right inspector.  
5. Query nearby catalogued objects, if a supported service is available.

Separate the clicked sky position from any identified catalogue object.

A click does not guarantee that a real catalogued object exists at that position.

## **Right inspector**

Default state:

"Select an object or sky position to inspect."

After selection, display:

* Selected RA.  
* Selected Dec.  
* Current image scale.  
* Current survey.  
* Selection crosshair.  
* Optional close-up image.  
* Nearest catalogue object, if identified.

If a catalogue match is available, additionally display:

* Object identifier.  
* Object type.  
* Angular separation from click.  
* Available magnitudes.  
* Relevant links to SDSS Object Explorer.

Only show metadata actually returned by a verified service.

## **Catalogue query endpoint**

Implement:

```
GET /api/objects/nearby
```

Parameters:

```
ra
dec
radiusArcsec
limit
```

Use an official SDSS catalogue search endpoint or another documented supported service.

Use bounded queries and strict input validation.

Do not accept arbitrary SQL submitted directly from the browser.

If SQL is necessary, construct fixed, parameter-validated queries server-side.

## **Selection accuracy**

For the initial JPEG-based viewer, clearly distinguish approximate click coordinates from precise catalogue positions.

When a real catalogue match is returned, use its actual RA/Dec in the inspector.

Do not claim pixel-perfect astrometry unless supported by the underlying image projection.

---

# **11\. Viewer toolbar**

Add a compact floating toolbar.

Suggested actions:

* Pan mode.  
* Select mode.  
* Zoom in.  
* Zoom out.  
* Recenter.  
* Toggle grid.  
* Copy coordinates.  
* Copy share link.  
* Fullscreen.

All visible buttons must work.

Do not display controls that have no implementation.

Use tooltips with concise explanations.

Suggested keyboard shortcuts:

* Arrow keys: pan.  
* Plus/minus: zoom.  
* Escape: clear selection.  
* G: toggle grid.  
* R: reset view.

Avoid interfering with keyboard input when a text field is focused.

---

# **12\. Coordinate display and status bar**

Display a compact status bar along the bottom of the viewer.

Include:

* Center RA.  
* Center Dec.  
* Cursor RA.  
* Cursor Dec.  
* Image scale.  
* Approximate FOV.  
* Data source.  
* Loading status.

Example:

```
RA 180.0000° | Dec +0.5000°
Scale 0.40"/px | FOV 8.5' × 8.5'
Source: SDSS DR18
```

Update the cursor coordinates when the pointer moves over the image.

Throttle calculations if necessary.

Use consistent decimal precision.

Show unavailable values as unavailable rather than displaying fake zeros.

---

# **13\. Shareable URLs**

Viewer state should be encoded in URL query parameters.

Example:

```
/?ra=180&dec=0.5&scale=0.4&survey=sdss&grid=true
```

Support:

* RA.  
* Dec.  
* Scale.  
* Survey.  
* Grid visibility.  
* Other useful viewing options.

On page load:

1. Parse URL parameters.  
2. Validate them.  
3. Initialize the viewer.  
4. Load the corresponding image.

Update the URL when navigation settles.

Avoid pushing a new browser history entry for every tiny drag or wheel movement.

Browser Back and Forward should work sensibly.

Provide a "Copy link" button.

---

# **14\. Backend architecture**

Build a provider-based system.

The frontend must not depend directly on SDSS-specific API response formats.

Define a common image provider interface.

Conceptually:

```
class ImageProvider:
    async def get_cutout(self, request):
        ...

    async def get_metadata(self, request):
        ...
```

Implement:

```
SDSSImageProvider
```

Do not implement a fake SPHEREx provider that returns SDSS imagery.

Reserve a clean integration point for a future:

```
SPHERExImageProvider
```

## **Image metadata model**

Use a common schema that can accommodate future science products.

Suggested fields:

```
survey
release
ra
dec
width
height
pixelScaleArcsec
projection
observationTime
wavelengthMicrons
coordinateSystem
calibrationStatus
sourceUrl
```

Fields that do not apply to SDSS JPEG cutouts must be nullable.

Do not fabricate observation timestamps or wavelength values.

For future SPHEREx FITS data, this model should support real timestamps, spectral channels, and WCS metadata.

## **Required backend routes**

```
GET /api/health

GET /api/surveys

GET /api/images/cutout

GET /api/objects/resolve

GET /api/objects/nearby

GET /api/targets/suggested

GET /api/targets/random
```

Provide OpenAPI documentation through FastAPI.

Use consistent JSON error responses.

---

# **15\. Future SPHEREx integration requirements**

This section is architectural preparation only.

Do not implement full SPHEREx functionality during this iteration.

The NASA Space Apps challenge requires users to explore sky images across observation times and wavelengths.

The future system must support:

1. SPHEREx FITS images.  
2. IRSA archive queries.  
3. Spectral channel selection.  
4. Observation timestamps.  
5. Multiple epochs.  
6. Time blinking.  
7. Wavelength blinking.  
8. Image normalization.  
9. Difference imaging.  
10. WCS alignment.  
11. Band stacking.  
12. Astronomical catalogue cross-matching.

## **Official SPHEREx archive**

Reference:

[https\://irsa.ipac.caltech.edu/Missions/spherex.html](https://irsa.ipac.caltech.edu/Missions/spherex.html)

Documentation:

[https\://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)

IRSA provides access to SPHEREx data through documented archive services, including IVOA SIA2.

Future backend implementation should use official services rather than scraping web pages.

## **Data product distinction**

SPHEREx data may include:

* Individual timestamped spectral images.  
* Combined images and mosaics.  
* All-sky spectral cubes.

These are not interchangeable.

For detecting motion, preserve observation timestamps and use appropriate independently observed images.

Do not assume that the 102 spectral channels correspond to 102 simultaneous ordinary-filter exposures.

## **Future frontend structure**

Organize viewer state so it can later include:

```
interface FutureObservationState {
  survey: string;
  observationId?: string;
  observationTime?: string;
  wavelengthMicrons?: number;
  spectralChannel?: number;
}
```

Avoid tightly coupling image navigation with a single static JPEG.

The eventual viewer should be able to switch among images while maintaining the same celestial center, field of view, and coordinate alignment.

## **Important**

Do not add nonfunctional SPHEREx controls to the current UI.

The objective is to create a strong foundation, not a misleading demonstration of features that do not yet exist.

---

# **16\. State management**

Create a centralized viewer state.

Suggested TypeScript model:

```
interface ViewerState {
  centerRa: number;
  centerDec: number;
  scaleArcsecPerPixel: number;

  survey: string;

  showGrid: boolean;
  showLabels: boolean;
  showPhotoObjects: boolean;
  showSpecObjects: boolean;

  interactionMode: "pan" | "select";

  selectedPosition: {
    ra: number;
    dec: number;
  } | null;

  isLoading: boolean;
}
```

Keep temporary pointer-drag state separate from persistent celestial coordinates.

Use TanStack Query for server data and caching.

Do not store large image binary data in global application state unnecessarily.

---

# **17\. Loading, error and empty states**

Every network-dependent feature must have meaningful states.

## **Image loading**

Display a subtle loading indicator.

Keep the previous image visible until the new image loads, where appropriate.

## **API unavailable**

Show:

"Unable to load astronomical imagery. Please try again."

Provide Retry.

## **No coverage**

Show:

"No SDSS imagery is available for this sky region."

Provide a suggested covered destination.

## **Name resolution failure**

Show:

"We couldn't find that astronomical object."

## **Invalid coordinates**

Show specific validation errors.

Examples:

* "Declination must be between \-90° and \+90°."  
* "Enter a valid right ascension."

## **General requirements**

* Never silently fail.  
* Never display a broken image icon as the intended empty state.  
* Never use placeholder data without labeling it.  
* Avoid infinite loading spinners.  
* Log useful technical details on the backend without exposing sensitive internals to users.

---

# **18\. Performance requirements**

Target a smooth desktop experience.

Requirements:

* Smooth dragging.  
* Responsive zoom controls.  
* Debounced image requests.  
* No unnecessary full-page rerenders.  
* No overlapping stale requests.  
* Image caching.  
* Proper cleanup of event listeners.  
* Avoid memory leaks.  
* Lazy-load optional panels where appropriate.

Do not download enormous full-resolution images unnecessarily.

Use reasonable backend limits on requested image dimensions.

Support retina displays without blindly doubling image requests beyond service limits.

Ensure that API failures do not freeze navigation.

---

# **19\. Accessibility and usability**

Implement:

* Keyboard-accessible controls.  
* Visible focus indicators.  
* Semantic labels.  
* Sufficient text contrast.  
* Tooltips for technical controls.  
* Descriptive error messages.  
* Responsive layouts.  
* Sensible tab navigation.

Do not rely on color alone to communicate state.

For unfamiliar astronomical terminology, add small explanatory tooltips.

Examples:

RA: "Right Ascension, the sky's equivalent of longitude."

Dec: "Declination, the sky's equivalent of latitude."

Scale: "Angular distance represented by each image pixel."

---

# **20\. Testing**

Create automated tests for the backend and coordinate utilities.

## **Backend tests**

Test:

* Valid image request.  
* Invalid RA/Dec.  
* Invalid scale.  
* Invalid image dimensions.  
* Upstream timeout.  
* Upstream HTTP error.  
* Unexpected content type.  
* Cache behavior.  
* Object resolution failure.  
* Nearby-object query validation.

Mock external services in unit tests.

## **Frontend tests**

Test:

* Coordinate form validation.  
* Navigation state updates.  
* Zoom behavior.  
* Overlay toggles.  
* URL state parsing.  
* Search success and failure.  
* Loading and error states.

## **Astronomy-specific tests**

Test:

* RA wraparound.  
* Negative declination.  
* High declination behavior.  
* Small angular offsets.  
* Directional panning.  
* Approximate FOV calculations.  
* Pixel-to-coordinate consistency.  
* Zoom in/out round trips.

Explicitly test near RA 0°/360°.

Do not rely solely on screenshots to validate coordinate correctness.

---

# **21\. Acceptance criteria**

The application is complete only when all of the following are true.

### **Core viewer**

* Real SDSS imagery loads.  
* User can enter RA and Dec.  
* User can drag to pan.  
* Directional buttons pan correctly.  
* Mouse wheel zoom works.  
* Zoom buttons work.  
* Image scale updates correctly.  
* Grid overlay works.  
* Cursor coordinates are displayed.  
* Clicking selects a sky position.

### **Search and discovery**

* Named-object search works using a real resolver.  
* Suggested targets navigate correctly.  
* Random-location button works.  
* Random locations use verified covered regions.

### **Object inspector**

* Selected coordinates appear.  
* Catalogue information is shown when genuinely available.  
* Missing catalogue matches are handled correctly.  
* Selection markers remain aligned with the displayed image.

### **Backend**

* FastAPI server runs.  
* SDSS image proxy works.  
* Object-resolution endpoint works.  
* Validation is implemented.  
* Errors are handled.  
* Caching works.  
* API documentation is accessible.

### **Quality**

* Responsive layout.  
* No nonfunctional visible controls.  
* No fabricated astronomical data.  
* No broken images.  
* No significant console errors.  
* Tests pass.  
* README explains setup and limitations.

---

# **22\. Development process**

Follow this implementation order.

## **Phase 1 — Project setup**

Create the React/Vite frontend and FastAPI backend.

Configure TypeScript, Tailwind, API communication, and development scripts.

## **Phase 2 — Real image retrieval**

Implement and test the SDSS image proxy.

Confirm that real images can be retrieved before building elaborate UI components.

## **Phase 3 — Core viewer**

Implement image rendering, coordinates, pan, zoom, and directional navigation.

Verify coordinate behavior.

## **Phase 4 — Interface**

Build the header, sidebar, viewer toolbar, inspector, and status bar.

Apply the dark design system.

## **Phase 5 — Search and exploration**

Implement named-object search, suggested targets, and random sky location.

## **Phase 6 — Object inspection**

Implement selection, coordinate conversion, and catalogue lookup.

## **Phase 7 — Polish and testing**

Implement error handling, caching, responsive behavior, tests, and documentation.

---

# **23\. README requirements**

Include:

1. Project overview.  
2. Technology stack.  
3. Installation instructions.  
4. How to run frontend and backend.  
5. Required environment variables.  
6. API endpoint documentation.  
7. Data source attribution.  
8. Known limitations.  
9. Coordinate assumptions.  
10. Future SPHEREx integration plan.

Provide exact terminal commands for running the project locally.

Avoid requiring paid services or API keys unless absolutely necessary.

---

# **24\. Final deliverables**

Produce:

* Working React/Vite frontend.  
* Working FastAPI backend.  
* Real SDSS image integration.  
* Functional astronomical navigation.  
* Functional named-object search.  
* Functional object inspection.  
* Suggested targets.  
* Random-location navigation.  
* Modern dark interface.  
* Tests.  
* README.  
* Modular architecture for SPHEREx.

Do not stop after generating scaffolding.

Actually implement the features, run the available tests, fix errors, and verify the application works.

If an external service is inaccessible in the development environment, isolate that dependency, document the limitation, and provide a clear way to verify it later.

Do not claim that an external integration was successfully tested if it was not.

At the end, summarize:

1. What was implemented.  
2. What was actually tested.  
3. Which external services were verified.  
4. Known limitations.  
5. How to run the application.  
6. What should be implemented next for SPHEREx.

**Begin implementation now.**

