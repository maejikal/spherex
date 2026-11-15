import type { BlinkMode } from '../../api/types.ts';

/**
 * Loading-screen timing: pure and clock-injectable so it can be unit-tested without a browser.
 *
 * The backend does not report cache status or progress, so nothing here claims either. The estimate is
 * the median of this session's recently completed requests of the same mode, or a conservative default.
 */

/** Conservative archive estimate when nothing has completed yet (measured: cold 45-60 s, warm ~20-30 s). */
export const DEFAULT_ARCHIVE_ESTIMATE_MS = 45_000;
export const MIN_ESTIMATE_MS = 10_000;
/** Archive requests have taken up to ~235 s, so the estimate may rise well beyond a minute. */
export const MAX_ESTIMATE_MS = 300_000;
/** Requests faster than this were served from a cache; they say nothing about how long a new position takes. */
export const CACHED_BELOW_MS = 2_000;
export const COLD_FROM_MS = 40_000;
const KEEP = 10;
const WINDOW = 5;
/** Upper quartile of recent durations: honest about slow requests without being driven by a single outlier. */
const ESTIMATE_QUANTILE = 0.75;
const ROUND_UP_TO_MS = 5_000;
const MAX_PLAUSIBLE_MS = 10 * 60_000;

export type DurationClass = 'cached' | 'warm' | 'cold';

export function classifyDuration(ms: number): DurationClass {
  return ms < CACHED_BELOW_MS ? 'cached' : ms < COLD_FROM_MS ? 'warm' : 'cold';
}

export class DurationHistory {
  private readonly samples: Record<BlinkMode, number[]> = { dynamic: [], local: [] };

  record(mode: BlinkMode, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_PLAUSIBLE_MS) return;
    const list = this.samples[mode];
    list.push(ms);
    if (list.length > KEEP) list.shift();
  }

  recent(mode: BlinkMode, count = WINDOW): number[] {
    return this.samples[mode].slice(-count);
  }

  all(mode: BlinkMode): readonly number[] {
    return this.samples[mode];
  }
}

/** One history per page session: lightweight, in memory, never persisted. */
export const sessionHistory = new DurationHistory();

const median = (values: number[]): number => quantile(values, 0.5);

/** Linear-interpolated quantile of a non-empty list. */
export function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/**
 * Estimated total for a new request, fixed when the request starts (so the display does not jump).
 * Archive: the upper quartile of the last five non-cached durations, rounded up to 5 s and clamped to 10 s-5 min;
 * with no history, 45 s. (Cached repeats are ignored: they say nothing about how long a new position takes.)
 * Local: only when measured local durations exist, else `null` (elapsed time only).
 */
export function estimateTotalMs(mode: BlinkMode, history: DurationHistory = sessionHistory): number | null {
  if (mode === 'dynamic') {
    const useful = history.all('dynamic').filter((ms) => classifyDuration(ms) !== 'cached').slice(-WINDOW);
    if (useful.length === 0) return DEFAULT_ARCHIVE_ESTIMATE_MS;
    const rounded = Math.ceil(quantile(useful, ESTIMATE_QUANTILE) / ROUND_UP_TO_MS) * ROUND_UP_TO_MS;
    return Math.min(MAX_ESTIMATE_MS, Math.max(MIN_ESTIMATE_MS, rounded));
  }
  const measured = history.recent('local');
  if (measured.length === 0) return null;
  return Math.max(2_000, Math.ceil((median(measured) * 1.5) / 1_000) * 1_000);
}

export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Reassuring but accurate notes for long archive requests. They state only what is known from the browser
 * (how long it has been waiting); they never name a backend stage or imply progress, because the API reports none.
 */
export const LOADING_NOTES: ReadonlyArray<{ atSeconds: number; text: string }> = [
  { atSeconds: 30, text: 'Still working. A new field can take a minute or more.' },
  { atSeconds: 60, text: 'Still waiting for a response. Archive requests for a new field can take several minutes.' },
  { atSeconds: 120, text: 'This is taking much longer than usual, but the request is still running. Please keep this window open.' },
  { atSeconds: 240, text: 'This has been running for over four minutes. The archive may be busy; you can keep waiting, or close this window and try again later.' },
];

/** The note for this much elapsed time: the latest threshold passed (archive mode only), or null. */
export function loadingNote(elapsedMs: number, mode: BlinkMode): { level: number; text: string } | null {
  if (mode !== 'dynamic') return null;
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  let found: { level: number; text: string } | null = null;
  LOADING_NOTES.forEach((note, index) => {
    if (seconds >= note.atSeconds) found = { level: index + 1, text: note.text };
  });
  return found;
}

export const OVERRUN_CAPTION = 'Taking longer than expected…';

export interface ClockView {
  elapsed: string;
  /** `~MM:SS`, or null when there is no estimate or the request has outlasted it. */
  estimate: string | null;
  overrun: boolean;
  caption: string;
  /** 0 = no note yet; otherwise 1-4 for the threshold reached. */
  noteLevel: number;
  note: string | null;
}

export function clockView(elapsedMs: number, estimateMs: number | null, mode: BlinkMode = 'dynamic'): ClockView {
  const elapsed = formatClock(elapsedMs);
  const note = loadingNote(elapsedMs, mode);
  const noteFields = { noteLevel: note?.level ?? 0, note: note?.text ?? null };
  if (estimateMs === null) return { elapsed, estimate: null, overrun: false, caption: 'Elapsed time', ...noteFields };
  const elapsedSeconds = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (elapsedSeconds > Math.floor(estimateMs / 1000)) {
    // Never show "00:55 / ~00:45", a negative remainder, or a revised promise.
    return { elapsed, estimate: null, overrun: true, caption: OVERRUN_CAPTION, ...noteFields };
  }
  return { elapsed, estimate: `~${formatClock(estimateMs)}`, overrun: false, caption: 'Elapsed / Estimated total time', ...noteFields };
}

export interface Run {
  readonly key: string;
  readonly mode: BlinkMode;
  readonly startedAt: number;
  readonly estimateMs: number | null;
}

/**
 * The one in-flight analysis. Beginning the same key again returns the same run (React StrictMode runs effects
 * twice); a different key replaces it (a newer analysis wins); finishing a stale key is ignored and never recorded.
 */
export class RunTracker {
  private run: Run | null = null;
  private readonly history: DurationHistory;
  private readonly now: () => number;

  constructor(history: DurationHistory = sessionHistory, now: () => number = () => performance.now()) {
    this.history = history;
    this.now = now;
  }

  get current(): Run | null {
    return this.run;
  }

  begin(key: string, mode: BlinkMode): Run {
    if (this.run && this.run.key === key) return this.run;
    this.run = { key, mode, startedAt: this.now(), estimateMs: estimateTotalMs(mode, this.history) };
    return this.run;
  }

  /** Ends the run for `key`; only a successful, current run feeds the history. Returns the recorded duration. */
  finish(key: string, succeeded: boolean): number | null {
    const run = this.run;
    this.run = null;
    if (!run || run.key !== key || !succeeded) return null;
    const duration = this.now() - run.startedAt;
    this.history.record(run.mode, duration);
    return duration;
  }

  /** Abandons the run without recording (cancelled, replaced, or unmounted). */
  cancel(): void {
    this.run = null;
  }
}
