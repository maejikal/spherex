import type { BlinkMode, BlinkModes } from '../../api/types.ts';

/** The mode the viewer should actually use. Archive (dynamic) is preferred; the local demo is only ever chosen explicitly
 *  or because the server has archive mode switched off. It is never used as a silent fallback for an archive failure. */
export function resolveBlinkMode(requested: BlinkMode, modes: BlinkModes | undefined): BlinkMode {
  if (!modes) return requested;
  if (requested === 'dynamic' && !modes.dynamicEnabled && modes.localDemoAvailable) return 'local';
  if (requested === 'local' && !modes.localDemoAvailable && modes.dynamicEnabled) return 'dynamic';
  return requested;
}

export function modeLabel(mode: BlinkMode): string {
  return mode === 'dynamic' ? 'SPHEREx archive' : 'Local demo';
}

/** Query key: the analysed position, the mode and (for the archive) the field of view, so nothing stale is ever shown. */
export function blinkQueryKey(mode: BlinkMode, target: { ra: number; dec: number } | null, size: number): readonly unknown[] {
  return ['blink', mode, target?.ra, target?.dec, size];
}
