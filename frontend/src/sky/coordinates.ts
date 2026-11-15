export interface SkyCoordinates {
  ra: number;
  dec: number;
}

export interface CoordinateInputResult {
  ok: boolean;
  value?: SkyCoordinates;
  error?: string;
}

export type RightAscensionUnit = 'degrees' | 'hours';

export interface SexagesimalCoordinateInput {
  raHours: string;
  raMinutes: string;
  raSeconds: string;
  decSign: '+' | '-';
  decDegrees: string;
  decMinutes: string;
  decSeconds: string;
}

/** Scale is arcseconds per CSS pixel of the viewer width (Aladin FOV = width * scale / 3600). */
export const DEFAULT_SCALE_ARCSEC_PER_PIXEL = 2.5;
export const MIN_SCALE_ARCSEC_PER_PIXEL = 0.2;
export const MAX_SCALE_ARCSEC_PER_PIXEL = 500;

const RADIANS_PER_ARCSECOND = Math.PI / (180 * 3600);
const DEGREES_PER_RADIAN = 180 / Math.PI;

export function normalizeRightAscension(ra: number): number {
  if (!Number.isFinite(ra)) return Number.NaN;
  const normalized = ((ra % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function parseCoordinateInput(
  raText: string,
  decText: string,
  raUnit: RightAscensionUnit = 'degrees',
): CoordinateInputResult {
  const enteredRa = Number(raText.trim());
  const dec = Number(decText.trim());

  if (!raText.trim() || !decText.trim() || !Number.isFinite(enteredRa) || !Number.isFinite(dec)) {
    return { ok: false, error: 'Enter finite right ascension and declination values.' };
  }
  const raLimit = raUnit === 'hours' ? 24 : 360;
  if (enteredRa < 0 || enteredRa >= raLimit) {
    const unit = raUnit === 'hours' ? ' h' : '°';
    return { ok: false, error: `Right ascension must be at least 0${unit} and less than ${raLimit}${unit}.` };
  }
  if (dec < -90 || dec > 90) {
    return { ok: false, error: 'Declination must be between −90° and +90°.' };
  }

  return { ok: true, value: { ra: raUnit === 'hours' ? enteredRa * 15 : enteredRa, dec } };
}

/** Converts HMS right ascension and signed DMS declination into decimal degrees. */
export function parseSexagesimalCoordinateInput(input: SexagesimalCoordinateInput): CoordinateInputResult {
  const values = [input.raHours, input.raMinutes, input.raSeconds, input.decDegrees, input.decMinutes, input.decSeconds]
    .map((part) => part.trim());
  const [hours, raMinutes, raSeconds, degrees, decMinutes, decSeconds] = values.map(Number) as [number, number, number, number, number, number];
  if (values.some((part) => !part) || values.some((part) => !Number.isFinite(Number(part)))) {
    return { ok: false, error: 'Enter hours, minutes, and seconds for both coordinates.' };
  }
  if (!['+', '-'].includes(input.decSign)) {
    return { ok: false, error: 'Choose a positive or negative declination sign.' };
  }
  if (hours < 0 || hours >= 24 || !Number.isInteger(hours) || raMinutes < 0 || raMinutes >= 60 || !Number.isInteger(raMinutes) || raSeconds < 0 || raSeconds >= 60) {
    return { ok: false, error: 'Right ascension must be 0–23 hours, 0–59 minutes, and 0–<60 seconds.' };
  }
  if (degrees < 0 || degrees > 90 || !Number.isInteger(degrees) || decMinutes < 0 || decMinutes >= 60 || !Number.isInteger(decMinutes) || decSeconds < 0 || decSeconds >= 60) {
    return { ok: false, error: 'Declination must be within 90° with minutes and seconds from 0 to <60.' };
  }
  if (degrees === 90 && (decMinutes !== 0 || decSeconds !== 0)) {
    return { ok: false, error: 'At 90° declination, minutes and seconds must be zero.' };
  }
  const ra = (hours + raMinutes / 60 + raSeconds / 3600) * 15;
  const absoluteDec = degrees + decMinutes / 60 + decSeconds / 3600;
  return { ok: true, value: { ra, dec: input.decSign === '-' ? -absoluteDec : absoluteDec } };
}

/**
 * Convert image-pixel offsets to approximate ICRS coordinates using an inverse
 * gnomonic projection. The cutout convention is north-up, east-left; results
 * are used for programmatic pans (buttons/keys); pointer-to-sky conversion comes from Aladin Lite.
 */
export function coordinateAtPixelOffset(
  center: SkyCoordinates,
  offsetX: number,
  offsetY: number,
  scaleArcsecPerPixel: number,
): SkyCoordinates {
  if (
    !Number.isFinite(center.ra) ||
    !Number.isFinite(center.dec) ||
    !Number.isFinite(offsetX) ||
    !Number.isFinite(offsetY) ||
    !Number.isFinite(scaleArcsecPerPixel) ||
    scaleArcsecPerPixel <= 0 ||
    center.dec < -90 ||
    center.dec > 90
  ) {
    throw new RangeError('Coordinate projection requires finite values and a positive image scale.');
  }

  const east = -offsetX * scaleArcsecPerPixel * RADIANS_PER_ARCSECOND;
  const north = -offsetY * scaleArcsecPerPixel * RADIANS_PER_ARCSECOND;
  const rho = Math.hypot(east, north);
  if (rho === 0) return { ra: normalizeRightAscension(center.ra), dec: center.dec };

  const angularDistance = Math.atan(rho);
  const sinDistance = Math.sin(angularDistance);
  const cosDistance = Math.cos(angularDistance);
  const ra0 = normalizeRightAscension(center.ra) / DEGREES_PER_RADIAN;
  const dec0 = center.dec / DEGREES_PER_RADIAN;
  const sinDec0 = Math.sin(dec0);
  const cosDec0 = Math.cos(dec0);

  const sinDec = Math.max(
    -1,
    Math.min(1, cosDistance * sinDec0 + (north * sinDistance * cosDec0) / rho),
  );
  const dec = Math.asin(sinDec) * DEGREES_PER_RADIAN;
  const ra =
    ra0 +
    Math.atan2(
      east * sinDistance,
      rho * cosDec0 * cosDistance - north * sinDec0 * sinDistance,
    );

  return { ra: normalizeRightAscension(ra * DEGREES_PER_RADIAN), dec };
}

/** Move the image under a drag, then derive the new center from absolute coordinates. */
export function panCenterByDrag(
  center: SkyCoordinates,
  scaleArcsecPerPixel: number,
  dragX: number,
  dragY: number,
): SkyCoordinates {
  return coordinateAtPixelOffset(center, -dragX, -dragY, scaleArcsecPerPixel);
}

export function calculateFieldOfView(
  scaleArcsecPerPixel: number,
  widthPixels: number,
  heightPixels: number,
): { widthArcminutes: number; heightArcminutes: number } | null {
  if (
    !Number.isFinite(scaleArcsecPerPixel) ||
    scaleArcsecPerPixel <= 0 ||
    !Number.isFinite(widthPixels) ||
    !Number.isFinite(heightPixels) ||
    widthPixels <= 0 ||
    heightPixels <= 0
  ) {
    return null;
  }
  return {
    widthArcminutes: (scaleArcsecPerPixel * widthPixels) / 60,
    heightArcminutes: (scaleArcsecPerPixel * heightPixels) / 60,
  };
}

export function zoomScale(
  scaleArcsecPerPixel: number,
  direction: 'in' | 'out',
  factor = Math.SQRT2,
): number {
  if (!Number.isFinite(scaleArcsecPerPixel) || scaleArcsecPerPixel <= 0) {
    throw new RangeError('Image scale must be a positive finite value.');
  }
  if (!Number.isFinite(factor) || factor <= 1) {
    throw new RangeError('Zoom factor must be greater than 1.');
  }

  const nextScale = direction === 'in' ? scaleArcsecPerPixel / factor : scaleArcsecPerPixel * factor;
  return Math.max(
    MIN_SCALE_ARCSEC_PER_PIXEL,
    Math.min(MAX_SCALE_ARCSEC_PER_PIXEL, nextScale),
  );
}

export function formatCoordinate(value: number, digits = 5): string {
  return Number.isFinite(value) ? value.toFixed(digits) : 'Unavailable';
}

/** Format canonical degree RA in the selected unit, wrapping rounded 360°/24 h to zero. */
export function formatRightAscension(raDegrees: number, unit: RightAscensionUnit, digits = 3): string {
  if (!Number.isFinite(raDegrees)) return 'Unavailable';
  const normalizedRa = normalizeRightAscension(raDegrees);
  const value = unit === 'hours' ? normalizedRa / 15 : normalizedRa;
  const limit = unit === 'hours' ? 24 : 360;
  const rounded = Number(value.toFixed(digits));
  return formatCoordinate(rounded >= limit ? 0 : rounded, digits);
}
