/** Survey-independent IAU constellation metadata and ICRS visualization geometry. */
export interface ConstellationInfo {
  ra: number;
  dec: number;
  name: string;
  abbreviation: string;
  learnUrl: string;
  boundarySource: string;
  boundary: [number, number][][];
}

export function parseConstellation(value: unknown): ConstellationInfo {
  const invalid = () => new Error('Constellation response contained invalid metadata or boundary coordinates.');
  if (!value || typeof value !== 'object') throw invalid();
  const data = value as Record<string, unknown>;
  const position = (point: unknown): point is [number, number] => Array.isArray(point) && point.length === 2
    && typeof point[0] === 'number' && Number.isFinite(point[0]) && point[0] >= 0 && point[0] < 360
    && typeof point[1] === 'number' && Number.isFinite(point[1]) && point[1] >= -90 && point[1] <= 90;
  const text = (item: unknown): item is string => typeof item === 'string' && item.trim().length > 0;
  if (!position([data.ra, data.dec]) || data.coordinate_system !== 'ICRS'
    || !text(data.name) || !text(data.abbreviation) || !text(data.learn_url) || !text(data.boundary_source)) throw invalid();
  const learn = new URL(data.learn_url);
  const source = new URL(data.boundary_source);
  if (learn.origin !== 'https://en.wikipedia.org' || !learn.pathname.startsWith('/wiki/')
    || source.origin !== 'https://cdsarc.cds.unistra.fr') throw invalid();
  if (!Array.isArray(data.boundary) || data.boundary.length === 0) throw invalid();
  const boundary = data.boundary.map((ring: unknown) => {
    if (!Array.isArray(ring) || ring.length < 4 || !ring.every(position)) throw invalid();
    const first = ring[0] as [number, number];
    const last = ring[ring.length - 1] as [number, number];
    if (first[0] !== last[0] || first[1] !== last[1]) throw invalid();
    return ring as [number, number][];
  });
  return {
    ra: data.ra as number, dec: data.dec as number, name: data.name, abbreviation: data.abbreviation,
    learnUrl: learn.href, boundarySource: source.href, boundary,
  };
}
