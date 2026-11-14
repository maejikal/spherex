/** Parsing and validation of the HiPS `properties` document published by IRSA. */

export class SphereXMetadataError extends Error {
  readonly code: 'unreachable' | 'invalid';
  constructor(message: string, code: 'unreachable' | 'invalid') {
    super(message);
    this.name = 'SphereXMetadataError';
    this.code = code;
  }
}

export interface SphereXSurveyInfo {
  /** Free-text provenance fields copied from the service; nothing here is invented. */
  title: string;
  creatorDid: string;
  collection: string;
  releaseDate: string | null;
  frame: string;
  tileFormat: string;
  tileWidth: number;
  maxOrder: number;
  depth: number;
  firstFrame: number;
  /** Wavelength in micrometres for every cube frame (index = 0-based frame). */
  wavelengthsUm: readonly number[];
  emMinMeters: number;
  emMaxMeters: number;
  /** 0-based frames the service documents as blank. */
  blankFrames: readonly number[];
  description: string;
  initialRa: number | null;
  initialDec: number | null;
  skyFraction: number | null;
}

export function parseHiPSProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (key) result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

const fail = (message: string): never => {
  throw new SphereXMetadataError(message, 'invalid');
};

function numberField(properties: Record<string, string>, key: string): number {
  const value = Number(properties[key]);
  if (properties[key] === undefined || properties[key] === '' || !Number.isFinite(value)) {
    return fail(`HiPS property "${key}" is missing or not numeric.`);
  }
  return value;
}

function optionalNumber(properties: Record<string, string>, key: string): number | null {
  const raw = properties[key];
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The IRSA description documents blank frames as "Frames 50 and 51 (...) are blank" using the same
 * 0-based index as the tile file names. Only frames named that way are treated as blank.
 */
export function parseBlankFrames(description: string, depth: number): number[] {
  const match = /Frames?\s+(\d+)(?:\s*(?:,|and|&)\s*(\d+))*[^.]*?\bare\s+blank/i.exec(description);
  if (!match) return [];
  const list = /Frames?\s+((?:\d+\s*(?:,|and|&)?\s*)+)/i.exec(match[0]);
  const numbers = (list?.[1] ?? '').match(/\d+/g) ?? [];
  return [...new Set(numbers.map(Number))].filter((n) => n >= 0 && n < depth).sort((a, b) => a - b);
}

/** Validate that the document really is the SPHEREx cube HiPS and extract what the UI needs. */
export function buildSurveyInfo(properties: Record<string, string>): SphereXSurveyInfo {
  const creatorDid = properties.creator_did ?? '';
  if (!/SPHEREx/i.test(creatorDid) && !/SPHEREx/i.test(properties.obs_collection ?? '')) {
    fail('HiPS properties do not identify a SPHEREx dataset.');
  }
  if (properties.dataproduct_type !== 'cube') fail('HiPS dataset is not a spectral cube.');
  const hipsFrame = properties.hips_frame ?? '';
  if (hipsFrame !== 'equatorial') fail(`Unsupported HiPS frame "${hipsFrame}".`);
  const tileFormat = (properties.hips_tile_format ?? '').split(/\s+/)[0] ?? '';
  if (!tileFormat) fail('HiPS tile format is not advertised.');

  const depth = numberField(properties, 'hips_cube_depth');
  if (!Number.isInteger(depth) || depth < 1) fail('HiPS cube depth is invalid.');
  const wavelengthsUm = (properties.data_cube_crval3_arr ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  if (wavelengthsUm.length !== depth || wavelengthsUm.some((value) => !Number.isFinite(value) || value <= 0)) {
    fail('HiPS cube wavelength table does not match the cube depth.');
  }
  if (properties.data_cube_bunit3 !== 'um') fail(`Unexpected spectral unit "${properties.data_cube_bunit3 ?? ''}".`);

  const description = properties.obs_description ?? '';
  const firstFrame = optionalNumber(properties, 'hips_cube_firstframe') ?? 0;
  return {
    title: properties.obs_title ?? 'SPHEREx all-sky data cube',
    creatorDid,
    collection: properties.obs_collection ?? 'SPHEREx',
    releaseDate: properties.hips_release_date ?? null,
    frame: hipsFrame,
    tileFormat,
    tileWidth: numberField(properties, 'hips_tile_width'),
    maxOrder: numberField(properties, 'hips_order'),
    depth,
    firstFrame: Math.min(depth - 1, Math.max(0, firstFrame)),
    wavelengthsUm,
    emMinMeters: numberField(properties, 'em_min'),
    emMaxMeters: numberField(properties, 'em_max'),
    blankFrames: parseBlankFrames(description, depth),
    description,
    initialRa: optionalNumber(properties, 'hips_initial_ra'),
    initialDec: optionalNumber(properties, 'hips_initial_dec'),
    skyFraction: optionalNumber(properties, 'moc_sky_fraction'),
  };
}

export async function fetchSurveyInfo(url: string, signal?: AbortSignal): Promise<SphereXSurveyInfo> {
  let response: Response;
  try {
    response = await fetch(`${url}/properties`, { signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new SphereXMetadataError('Could not reach the NASA/IPAC SPHEREx HiPS service.', 'unreachable');
  }
  if (!response.ok) {
    throw new SphereXMetadataError(`The SPHEREx HiPS service answered HTTP ${response.status}.`, 'unreachable');
  }
  return buildSurveyInfo(parseHiPSProperties(await response.text()));
}
