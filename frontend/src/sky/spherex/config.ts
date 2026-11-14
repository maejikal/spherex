/**
 * SPHEREx HiPS service configuration. Verified 2026-11-14 against the live service:
 *   - `properties` is served with `access-control-allow-origin: *`, so the browser reads it directly.
 *   - Tiles are 512 px 8-bit palette PNGs, HiPS orders 0-5, one tile file per cube frame
 *     (`Norder<N>/Dir<D>/Npix<P>_<frame>.png`, frame is a 0-based index), all-sky MOC.
 * Aladin Lite requests the tiles itself; nothing is proxied through the backend.
 */
const envUrl = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_SPHEREX_HIPS_URL;
export const SPHEREX_HIPS_URL =
  envUrl?.replace(/\/$/, '') || 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';

export const SPHEREX_SURVEY_ID = 'spherex' as const;
export type SurveyId = typeof SPHEREX_SURVEY_ID;

export { DEFAULT_SCALE_ARCSEC_PER_PIXEL, MAX_SCALE_ARCSEC_PER_PIXEL, MIN_SCALE_ARCSEC_PER_PIXEL } from '../coordinates.ts';
