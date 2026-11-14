import test from 'node:test';
import assert from 'node:assert/strict';
import { blinkCutoutsPath, BlinkResponseError, parseBlinkResponse } from '../src/sky/blink/response.ts';
import {
  activeTimer,
  BLINK_INTERVALS_MS,
  DEFAULT_BLINK_INTERVAL_MS,
  initialPlayer,
  nextZoom,
  playerReducer,
} from '../src/sky/blink/playback.ts';
import { describeBlinkError, isPartialCoverage } from '../src/sky/blink/errors.ts';
import { initialPanels, initialPosition, orderForAnalysis, panelsForAnalysis, raise, zIndexFor } from '../src/state/windows.ts';

const frame = (id, label, date) => ({
  id, label, date, date_obs: `${date}T00:00:00`, mjd: 60000, obsid: `OBS_${id}`, detector: 5,
  image_url: `/api/blink/images/${id}.png?ra=210.54&dec=54.46&size=256`, coverage_fraction: 0.97,
  wavelength_um: { min: 4.05, max: 4.16, mean: 4.1 }, background_mjy_sr: 0.15, unit: 'MJy / sr',
});
const payload = () => ({
  coordinates: { ra: 210.54, dec: 54.46 }, image_size: 256, pixel_scale_arcsec: 6.15, field_of_view_arcmin: 26.24,
  orientation: 'North up, east left', common_coverage_fraction: 0.93, warnings: ['Partial coverage: x'],
  frames: [frame('2025-05', 'May 2025', '2025-05-24'), frame('2025-12', 'December 2025', '2025-12-08')],
});
const resolve = (path) => `http://api.test${path}`;

// ---- API response parsing ------------------------------------------------------------------------

test('parses a valid response into camelCase frames with resolved image URLs', () => {
  const parsed = parseBlinkResponse(payload(), resolve);
  assert.equal(parsed.frames.length, 2);
  assert.deepEqual([parsed.ra, parsed.dec, parsed.imageSize], [210.54, 54.46, 256]);
  assert.equal(parsed.frames[0].label, 'May 2025');
  assert.equal(parsed.frames[0].imageUrl, 'http://api.test/api/blink/images/2025-05.png?ra=210.54&dec=54.46&size=256');
  assert.deepEqual(parsed.frames[1].wavelengthUm, { min: 4.05, max: 4.16, mean: 4.1 });
  assert.equal(parsed.frames[1].obsid, 'OBS_2025-12');
  assert.deepEqual(parsed.warnings, ['Partial coverage: x']);
});

test('rejects malformed responses instead of rendering them', () => {
  const bad = (mutate) => {
    const value = payload();
    mutate(value);
    assert.throws(() => parseBlinkResponse(value, resolve), BlinkResponseError);
  };
  bad((v) => { v.frames.pop(); });
  bad((v) => { v.frames[0].coverage_fraction = 1.5; });
  bad((v) => { v.coordinates.ra = 400; });
  bad((v) => { v.frames[1].id = v.frames[0].id; });
  bad((v) => { v.image_size = 0; });
  bad((v) => { delete v.frames[0].label; });
  assert.throws(() => parseBlinkResponse(null, resolve), BlinkResponseError);
  assert.throws(() => parseBlinkResponse({ ...payload(), frames: 'nope' }, resolve), BlinkResponseError);
});

test('only accepts image URLs under the blink image route', () => {
  for (const url of ['https://evil.example/x.png', '//evil.example/x.png', '/api/health', 'javascript:alert(1)']) {
    const value = payload();
    value.frames[0].image_url = url;
    assert.throws(() => parseBlinkResponse(value, resolve), BlinkResponseError, url);
  }
});

// ---- coordinate propagation ----------------------------------------------------------------------

test('the request carries exactly the coordinates captured when Analyze was clicked', () => {
  const path = blinkCutoutsPath({ ra: 210.541234567, dec: -54.46 }, 256);
  const url = new URL(path, 'http://x');
  assert.equal(url.pathname, '/api/blink/cutouts');
  assert.equal(url.searchParams.get('ra'), '210.541234567');
  assert.equal(url.searchParams.get('dec'), '-54.46');
  assert.equal(url.searchParams.get('size'), '256');
});

// ---- window state transitions --------------------------------------------------------------------

