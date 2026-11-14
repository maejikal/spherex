import { MAX_SCALE_ARCSEC_PER_PIXEL, MIN_SCALE_ARCSEC_PER_PIXEL } from '../spherex/config.ts';

/**
 * The app's view scale is arcseconds per CSS pixel of the viewer width; Aladin Lite works in
 * angular field of view. For a viewer `widthPixels` wide the horizontal FOV is width * scale / 3600.
 */
export function fovFromScale(scaleArcsecPerPixel: number, widthPixels: number): number {
  return (scaleArcsecPerPixel * widthPixels) / 3600;
}

export function scaleFromFov(fovDegrees: number, widthPixels: number): number {
  return (fovDegrees * 3600) / widthPixels;
}

export function clampScale(scale: number): number {
  return Math.max(MIN_SCALE_ARCSEC_PER_PIXEL, Math.min(MAX_SCALE_ARCSEC_PER_PIXEL, scale));
}
