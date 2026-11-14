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

/** One observation in the blink viewer (parsed from `/api/blink/cutouts`). */
export interface BlinkFrame {
  id: string;
  /** e.g. "May 2025", derived by the backend from the FITS header. */
  label: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  dateObs: string;
  mjd: number;
  obsid?: string;
  detector?: number;
  /** Absolute-or-same-origin URL of the aligned PNG. */
  imageUrl: string;
  /** Fraction (0-1) of the cutout with usable data in this frame. */
  coverageFraction: number;
  /** Central wavelength (µm) of the detector pixels that fell in the cutout. */
  wavelengthUm?: { min: number; max: number; mean: number };
}

export interface BlinkAnalysis extends SkyCoordinates {
  imageSize: number;
  pixelScaleArcsec: number;
  fieldOfViewArcmin: number;
  orientation: string;
  frames: BlinkFrame[];
  commonCoverageFraction: number;
  warnings: string[];
}