test('Analyze opens Inspect and the Blink Viewer together and leaves Find and View alone', () => {
  const start = initialPanels(); // only Find open
  const panels = panelsForAnalysis({ ...start, view: true }, false);
  assert.deepEqual(panels, { find: true, view: true, inspect: true });
  assert.equal(start.inspect, false); // not mutated
});

test('the Blink Viewer is raised last but Inspect stays above Find and View', () => {
  const order = orderForAnalysis(['find', 'view', 'inspect', 'blink'], false);
  assert.deepEqual(order, ['find', 'view', 'inspect', 'blink']);
  const fromFront = orderForAnalysis(['blink', 'inspect', 'find', 'view'], false);
  assert.equal(fromFront.at(-1), 'blink');
  assert.ok(zIndexFor(fromFront, 'inspect') > zIndexFor(fromFront, 'find'));
  assert.ok(zIndexFor(fromFront, 'blink') > zIndexFor(fromFront, 'inspect'));
});

test('a phone-sized screen shows only the Blink Viewer sheet', () => {
  assert.deepEqual(panelsForAnalysis({ find: true, view: true, inspect: false }, true), { find: false, view: false, inspect: false });
  assert.equal(orderForAnalysis(['find', 'view', 'inspect', 'blink'], true).at(-1), 'blink');
});

test('windows are independent: raising one never reorders the others', () => {
  const order = ['find', 'view', 'inspect', 'blink'];
  assert.deepEqual(raise(order, 'inspect'), ['find', 'view', 'blink', 'inspect']);
  assert.deepEqual(order, ['find', 'view', 'inspect', 'blink']);
});

test('the Blink Viewer opens bottom-aligned immediately left of Inspect, leaving Inspect fully visible', () => {
  const workspace = { width: 1440, height: 794 };
  const inspect = { x: 1440 - 16 - 360, y: 16, width: 360, height: 700 };
  const position = initialPosition({ placement: 'left-of', workspace, panel: { width: 480, height: 640 }, anchor: inspect });
  assert.deepEqual(position, { x: inspect.x - 16 - 480, y: 794 - 640 - 16 });
  assert.ok(position.x + 480 <= inspect.x, 'no horizontal overlap with Inspect');
  assert.ok(position.x >= 16 + 352, 'and none with a 352px Find window at the left on a 1440px screen');
});

test('on a narrow screen it stays beside Inspect (covering Find rather than Inspect) and never leaves the screen', () => {
  const workspace = { width: 1024, height: 539 };
  const inspect = { x: 1024 - 16 - 360, y: 16, width: 360, height: 507 };
  const position = initialPosition({ placement: 'left-of', workspace, panel: { width: 480, height: 507 }, anchor: inspect });
  assert.ok(position.x >= 16 && position.x + 480 <= inspect.x);
  const tiny = initialPosition({ placement: 'left-of', workspace: { width: 800, height: 500 }, panel: { width: 480, height: 400 }, anchor: { x: 424, y: 16, width: 360, height: 400 } });
  assert.equal(tiny.x, 16); // clamped to the left gap; callers clamp the rest into the workspace
});

test('without Inspect on screen it falls back to the bottom centre', () => {
  const workspace = { width: 1440, height: 772 };
  assert.deepEqual(initialPosition({ placement: 'left-of', workspace, panel: { width: 480, height: 640 }, anchor: null }), { x: 480, y: 772 - 640 - 16 });
  assert.deepEqual(initialPosition({ placement: 'center-bottom', workspace, panel: { width: 480, height: 640 } }), { x: 480, y: 772 - 640 - 16 });
});

// ---- playback ------------------------------------------------------------------------------------

test('starts paused on the first frame at 0.5 s', () => {
  assert.deepEqual(initialPlayer(), { frame: 0, playing: false, intervalMs: 500 });
  assert.equal(DEFAULT_BLINK_INTERVAL_MS, 500);
  assert.deepEqual([...BLINK_INTERVALS_MS], [250, 500, 1000, 2000]);
});

test('play alternates between the two frames and wraps', () => {
  let state = playerReducer(initialPlayer(), { type: 'toggle', frameCount: 2 });
  assert.equal(state.playing, true);
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    state = playerReducer(state, { type: 'tick', frameCount: 2 });
    seen.push(state.frame);
  }
  assert.deepEqual(seen, [1, 0, 1, 0, 1]);
});

