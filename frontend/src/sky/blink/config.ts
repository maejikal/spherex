import type { SkyCoordinates } from '../coordinates.ts';

/** Edge of the aligned cutout in pixels (the backend's default; ~26 arcmin at 6.15″/pixel). */
export const BLINK_CUTOUT_SIZE = 256;

/** Sky position covered by the two local SPHEREx exposures used by this prototype. */
export const BLINK_COVERED_REGION: SkyCoordinates = { ra: 210.54, dec: 54.46 };

export const BLINK_DISCLAIMER =
  'These observations may sample different infrared wavelengths. Apparent changes are not necessarily evidence of object motion or variability.';

/** Square field of view requested from the archive in dynamic mode (the backend accepts 0.02-0.5 degrees). */
export const BLINK_DYNAMIC_FOV_DEG = 0.1;

/** Square-field edge lengths, within the archive service's supported 0.02–0.5° range. */
export const BLINK_FOV_OPTIONS = [
  { degrees: 0.02, label: '0.02° × 0.02°' },
  { degrees: 0.05, label: '0.05° × 0.05°' },
  { degrees: 0.1, label: '0.1° × 0.1°' },
  { degrees: 0.2, label: '0.2° × 0.2°' },
  { degrees: 0.3, label: '0.3° × 0.3°' },
  { degrees: 0.5, label: '0.5° × 0.5°' },
] as const;
