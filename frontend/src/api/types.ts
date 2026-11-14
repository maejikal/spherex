import type { SkyCoordinates } from '../sky/coordinates.ts';

import type { SurveyId } from '../sky/spherex/config.ts';

export type { SurveyId };

export interface ExplorerView extends SkyCoordinates {
  /** Arcseconds per CSS pixel of the viewer width. */
  scale: number;
  survey: SurveyId;
  grid: boolean;
  /** 0-based SPHEREx cube frame; null means the service's default frame. */
  channel: number | null;
}

export interface SkyTarget extends SkyCoordinates {
  id?: string;
  name?: string;
  description?: string;
}

export interface ResolvedObject extends SkyCoordinates {
  name: string;
  source?: string;
  objectType?: string;
}

export interface CatalogObject extends SkyCoordinates {
  id?: string;
  name?: string;
  objectType?: string;
  separationArcsec?: number;
  source?: string;
}

export interface ApiHealth {
  status: string;
}
