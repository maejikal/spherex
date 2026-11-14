import type { SkyCoordinates } from './coordinates.ts';

interface Point { x: number; y: number }
export interface ConstellationOverviewGeometry { rings: Point[][]; marker: Point }

const RAD = Math.PI / 180;

/**
 * Survey-independent spherical azimuthal equidistant overview (not a pixel/WCS map).
 * Center on the boundary's mean unit vector, avoiding RA-wrap and polar averaging
 * errors. Sampled official rings remain separate. East is left, north up at center.
 * Uniform fitting preserves projected aspect ratio and never changes viewer state.
 */
export function projectConstellationOverview(
  boundary: [number, number][][],
  selection: SkyCoordinates,
): ConstellationOverviewGeometry | null {
  const valid = (ra: number, dec: number) => Number.isFinite(ra) && Number.isFinite(dec)
    && ra >= 0 && ra < 360 && dec >= -90 && dec <= 90;
  if (!boundary.length || boundary.some((ring) => ring.length < 4)
    || !valid(selection.ra, selection.dec)) return null;
  const points = boundary.flat();
  if (points.some(([ra, dec]) => !valid(ra, dec))) return null;
  let x = 0, y = 0, z = 0;
  for (const [ra, dec] of points) {
    x += Math.cos(dec * RAD) * Math.cos(ra * RAD);
    y += Math.cos(dec * RAD) * Math.sin(ra * RAD);
    z += Math.sin(dec * RAD);
  }
  if (Math.hypot(x, y, z) < 1e-10) return null;
  const centerRa = Math.atan2(y, x);
  const centerDec = Math.atan2(z, Math.hypot(x, y));
  const project = (ra: number, dec: number): Point | null => {
    const delta = ra * RAD - centerRa;
    const sinDec = Math.sin(dec * RAD), cosDec = Math.cos(dec * RAD);
    const east = cosDec * Math.sin(delta);
    const north = Math.cos(centerDec) * sinDec - Math.sin(centerDec) * cosDec * Math.cos(delta);
    const cosDistance = Math.sin(centerDec) * sinDec + Math.cos(centerDec) * cosDec * Math.cos(delta);
    const sinDistance = Math.hypot(east, north);
    // An antipode has no unique direction on this projection. Never invent one.
    if (sinDistance < 1e-12 && cosDistance < 0) return null;
    const factor = sinDistance < 1e-12 ? 1 : Math.atan2(sinDistance, cosDistance) / sinDistance;
    return { x: -east * factor, y: -north * factor };
  };
  const rings = boundary.map((ring) => ring.map(([ra, dec]) => project(ra, dec)));
  const marker = project(selection.ra, selection.dec);
  if (!marker || rings.some((ring) => ring.some((point) => !point))) return null;
  const projected = rings as Point[][];
  const all = [...projected.flat(), marker];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of all) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX, height = maxY - minY;
  if (Math.max(width, height) < 1e-12) return null;
  // Fixed 240 x 168 viewBox, 16 units of padding for strokes and marker.
  const scale = Math.min(208 / Math.max(width, 1e-12), 136 / Math.max(height, 1e-12));
  const fit = (point: Point): Point => ({
    x: 120 + (point.x - (minX + maxX) / 2) * scale,
    y: 84 + (point.y - (minY + maxY) / 2) * scale,
  });
  return { rings: projected.map((ring) => ring.map(fit)), marker: fit(marker) };
}
