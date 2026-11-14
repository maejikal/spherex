import type { BlinkAnalysis, BlinkFrame } from '../../api/types.ts';

export class BlinkResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlinkResponseError';
  }
}

const IMAGE_PATH = '/api/blink/images/';

/** API path for the aligned cutouts of one analysed position (coordinates are sent unrounded). */
export function blinkCutoutsPath(coordinates: { ra: number; dec: number }, size: number): string {
  const query = new URLSearchParams({ ra: String(coordinates.ra), dec: String(coordinates.dec), size: String(size) });
  return `/api/blink/cutouts?${query}`;
}

/**
 * Validate the `/api/blink/cutouts` payload. `resolveUrl` turns the API-relative image path into the URL
 * the browser should load (it prefixes the configured API origin). Only paths under the blink image route
 * are accepted, so a malformed response can never make the viewer load an arbitrary URL.
 */
export function parseBlinkResponse(value: unknown, resolveUrl: (path: string) => string): BlinkAnalysis {
  const root = record(value, 'response');
  const coordinates = record(root.coordinates, 'coordinates');
  const ra = finite(coordinates.ra, 'coordinates.ra');
  const dec = finite(coordinates.dec, 'coordinates.dec');
  if (ra < 0 || ra >= 360 || dec < -90 || dec > 90) throw new BlinkResponseError('Blink response has out-of-range coordinates.');

  const rawFrames = root.frames;
  if (!Array.isArray(rawFrames) || rawFrames.length < 2) throw new BlinkResponseError('Blink response needs at least two frames.');
  const frames = rawFrames.map((frame, index) => parseFrame(frame, index, resolveUrl));
  if (new Set(frames.map((frame) => frame.id)).size !== frames.length) throw new BlinkResponseError('Blink response repeats a frame.');

  const imageSize = finite(root.image_size, 'image_size');
  if (!Number.isInteger(imageSize) || imageSize < 1) throw new BlinkResponseError('Blink response has an invalid image size.');

  return {
    ra,
    dec,
    imageSize,
    pixelScaleArcsec: finite(root.pixel_scale_arcsec, 'pixel_scale_arcsec'),
    fieldOfViewArcmin: finite(root.field_of_view_arcmin, 'field_of_view_arcmin'),
    orientation: typeof root.orientation === 'string' ? root.orientation : '',
    frames,
    commonCoverageFraction: fraction(root.common_coverage_fraction, 'common_coverage_fraction'),
    warnings: Array.isArray(root.warnings) ? root.warnings.filter((item): item is string => typeof item === 'string') : [],
  };
}

function parseFrame(value: unknown, index: number, resolveUrl: (path: string) => string): BlinkFrame {
  const frame = record(value, `frames[${index}]`);
  const imageUrl = text(frame.image_url, `frames[${index}].image_url`);
  if (!imageUrl.startsWith(IMAGE_PATH)) throw new BlinkResponseError('Blink response referenced an unexpected image location.');
  const wavelength = isRecord(frame.wavelength_um)
    ? { min: finite(frame.wavelength_um.min, 'wavelength.min'), max: finite(frame.wavelength_um.max, 'wavelength.max'), mean: finite(frame.wavelength_um.mean, 'wavelength.mean') }
    : undefined;
  return {
    id: text(frame.id, `frames[${index}].id`),
    label: text(frame.label, `frames[${index}].label`),
    date: text(frame.date, `frames[${index}].date`),
    dateObs: text(frame.date_obs, `frames[${index}].date_obs`),
    mjd: finite(frame.mjd, `frames[${index}].mjd`),
    obsid: typeof frame.obsid === 'string' ? frame.obsid : undefined,
    detector: typeof frame.detector === 'number' ? frame.detector : undefined,
    imageUrl: resolveUrl(imageUrl),
    coverageFraction: fraction(frame.coverage_fraction, `frames[${index}].coverage_fraction`),
    wavelengthUm: wavelength,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new BlinkResponseError(`Blink response is missing ${name}.`);
  return value;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BlinkResponseError(`Blink response has an invalid ${name}.`);
  return value;
}

function fraction(value: unknown, name: string): number {
  const number = finite(value, name);
  if (number < 0 || number > 1) throw new BlinkResponseError(`Blink response has an invalid ${name}.`);
  return number;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BlinkResponseError(`Blink response has an invalid ${name}.`);
  return value;
}
