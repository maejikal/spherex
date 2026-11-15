import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyDuration, clockView, DEFAULT_ARCHIVE_ESTIMATE_MS, DurationHistory, estimateTotalMs, formatClock, loadingNote, LOADING_NOTES,
  MAX_ESTIMATE_MS, OVERRUN_CAPTION, quantile, RunTracker,
} from '../src/sky/blink/timing.ts';

const clock = (start = 1000) => { let t = start; const now = () => t; now.advance = (ms) => { t += ms; }; return now; };
const tracker = (history = new DurationHistory(), now = clock()) => ({ t: new RunTracker(history, now), history, now });

test('the clock starts at zero with the default archive estimate', () => {
  const { t } = tracker();
  const run = t.begin('dynamic|1|2', 'dynamic');
  assert.equal(run.estimateMs, DEFAULT_ARCHIVE_ESTIMATE_MS);
  const view = clockView(0, run.estimateMs);
  assert.deepEqual([view.elapsed, view.estimate, view.overrun, view.caption], ['00:00', '~00:45', false, 'Elapsed / Estimated total time']);
});

test('elapsed time comes from a monotonic clock, so it is right even if updates were skipped (tab suspension)', () => {
  const { t, now } = tracker();
  const run = t.begin('k', 'dynamic');
  now.advance(18_400);
  assert.equal(clockView(now() - run.startedAt, run.estimateMs).elapsed, '00:18');
  now.advance(95_000); // a suspended tab: no ticks happened, the next read still reports the true elapsed time
  assert.equal(formatClock(now() - run.startedAt), '01:53');
});

test('formatting: MM:SS, truncated not rounded, never negative or NaN', () => {
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(999), '00:00');
  assert.equal(formatClock(1000), '00:01');
  assert.equal(formatClock(59_999), '00:59');
  assert.equal(formatClock(60_000), '01:00');
  assert.equal(formatClock(18_000), '00:18');
  assert.equal(formatClock(3_600_000), '60:00');
  assert.equal(formatClock(-5000), '00:00');
  assert.equal(formatClock(Number.NaN), '00:00');
});

test('a new analysis resets the clock; the same key (StrictMode double effect) does not', () => {
  const { t, now } = tracker();
  const first = t.begin('a', 'dynamic');
  now.advance(5000);
  assert.equal(t.begin('a', 'dynamic'), first); // same run object: no duplicate timer, no reset
  const second = t.begin('b', 'dynamic');
  assert.notEqual(second, first);
  assert.equal(second.startedAt, now());
  assert.equal(t.current, second);
});

test('the clock stops when the request completes and a successful duration is recorded', () => {
  const { t, now, history } = tracker();
  t.begin('a', 'dynamic');
  now.advance(27_000);
  assert.equal(t.finish('a', true), 27_000);
  assert.equal(t.current, null);
  assert.deepEqual([...history.all('dynamic')], [27_000]);
});

test('failures and cancellations stop the clock without recording', () => {
  const { t, now, history } = tracker();
  t.begin('a', 'dynamic'); now.advance(3000);
  assert.equal(t.finish('a', false), null);
  assert.equal(t.current, null);
  t.begin('a', 'dynamic'); now.advance(3000); t.cancel();
  assert.equal(t.current, null);
  assert.equal(history.all('dynamic').length, 0);
  assert.equal(t.finish('a', true), null); // nothing in flight
});

test('retry after an error starts a fresh clock', () => {
  const { t, now } = tracker();
  const first = t.begin('a', 'dynamic'); now.advance(8000); t.finish('a', false);
  now.advance(4000);
  const retry = t.begin('a', 'dynamic');
  assert.notEqual(retry, first);
  assert.equal(retry.startedAt, now()); // reset to zero, not continuing from the failed attempt
});

test('stale requests cannot stop, record into, or restart the current run', () => {
  const { t, now, history } = tracker();
  t.begin('old', 'dynamic'); now.advance(2000);
  const current = t.begin('new', 'dynamic'); now.advance(30_000);
  assert.equal(t.finish('old', true), null); // the superseded request finishing late is ignored...
  assert.equal(history.all('dynamic').length, 0);
  assert.equal(t.current, null); // ...and clears the tracker rather than leaving a ghost run
  assert.equal(current.key, 'new');
});

test('mode switching: each mode gets its own estimate and a switch replaces the run', () => {
  const { t } = tracker();
  const archive = t.begin('dynamic|1|2', 'dynamic');
  const local = t.begin('local|1|2', 'local');
  assert.equal(archive.estimateMs, 45_000);
  assert.equal(local.estimateMs, null);
  assert.equal(t.current, local);
});

test('the estimate is stable during a run even if other requests complete meanwhile', () => {
  const { t, history, now } = tracker();
  const run = t.begin('a', 'dynamic');
  history.record('dynamic', 90_000);
  now.advance(10_000);
  assert.equal(run.estimateMs, 45_000);
  assert.equal(estimateTotalMs('dynamic', history), 90_000); // only the NEXT request sees the new history
});

