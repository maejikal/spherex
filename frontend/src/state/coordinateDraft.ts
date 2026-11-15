import type { SexagesimalCoordinateInput, SkyCoordinates } from '../sky/coordinates.ts';

/**
 * The Find panel's RA/Dec fields: an editable draft kept separate from the live viewer position.
 *
 * While the user has not touched the fields they follow the viewer (pan, zoom, double-click). Once
 * either field is edited the draft is the user's: viewer movement no longer overwrites it. An explicit
 * navigation (Go to coordinates, a name lookup, a verified destination, Reset, browser Back) hands the
 * fields back to the viewer and shows the position that was navigated to.
 */
export interface CoordinateDraft {
  ra: string;
  dec: string;
  /** The user has edited a field since the last explicit navigation. */
  edited: boolean;
}

/** Shown in the fields: at most 6 decimals (~4 mas), without floating-point noise or trailing zeros. */
export function formatDraftCoordinate(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Number(value.toFixed(6));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function draftFromView(view: { ra: number; dec: number } | null): CoordinateDraft {
  if (!view) return { ra: '', dec: '', edited: false };
  const ra = formatDraftCoordinate(view.ra);
  // RA just below 360 rounds up to 360, which the field (0 to <360) would reject; it is the same as 0.
  return { ra: ra === '360' ? '0' : ra, dec: formatDraftCoordinate(view.dec), edited: false };
}

/** The viewer moved without an explicit navigation: follow it unless the user is editing. */
export function followView(draft: CoordinateDraft, view: { ra: number; dec: number } | null): CoordinateDraft {
  if (draft.edited) return draft;
  const next = draftFromView(view);
  return next.ra === draft.ra && next.dec === draft.dec ? draft : next;
}

export function editDraft(draft: CoordinateDraft, field: 'ra' | 'dec', text: string): CoordinateDraft {
  return { ...draft, [field]: text, edited: true };
}

/** An explicit navigation or reset: discard any edit and show the view navigated to. */
export function syncDraft(view: { ra: number; dec: number } | null): CoordinateDraft {
  return draftFromView(view);
}

/** Format the same editable position as HMS/DMS; rounding carries across minutes and RA wraps. */
export function sexagesimalFromView(view: SkyCoordinates | null): SexagesimalCoordinateInput {
  if (!view) return { raHours: '', raMinutes: '', raSeconds: '', decSign: '+', decDegrees: '', decMinutes: '', decSeconds: '' };
  const raSeconds = (Math.round(view.ra / 15 * 3600 * 1000) / 1000) % (24 * 3600);
  const decSeconds = Math.round(Math.abs(view.dec) * 3600 * 1000) / 1000;
  return {
    raHours: String(Math.floor(raSeconds / 3600)),
    raMinutes: String(Math.floor(raSeconds % 3600 / 60)),
    raSeconds: (raSeconds % 60).toFixed(3),
    decSign: view.dec < 0 || Object.is(view.dec, -0) ? '-' : '+',
    decDegrees: String(Math.floor(decSeconds / 3600)),
    decMinutes: String(Math.floor(decSeconds % 3600 / 60)),
    decSeconds: (decSeconds % 60).toFixed(3),
  };
}
