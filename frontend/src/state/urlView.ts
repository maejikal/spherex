import { normalizeRightAscension } from '../sky/coordinates.ts';

export interface ShareableView {
  ra: number;
  dec: number;
  scale: number;
  survey: 'sdss-dr18';
  grid: boolean;
}

export function parseViewSearch(search: string): ShareableView | null {
  const params = new URLSearchParams(search);
  const raText = params.get('ra');
  const decText = params.get('dec');
  const scaleText = params.get('scale');
  const raValue = Number(raText);
  const decValue = Number(decText);
  const scale = Number(scaleText);
  const survey = params.get('survey') ?? 'sdss-dr18';

  if (
    !params.has('ra') ||
    !params.has('dec') ||
    !params.has('scale') ||
    !raText?.trim() ||
    !decText?.trim() ||
    !scaleText?.trim() ||
    !Number.isFinite(raValue) ||
    !Number.isFinite(decValue) ||
    !Number.isFinite(scale) ||
    raValue < 0 ||
    raValue > 360 ||
    decValue < -90 ||
    decValue > 90 ||
    scale < 0.05 ||
    scale > 120 ||
    survey !== 'sdss-dr18'
  ) {
    return null;
  }

  return {
    ra: normalizeRightAscension(raValue),
    dec: decValue,
    scale,
    survey: 'sdss-dr18',
    grid: params.get('grid') === '1',
  };
}

export function serializeViewSearch(view: ShareableView, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch);
  params.set('ra', String(view.ra));
  params.set('dec', String(view.dec));
  params.set('scale', String(view.scale));
  params.set('survey', view.survey);
  params.set('grid', view.grid ? '1' : '0');
  return `?${params.toString()}`;
}