test('estimates adapt to completed archive requests (upper quartile of the last five, rounded up to 5 s, clamped)', () => {
  const h = new DurationHistory();
  assert.equal(estimateTotalMs('dynamic', h), 45_000);
  h.record('dynamic', 58_500);
  assert.equal(estimateTotalMs('dynamic', h), 60_000);
  h.record('dynamic', 22_900); h.record('dynamic', 19_100);
  assert.equal(estimateTotalMs('dynamic', h), 45_000); // sorted 19.1, 22.9, 58.5: 75th percentile 40.7 s -> 45 s (not fooled by the median)
  h.record('dynamic', 21_000); h.record('dynamic', 23_000);
  assert.equal(estimateTotalMs('dynamic', h), 25_000); // sorted 19.1, 21.0, 22.9, 23.0, 58.5: 75th percentile 23.0 s
  const fast = new DurationHistory(); fast.record('dynamic', 3_000);
  assert.equal(estimateTotalMs('dynamic', fast), 10_000); // clamped up
  const huge = new DurationHistory(); huge.record('dynamic', 500_000);
  assert.equal(estimateTotalMs('dynamic', huge), MAX_ESTIMATE_MS); // clamped down to five minutes
});

test('estimates are no longer capped at two minutes: a 235 s request raises the next estimate to 235 s', () => {
  const h = new DurationHistory();
  h.record('dynamic', 235_000);
  assert.equal(estimateTotalMs('dynamic', h), 235_000);
  h.record('dynamic', 25_000);
  assert.equal(estimateTotalMs('dynamic', h), 185_000); // 75th percentile of 25 s and 235 s = 182.5 s -> 185 s
  for (let i = 0; i < 5; i += 1) h.record('dynamic', 24_000); // five fast ones push the slow outlier out of the window
  assert.equal(estimateTotalMs('dynamic', h), 25_000);
  assert.equal(quantile([10, 20, 30, 40], 0.75), 32.5);
  assert.equal(quantile([7], 0.75), 7);
});

test('cached requests (under 2 s) are recorded as cached and never lower the estimate for a new position', () => {
  assert.deepEqual([500, 1999, 2000, 25_000, 39_999, 40_000, 58_000].map(classifyDuration), ['cached', 'cached', 'warm', 'warm', 'warm', 'cold', 'cold']);
  const h = new DurationHistory();
  h.record('dynamic', 50_000);
  h.record('dynamic', 20); h.record('dynamic', 18); h.record('dynamic', 25); // repeats of an already-analysed position
  assert.equal(estimateTotalMs('dynamic', h), 50_000);
  const onlyCached = new DurationHistory(); onlyCached.record('dynamic', 20);
  assert.equal(estimateTotalMs('dynamic', onlyCached), 45_000); // no evidence about new positions: conservative default
});

test('invalid durations are ignored', () => {
  const h = new DurationHistory();
  for (const bad of [Number.NaN, -1, Infinity, 10 * 60_000 + 1]) h.record('dynamic', bad);
  assert.equal(h.all('dynamic').length, 0);
});

test('overrun: no "00:55 / ~00:45", no negative remainder, no new promise; boundary is exact', () => {
  const at45 = clockView(45_000, 45_000);
  assert.equal(at45.overrun, false);
  assert.equal(`${at45.elapsed} / ${at45.estimate}`, '00:45 / ~00:45');
  const slow = clockView(55_000, 45_000);
  assert.deepEqual([slow.elapsed, slow.estimate, slow.overrun, slow.caption], ['00:55', null, true, 'Taking longer than expected…']);
  assert.equal(clockView(46_000, 45_000).overrun, true);
  assert.equal(clockView(300_000, 45_000).elapsed, '05:00'); // keeps counting
  assert.equal(clockView(300_000, 45_000).estimate, null);
});

test('local demo: elapsed only, with a short estimate only after measured local durations', () => {
  const h = new DurationHistory();
  assert.equal(estimateTotalMs('local', h), null);
  const noEstimate = clockView(3000, estimateTotalMs('local', h));
  assert.deepEqual([noEstimate.elapsed, noEstimate.estimate, noEstimate.overrun, noEstimate.caption], ['00:03', null, false, 'Elapsed time']);
  h.record('local', 400);
  assert.equal(estimateTotalMs('local', h), 2_000); // short, never the 45 s archive figure
  h.record('local', 1800); h.record('local', 2200);
  assert.equal(estimateTotalMs('local', h), 3_000);
  assert.equal(h.all('dynamic').length, 0); // local timings never leak into the archive estimate
  const archiveOnly = new DurationHistory(); archiveOnly.record('dynamic', 50_000);
  assert.equal(estimateTotalMs('local', archiveOnly), null);
});

test('a request that finishes before the first tick records a tiny duration and leaves no run behind', () => {
  const { t, now, history } = tracker();
  t.begin('a', 'dynamic'); now.advance(20);
  assert.equal(t.finish('a', true), 20);
  assert.equal(t.current, null);
  assert.equal(estimateTotalMs('dynamic', history), 45_000);
});

// ---- long-request messages ---------------------------------------------------------------------

