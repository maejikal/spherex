import type { BlinkMode, BlinkModes } from '../../api/types.ts';

/** The mode the viewer should actually use. Archive (dynamic) is preferred; the local SPHEREx is only ever chosen explicitly
 *  or because the server has archive mode switched off. It is never used as a silent fallback for an archive failure. */
export function resolveBlinkMode(requested: BlinkMode, modes: BlinkModes | undefined): BlinkMode {
  if (!modes) return requested;
  if (requested === 'dynamic' && !modes.dynamicEnabled && modes.localDemoAvailable) return 'local';
  if (requested === 'local' && !modes.localDemoAvailable && modes.dynamicEnabled) return 'dynamic';
  return requested;
}

export function modeLabel(mode: BlinkMode): string {
  return mode === 'dynamic' ? 'SPHEREx data' : 'Local SPHEREx';
}

/** Archive cache identity includes field of view and requested wavelength; local identity includes the fixed FITS profile. */
export function blinkQueryKey(mode: BlinkMode, target: { ra: number; dec: number } | null, size: number, localProfileId = 'auto', wavelengthUm: number | null = null, detector: number | null = null): readonly unknown[] {
  const key = ['blink', mode, target?.ra, target?.dec, size];
  return mode === 'local' ? [...key, localProfileId] : [...key, wavelengthUm, detector];
}
