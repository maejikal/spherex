import {
  MAX_SCALE_ARCSEC_PER_PIXEL,
  MIN_SCALE_ARCSEC_PER_PIXEL,
  normalizeRightAscension,
} from '../sky/coordinates.ts';
import { SPHEREX_SURVEY_ID } from '../sky/spherex/config.ts';
import type { SurveyId } from '../sky/spherex/config.ts';

export interface ShareableView {
  ra: number;
  dec: number;
  scale: number;
  survey: SurveyId;
  grid: boolean;
  channel: number | null;
}

/** Survey values accepted in a URL. Links from the SDSS prototype used `survey=sdss-dr18`. */
const LEGACY_SURVEYS = new Set(['sdss-dr18']);
/** Old links stored coarse arcsec/pixel values; they stay valid arcsec/pixel, never degrees. */
const MIN_ACCEPTED_SCALE = 0.05;

export function parseViewSearch(search: string): ShareableView | null {
  const params = new URLSearchParams(search);
  const raText = params.get('ra');
  const decText = params.get('dec');
  const scaleText = params.get('scale');
  const raValue = Number(raText);
  const decValue = Number(decText);
  const scale = Number(scaleText);
  const survey = params.get('survey') ?? SPHEREX_SURVEY_ID;

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
    scale < MIN_ACCEPTED_SCALE ||
    scale > MAX_SCALE_ARCSEC_PER_PIXEL ||
    (survey !== SPHEREX_SURVEY_ID && !LEGACY_SURVEYS.has(survey))
  ) {
    return null;
  }

  const channelText = params.get('channel');
  const channelValue = channelText?.trim() ? Number(channelText) : Number.NaN;
  const channel = Number.isInteger(channelValue) && channelValue >= 0 ? channelValue : null;

  return {
    ra: normalizeRightAscension(raValue),
    dec: decValue,
    scale: Math.max(MIN_SCALE_ARCSEC_PER_PIXEL, scale),
    survey: SPHEREX_SURVEY_ID,
    grid: params.get('grid') === '1',
    channel,
  };
}

export function serializeViewSearch(view: ShareableView, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch);
  params.set('ra', String(view.ra));
  params.set('dec', String(view.dec));
  params.set('scale', String(view.scale));
  params.set('survey', view.survey);
  params.set('grid', view.grid ? '1' : '0');
  if (view.channel === null) params.delete('channel');
  else params.set('channel', String(view.channel));
  return `?${params.toString()}`;
}
