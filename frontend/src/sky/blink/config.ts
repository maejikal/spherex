import type { SkyCoordinates } from '../coordinates.ts';

/** Edge of the aligned cutout in pixels (the backend's default; ~26 arcmin at 6.15″/pixel). */
export const BLINK_CUTOUT_SIZE = 256;

/** Sky position covered by the two local SPHEREx exposures used by this prototype. */
export const BLINK_COVERED_REGION: SkyCoordinates = { ra: 210.54, dec: 54.46 };

export const BLINK_DISCLAIMER =
  'These observations may sample different infrared wavelengths. Apparent changes are not necessarily evidence of object motion or variability.';
