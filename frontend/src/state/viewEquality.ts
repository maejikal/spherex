import type { ExplorerView } from '../api/types.ts';

type SkyView = Pick<ExplorerView, 'ra' | 'dec' | 'scale'>;

/** Ignore floating-point feedback from viewport/FOV round trips, not real navigation. */
export function sameSkyView(current: SkyView, next: SkyView): boolean {
  const raDistance = Math.abs(((current.ra - next.ra + 540) % 360) - 180);
  return raDistance <= 1e-9
    && Math.abs(current.dec - next.dec) <= 1e-9
    && Math.abs(current.scale - next.scale) <= Math.abs(current.scale) * 1e-10;
}
