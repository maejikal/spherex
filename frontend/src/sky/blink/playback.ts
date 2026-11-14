/** Blink playback state as a pure reducer, so the timing rules can be tested without a browser. */

export const BLINK_INTERVALS_MS = [250, 500, 1000, 2000] as const;
export const DEFAULT_BLINK_INTERVAL_MS = 500;
export const ZOOM_LEVELS = [1, 2, 4] as const;

export interface PlayerState {
  /** Index of the frame on screen. */
  frame: number;
  playing: boolean;
  intervalMs: number;
}

export type PlayerAction =
  | { type: 'toggle'; frameCount: number }
  | { type: 'tick'; frameCount: number }
  | { type: 'select'; frame: number; frameCount: number }
  | { type: 'step'; direction: 1 | -1; frameCount: number }
  | { type: 'speed'; intervalMs: number }
  | { type: 'pause' };

export function initialPlayer(): PlayerState {
  return { frame: 0, playing: false, intervalMs: DEFAULT_BLINK_INTERVAL_MS };
}

const wrap = (frame: number, count: number): number => (count <= 0 ? 0 : ((frame % count) + count) % count);

export function playerReducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case 'toggle':
      // Nothing to blink between with fewer than two frames.
      return action.frameCount < 2 ? { ...state, playing: false } : { ...state, playing: !state.playing };
    case 'tick':
      return state.playing ? { ...state, frame: wrap(state.frame + 1, action.frameCount) } : state;
    case 'select':
      // A manual choice always pauses, so the chosen frame stays on screen.
      return { ...state, playing: false, frame: Math.min(Math.max(0, Math.trunc(action.frame)), Math.max(0, action.frameCount - 1)) };
    case 'step':
      return { ...state, playing: false, frame: wrap(state.frame + action.direction, action.frameCount) };
    case 'speed':
      return BLINK_INTERVALS_MS.includes(action.intervalMs as (typeof BLINK_INTERVALS_MS)[number]) ? { ...state, intervalMs: action.intervalMs } : state;
    case 'pause':
      return state.playing ? { ...state, playing: false } : state;
  }
}

/** The interval that should be running (or `null`): exactly one timer exists whenever this is non-null. */
export function activeTimer(state: PlayerState, frameCount: number, imagesReady: boolean): number | null {
  return state.playing && imagesReady && frameCount >= 2 ? state.intervalMs : null;
}

export function formatInterval(intervalMs: number): string {
  return `${intervalMs / 1000} s`;
}

export function nextZoom(current: number, direction: 'in' | 'out'): number {
  const index = ZOOM_LEVELS.findIndex((level) => level === current);
  const base = index === -1 ? 0 : index;
  return ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, base + (direction === 'in' ? 1 : -1)))] ?? 1;
}
