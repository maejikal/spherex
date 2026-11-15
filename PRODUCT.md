# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: judges of the NASA Space Apps SPHEREx challenge, who evaluate the project in a few minutes and need to see quickly what it does and that it is real. Secondary audiences (students, amateur astronomers, researchers) are not confirmed and are not recorded as targets.

## Product Purpose

Sky Explorer is an interactive browser explorer for real NASA SPHEREx all-sky infrared imagery. It lets a visitor pan and zoom the sky, switch between the SPHEREx spectral channels with a wavelength selector, look up objects, and compare wavelength-matched observations in a blink viewer. Success is a judge understanding the data and the workflow without explanation.

## Positioning

Every image is real SPHEREx data (NASA/IPAC IRSA), with nothing fabricated. The whole sky and its 102 spectral channels are browsable in the browser with no login. A blink comparison can be flagged as an unusual feature and put through a peer-review workflow, which is a local demo and not a real discovery process.

## Operating Context

- Main sky: IRSA SPHEREx DR1 all-sky data cube HiPS, rendered by Aladin Lite 3.8.2, with tiles fetched directly from IRSA.
- Backend (FastAPI): survey metadata, name resolution, nearby-object lookup, constellation membership, and aligned FITS blink cutouts.
- Workspace: floating or docked Find / View / Inspect windows; bottom sheets on compact screens.
- Community review is browser-local (IndexedDB), with six fictional demo accounts.

## Capabilities and Constraints

- 102 spectral channels; frames 50 and 51 are documented by IRSA as blank and have no tiles.
- Blink pairs are archive-discovered and wavelength-matched; the calibration, wavelength-matching and FITS-processing pipeline must not be altered by UI work.
- Community review is a prototype: demo identities are not authentication, cases are not shared across browsers or devices, and the MPC and observatory stages are simulated. It must never claim a confirmed discovery.
- Scope and scientific limits: project.md.

## Brand Commitments

- Keep the existing dark theme and floating-window interaction model; no unrelated redesigns.
- Never fabricate astronomical data, reviews, or discovery claims; simulated steps are always labelled as simulated.

## Evidence on Hand

Real SPHEREx imagery and FITS observations from IRSA, plus the README and project.md. There are no user testimonials, usage numbers or reviews, and none may be invented.

## Product Principles

- Real data or nothing: show the genuine source, and label anything simulated as simulated.
- Understandable in minutes: a judge reaches a meaningful view of the sky quickly.
- Scientific honesty over spectacle: state limits (blank channels, demo review, local-only storage) rather than hide them.
- The data is the interface: controls support the imagery and do not compete with it.