test('ticks do nothing while paused (a stale timer cannot advance the frame)', () => {
  const paused = initialPlayer();
  assert.equal(playerReducer(paused, { type: 'tick', frameCount: 2 }), paused);
});

test('choosing a frame manually pauses and shows exactly that frame', () => {
  const playing = { frame: 0, playing: true, intervalMs: 250 };
  assert.deepEqual(playerReducer(playing, { type: 'select', frame: 1, frameCount: 2 }), { frame: 1, playing: false, intervalMs: 250 });
  assert.equal(playerReducer(playing, { type: 'select', frame: 9, frameCount: 2 }).frame, 1); // clamped
  assert.equal(playerReducer(playing, { type: 'select', frame: -3, frameCount: 2 }).frame, 0);
});

test('previous / next step with wrap-around and pause playback', () => {
  const playing = { frame: 0, playing: true, intervalMs: 500 };
  assert.deepEqual(playerReducer(playing, { type: 'step', direction: -1, frameCount: 2 }), { frame: 1, playing: false, intervalMs: 500 });
  assert.equal(playerReducer({ frame: 1, playing: false, intervalMs: 500 }, { type: 'step', direction: 1, frameCount: 2 }).frame, 0);
});

test('speed changes keep the frame and playing state, and only allow the offered speeds', () => {
  const playing = { frame: 1, playing: true, intervalMs: 500 };
  assert.deepEqual(playerReducer(playing, { type: 'speed', intervalMs: 250 }), { frame: 1, playing: true, intervalMs: 250 });
  assert.equal(playerReducer(playing, { type: 'speed', intervalMs: 3 }), playing);
});

test('exactly one timer runs, at the current speed, only while playing with images ready', () => {
  const playing = { frame: 0, playing: true, intervalMs: 1000 };
  assert.equal(activeTimer(playing, 2, true), 1000);
  assert.equal(activeTimer({ ...playing, intervalMs: 250 }, 2, true), 250); // new speed replaces the interval
  assert.equal(activeTimer(playing, 2, false), null); // images still loading
  assert.equal(activeTimer({ ...playing, playing: false }, 2, true), null); // paused: timer cleared
  assert.equal(activeTimer(playing, 1, true), null); // nothing to blink between
});

test('a single frame cannot start playback', () => {
  assert.equal(playerReducer(initialPlayer(), { type: 'toggle', frameCount: 1 }).playing, false);
});

test('zoom steps through 1x, 2x and 4x and stops at the ends', () => {
  assert.equal(nextZoom(1, 'in'), 2);
  assert.equal(nextZoom(2, 'in'), 4);
  assert.equal(nextZoom(4, 'in'), 4);
  assert.equal(nextZoom(2, 'out'), 1);
  assert.equal(nextZoom(1, 'out'), 1);
});

// ---- loading / error states ----------------------------------------------------------------------

test('no coverage explains the prototype limitation and is not retryable', () => {
  const view = describeBlinkError({ message: 'No usable SPHEREx observations are available for this selected region.', code: 'no_fits_coverage', status: 404 });
  assert.equal(view.kind, 'no-coverage');
  assert.equal(view.retryable, false);
  assert.match(view.message, /No usable SPHEREx observations are available for this selected region\./);
  assert.match(view.message, /two local observations/);
});

test('each failure mode maps to a distinct, honest message', () => {
  assert.equal(describeBlinkError({ message: 'x', code: 'fits_unavailable', status: 503 }).kind, 'data-unavailable');
  assert.equal(describeBlinkError({ message: 'x', code: 'invalid_parameters', status: 422 }).retryable, false);
  assert.equal(describeBlinkError({ message: 'Could not reach the Sky Explorer API.', code: null, status: null }).kind, 'unreachable');
  assert.equal(describeBlinkError({ message: 'x', code: 'fits_processing_error', status: 500 }).kind, 'processing');
  assert.equal(describeBlinkError({ message: 'x', code: 'invalid_response', status: 200 }).kind, 'bad-response');
  assert.equal(describeBlinkError(new Error('boom')).kind, 'unreachable'); // no status: treated as a failed request
  assert.equal(describeBlinkError('weird').message, 'The request failed.');
});

test('partial coverage is flagged when any frame is below the threshold', () => {
  assert.equal(isPartialCoverage([0.99, 0.97]), false);
  assert.equal(isPartialCoverage([0.99, 0.6]), true);
});