test('there are exactly four notes, at 30, 60, 120 and 240 seconds, and none claims a backend stage or progress', () => {
  assert.deepEqual(LOADING_NOTES.map((n) => n.atSeconds), [30, 60, 120, 240]);
  for (const { text } of LOADING_NOTES) {
    assert.doesNotMatch(text, /download|search|align|reproject|calibrat|verify|verif|%|almost|nearly done|finishing|progress/i, text);
  }
});

test('notes appear at each threshold (inclusive) and not before; each replaces the previous one', () => {
  const at = (s) => loadingNote(s * 1000, 'dynamic');
  assert.equal(at(0), null);
  assert.equal(at(29.999), null);
  assert.equal(at(30)?.level, 1);
  assert.equal(at(59)?.level, 1);
  assert.equal(at(60)?.level, 2);
  assert.equal(at(119.9)?.level, 2);
  assert.equal(at(120)?.level, 3);
  assert.equal(at(239)?.level, 3);
  assert.equal(at(240)?.level, 4);
  assert.equal(at(3600)?.level, 4); // stays on the last note
  assert.equal(at(30)?.text, LOADING_NOTES[0].text);
  assert.equal(at(240)?.text, LOADING_NOTES[3].text);
  assert.equal(loadingNote(-5, 'dynamic'), null);
  assert.equal(loadingNote(Number.NaN, 'dynamic'), null);
});

test('local mode shows no archive notes at any elapsed time', () => {
  for (const s of [0, 30, 60, 120, 240, 600]) assert.equal(loadingNote(s * 1000, 'local'), null);
  assert.equal(clockView(300_000, null, 'local').note, null);
});

test('the clock view carries the note level alongside the estimate and overrun state', () => {
  const early = clockView(10_000, 45_000);
  assert.deepEqual([early.noteLevel, early.note, early.overrun], [0, null, false]);
  const t30 = clockView(31_000, 45_000);
  assert.deepEqual([t30.elapsed, t30.estimate, t30.noteLevel, t30.overrun], ['00:31', '~00:45', 1, false]); // note shown while still within the estimate
  const t60 = clockView(61_000, 45_000);
  assert.deepEqual([t60.estimate, t60.overrun, t60.caption, t60.noteLevel], [null, true, OVERRUN_CAPTION, 2]);
  assert.equal(OVERRUN_CAPTION, 'Taking longer than expected…');
});

test('a slow request: estimate overrun, then notes, then success recorded and the next estimate adapts', () => {
  const { t, now, history } = tracker();
  const run = t.begin('slow', 'dynamic');
  const view = (seconds) => { now.advance(0); return clockView(seconds * 1000, run.estimateMs, run.mode); };
  assert.equal(view(44).overrun, false);
  assert.equal(view(46).caption, OVERRUN_CAPTION);
  assert.equal(view(130).noteLevel, 3);
  assert.equal(view(235).noteLevel, 3);
  assert.equal(view(235).elapsed, '03:55');
  now.advance(235_000);
  assert.equal(t.finish('slow', true), 235_000);
  const next = t.begin('next', 'dynamic');
  assert.equal(next.estimateMs, 235_000); // adaptive: no longer assumes 45 s
  assert.equal(clockView(100_000, next.estimateMs).overrun, false); // and does not call a 100 s wait "late"
});

test('a slow request is never cancelled, restarted or timed out by the clock', () => {
  const { t, now } = tracker();
  const run = t.begin('slow', 'dynamic');
  now.advance(60 * 60_000); // an hour
  assert.equal(t.current, run); // still the same in-flight run, same start time
  assert.equal(t.begin('slow', 'dynamic'), run);
  assert.equal(run.startedAt, 1000);
  assert.equal(clockView(now() - run.startedAt, run.estimateMs).elapsed, '60:00');
});

test('a genuine failure after a long wait ends the run without recording it; retry starts from zero with the old estimate', () => {
  const { t, now, history } = tracker();
  t.begin('a', 'dynamic'); now.advance(200_000);
  assert.equal(t.finish('a', false), null);
  assert.equal(history.all('dynamic').length, 0); // a timeout/failure is not a "completed duration"
  now.advance(1000);
  const retry = t.begin('a', 'dynamic');
  assert.equal(retry.startedAt, now());
  assert.equal(retry.estimateMs, 45_000);
});

test('switching mode, a new analysis or unmounting resets the loading state (no leftover run, estimate, or note)', () => {
  const { t, now } = tracker();
  t.begin('dynamic|1|2', 'dynamic'); now.advance(130_000);
  const local = t.begin('local|1|2', 'local'); // mode switch while waiting
  assert.equal(local.startedAt, now());
  assert.equal(clockView(0, local.estimateMs, local.mode).noteLevel, 0);
  now.advance(5000);
  const fresh = t.begin('dynamic|3|4', 'dynamic'); // a new analysis
  assert.equal(clockView(now() - fresh.startedAt, fresh.estimateMs, fresh.mode).noteLevel, 0);
  t.cancel(); // unmount
  assert.equal(t.current, null);
  assert.equal(t.finish('dynamic|3|4', true), null); // a late result after unmount records nothing
});
