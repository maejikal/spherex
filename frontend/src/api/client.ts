import { parseConstellation, type ConstellationInfo } from '../sky/constellations.ts';
import type { ApiHealth, CatalogObject, ResolvedObject, SkyTarget } from './types.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number | null;

  constructor(message: string, options: { code?: string | null; status?: number | null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = options.code ?? null;
    this.status = options.status ?? null;
  }
}

function makeUrl(path: string): URL {
  const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return new URL(`${API_BASE_URL}${path}`, base);
}

async function readError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const record = isRecord(body) ? body : {};
  const nested = isRecord(record.error) ? record.error : record;
  const message = firstString(nested.message, nested.detail) ?? `API request failed (${response.status}).`;
  const code = firstString(nested.code, record.code);
  return new ApiError(message, { code, status: response.status });
}

async function fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(makeUrl(path), {
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the Sky Explorer API. Start the FastAPI service and retry.');
  }

  if (!response.ok) throw await readError(response);
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ApiError('API returned a non-JSON response.', { code: 'invalid_content_type', status: response.status });
  }
  return response.json();
}

export async function getApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  const value = await fetchJson('/api/health', signal);
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw new ApiError('API health response did not include a status.');
  }
  return { status: value.status };
}

export async function listSuggestedTargets(signal?: AbortSignal): Promise<SkyTarget[]> {
  const value = await fetchJson('/api/targets/suggested', signal);
  const entries = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.targets) ? value.targets : null;
  if (!entries) throw new ApiError('Suggested-target response did not include a target list.');
  const targets = entries.map((entry) => parseTarget(entry));
  if (targets.some((target) => target === null)) {
    throw new ApiError('Suggested-target response contained invalid or incomplete coordinates.');
  }
  return targets as SkyTarget[];
}

export async function getRandomTarget(signal?: AbortSignal): Promise<SkyTarget> {
  const value = await fetchJson('/api/targets/random', signal);
  const record = isRecord(value) && isRecord(value.target) ? value.target : value;
  const target = parseTarget(record, false);
  if (!target) throw new ApiError('Random-target response did not include valid coordinates.');
  return target;
}

export async function resolveObjectName(name: string, signal?: AbortSignal): Promise<ResolvedObject> {
  const url = makeUrl('/api/objects/resolve');
  url.searchParams.set('name', name.trim());
  const value = await fetchJson(`${url.pathname}${url.search}`, signal);
  const record = isRecord(value) && isRecord(value.object) ? value.object : value;
  const coordinates = parseCoordinates(record);
  if (!isRecord(record) || !coordinates) {
    throw new ApiError('Name resolver response did not include valid ICRS coordinates.');
  }
  const returnedName = firstString(record.name, record.identifier) ?? name.trim();
  return {
    name: returnedName,
    ...coordinates,
    source: firstString(record.source),
    objectType: firstString(record.object_type, record.objectType),
  };
}

export async function findNearbyObjects(
  coordinates: SkyCoordinates,
  signal?: AbortSignal,
): Promise<CatalogObject[]> {
  const url = makeUrl('/api/objects/nearby');
  url.searchParams.set('ra', String(coordinates.ra));
  url.searchParams.set('dec', String(coordinates.dec));
  url.searchParams.set('radius_arcsec', '30');
  url.searchParams.set('limit', '8');
  const value = await fetchJson(`${url.pathname}${url.search}`, signal);
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.matches)
      ? value.matches
      : isRecord(value) && Array.isArray(value.objects)
        ? value.objects
        : null;
  if (!entries) throw new ApiError('Nearby-object response did not include a catalogue result list.');
  const objects = entries.map(parseCatalogObject);
  if (objects.some((object) => object === null)) {
    throw new ApiError('Nearby-object response contained invalid or incomplete catalogue rows.');
  }
  return objects as CatalogObject[];
}

function parseTarget(value: unknown, requireName = true): SkyTarget | null {
  if (!isRecord(value)) return null;
  const coordinates = parseCoordinates(value);
  const name = firstString(value.name, value.label);
  if (!coordinates || (requireName && !name)) return null;
  return {
    id: firstString(value.id),
    name,
    ...coordinates,
    description: firstString(value.description),
  };
}

function parseCatalogObject(value: unknown): CatalogObject | null {
  if (!isRecord(value)) return null;
  const coordinates = parseCoordinates(value);
  if (!coordinates) return null;
  const rawSeparation = value.separation_arcsec ?? value.separationArcsec;
  const separation = typeof rawSeparation === 'number' ? rawSeparation : Number.NaN;
  return {
    id: firstString(value.id, value.object_id),
    name: firstString(value.name, value.identifier),
    objectType: firstString(value.object_type, value.objectType, value.class),
    source: firstString(value.source),
    separationArcsec: Number.isFinite(separation) ? separation : undefined,
    ...coordinates,
  };
}

function parseCoordinates(value: unknown): SkyCoordinates | null {
  if (!isRecord(value)) return null;
  const ra = value.ra;
  const dec = value.dec;
  if (typeof ra !== 'number' || typeof dec !== 'number' || !Number.isFinite(ra) || ra < 0 || ra >= 360 || !Number.isFinite(dec) || dec < -90 || dec > 90) {
    return null;
  }
  return { ra, dec };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Local Astropy lookup; query cancellation prevents an old selection replacing the new one. */
export async function getConstellation(coordinates: SkyCoordinates, signal?: AbortSignal): Promise<ConstellationInfo> {
  const query = new URLSearchParams({ ra: String(coordinates.ra), dec: String(coordinates.dec) });
  return parseConstellation(await fetchJson(`/api/constellations/at?${query}`, signal));
}
