export interface SkyCoordinates {
  ra: number;
  dec: number;
}

export interface CoordinateInputResult {
  ok: boolean;
  value?: SkyCoordinates;
  error?: string;
}

export const DEFAULT_SCALE_ARCSEC_PER_PIXEL = 0.4;
export const MIN_SCALE_ARCSEC_PER_PIXEL = 0.05;
export const MAX_SCALE_ARCSEC_PER_PIXEL = 120;

const RADIANS_PER_ARCSECOND = Math.PI / (180 * 3600);
const DEGREES_PER_RADIAN = 180 / Math.PI;

export function normalizeRightAscension(ra: number): number {
  if (!Number.isFinite(ra)) return Number.NaN;
  const normalized = ((ra % 360) + 360) % 360;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function parseCoordinateInput(raText: string, decText: string): CoordinateInputResult {
  const ra = Number(raText.trim());
  const dec = Number(decText.trim());

  if (!raText.trim() || !decText.trim() || !Number.isFinite(ra) || !Number.isFinite(dec)) {
    return { ok: false, error: 'Enter finite right ascension and declination values.' };
  }
  if (ra < 0 || ra >= 360) {
    return { ok: false, error: 'Right ascension must be at least 0° and less than 360°.' };
  }
  if (dec < -90 || dec > 90) {
    return { ok: false, error: 'Declination must be between −90° and +90°.' };
  }

  return { ok: true, value: { ra, dec } };
}

/**
 * Convert image-pixel offsets to approximate ICRS coordinates using an inverse
 * gnomonic projection. The cutout convention is north-up, east-left; results
 * remain approximate because an SDSS JPEG does not carry verified WCS metadata.
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
