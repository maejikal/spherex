import type { SkyCoordinates } from '../sky/coordinates.ts';

export type SurveyId = 'sdss-dr18';

export interface ExplorerView extends SkyCoordinates {
  scale: number;
  survey: SurveyId;
  grid: boolean;
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

export interface CutoutRequest extends ExplorerView {
  width: number;
  height: number;
}

export interface CutoutResponse {
  blob: Blob;
  contentType: string;
  metadata: CutoutMetadata;
}

export interface CutoutMetadata {
  sourceUrl: string | null;
  projection: string | null;
  coordinateFrame: string | null;
  observationTime: string | null;
  wavelength: string | null;
  surveyRelease: string | null;
}

export interface ApiHealth {
  status: string;
}
