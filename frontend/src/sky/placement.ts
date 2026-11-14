import { pixelOffsetOfCoordinate } from './coordinates.ts';
import type { SkyCoordinates } from './coordinates.ts';

export interface ImagePlacement {
  /** CSS-pixel top-left of the image relative to the viewer surface. */
  left: number;
  top: number;
  /** CSS-pixel size of the image at the current view scale. */
  width: number;
  height: number;
  /** Image scale divided by view scale (>1 means the image is magnified). */
  zoom: number;
  /** True when the placed image fully covers the viewer surface. */
  coversViewport: boolean;
}

export interface PlacementInput {
  viewCenter: SkyCoordinates;
  viewScale: number;
  imageCenter: SkyCoordinates;
  imageScale: number;
  imageWidth: number;
  imageHeight: number;
  /** Viewer surface size in CSS pixels. */
  surfaceWidth: number;
  surfaceHeight: number;
  /** CSS pixels per view-resolution pixel (surface width / requested cutout width). */
  cssPerViewPixel: number;
}

/** Zoom ratios outside this range are not drawn: stretched old imagery must not linger. */
export const MIN_DISPLAY_ZOOM = 0.25;
export const MAX_DISPLAY_ZOOM = 4;

/**
 * Where a previously fetched cutout sits in the *current* view. Derived purely from the image's
 * own celestial centre and scale, so it never depends on drag history and cannot drift.
 */
export function placeImage(input: PlacementInput): ImagePlacement | null {
  const zoom = input.imageScale / input.viewScale;
  if (!Number.isFinite(zoom) || zoom < MIN_DISPLAY_ZOOM || zoom > MAX_DISPLAY_ZOOM) return null;
  const offset = pixelOffsetOfCoordinate(input.viewCenter, input.imageCenter, input.viewScale);
  if (!offset) return null;
  const k = input.cssPerViewPixel;
  const width = input.imageWidth * zoom * k;
  const height = input.imageHeight * zoom * k;
  const left = input.surfaceWidth / 2 + offset.x * k - width / 2;
  const top = input.surfaceHeight / 2 + offset.y * k - height / 2;
  const tolerance = 1;
  return {
    left, top, width, height, zoom,
    coversViewport:
      left <= tolerance && top <= tolerance &&
      left + width >= input.surfaceWidth - tolerance && top + height >= input.surfaceHeight - tolerance,
  };
}
