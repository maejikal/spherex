/** Display-only pixel geometry. Never changes the shared celestial grid or source images. */
export interface PixelBounds { x: number; y: number; width: number; height: number }

export function alphaBounds(rgba: Uint8ClampedArray, width: number, height: number): PixelBounds | null {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rgba[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y);
      right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** Tight union: retain every epoch's data, without fixed padding or forced-square blank bands.
 * Both epochs use this exact rectangle, preserving their relative sky placement. */
export function sharedViewport(bounds: readonly (PixelBounds | null)[], size: number): PixelBounds {
  const full = { x: 0, y: 0, width: size, height: size };
  if (!bounds.length || bounds.some((bound) => !bound)) return full;
  const valid = bounds as PixelBounds[];
  const left = Math.min(...valid.map((b) => b.x)), top = Math.min(...valid.map((b) => b.y));
  const right = Math.max(...valid.map((b) => b.x + b.width)), bottom = Math.max(...valid.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** API-proxied PNGs are same-origin. If pixels cannot be read, keep the honest full-field view. */
export function imageBounds(image: HTMLImageElement): PixelBounds | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0);
    return alphaBounds(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  } catch {
    return null;
  }
}
