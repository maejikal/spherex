import test from 'node:test';
import assert from 'node:assert/strict';
import { blinkCutoutsPath, BlinkResponseError, parseBlinkResponse } from '../src/sky/blink/response.ts';
import {
  activeTimer,
  BLINK_INTERVALS_MS,
  DEFAULT_BLINK_INTERVAL_MS,
  frameDirectionForKey,
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
  assert.equal(url.searchParams.has('profile'), false);
  const barnard = new URL(blinkCutoutsPath({ ra: 269.446305, dec: 4.767740 }, 256, 'barnards-star'), 'http://x');
  assert.equal(barnard.searchParams.get('profile'), 'barnards-star');
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

test('autoplays each loaded observation from the first frame at 0.5 s', () => {
  const player = initialPlayer();
  assert.deepEqual(player, { frame: 0, playing: true, intervalMs: 500 });
  assert.equal(activeTimer(player, 2, false), null); // playback waits until every image is ready
  assert.equal(activeTimer(player, 2, true), 500);
  assert.equal(DEFAULT_BLINK_INTERVAL_MS, 500);
  assert.deepEqual([...BLINK_INTERVALS_MS], [100, 250, 500]);
});

test('left and right arrow keys map to previous and next frames only', () => {
  assert.equal(frameDirectionForKey('ArrowLeft'), -1);
  assert.equal(frameDirectionForKey('ArrowRight'), 1);
  assert.equal(frameDirectionForKey('ArrowUp'), null);
  assert.equal(frameDirectionForKey(' '), null);
});

test('play alternates between the two frames and wraps', () => {
  let state = playerReducer({ ...initialPlayer(), playing: false }, { type: 'toggle', frameCount: 2 });
  assert.equal(state.playing, true);
  const seen = [];
  for (let i = 0; i < 5; i += 1) {
    state = playerReducer(state, { type: 'tick', frameCount: 2 });
    seen.push(state.frame);
  }
  assert.deepEqual(seen, [1, 0, 1, 0, 1]);
});

test('ticks do nothing while paused (a stale timer cannot advance the frame)', () => {
  const paused = { ...initialPlayer(), playing: false };
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
  assert.deepEqual([100, 250, 500].map((intervalMs) => playerReducer(playing, { type: 'speed', intervalMs }).intervalMs), [100, 250, 500]);
  assert.deepEqual(playerReducer(playing, { type: 'speed', intervalMs: 250 }), { frame: 1, playing: true, intervalMs: 250 });
  assert.equal(playerReducer(playing, { type: 'speed', intervalMs: 3 }), playing);
  assert.equal(playerReducer(playing, { type: 'speed', intervalMs: 1000 }), playing);
  assert.equal(playerReducer(playing, { type: 'speed', intervalMs: 2000 }), playing);
});

test('exactly one timer runs, at the current speed, only while playing with images ready', () => {
  const playing = { frame: 0, playing: true, intervalMs: 500 };
  assert.equal(activeTimer(playing, 2, true), 500);
  assert.equal(activeTimer({ ...playing, intervalMs: 250 }, 2, true), 250); // new speed replaces the interval
  assert.equal(activeTimer(playing, 2, false), null); // images still loading
  assert.equal(activeTimer({ ...playing, playing: false }, 2, true), null); // paused: timer cleared
  assert.equal(activeTimer(playing, 1, true), null); // nothing to blink between
});

test('a single frame cannot start playback', () => {
  assert.equal(playerReducer({ ...initialPlayer(), playing: false }, { type: 'toggle', frameCount: 1 }).playing, false);
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

// ---- archive (dynamic) mode ------------------------------------------------------------------------

import { dynamicBlinkPath, parseBlinkModes } from '../src/sky/blink/response.ts';
import { blinkQueryKey, modeLabel, resolveBlinkMode } from '../src/sky/blink/mode.ts';

const dynamicPayload = () => {
  const value = payload();
  value.mode = 'dynamic';
  value.fov_deg = 0.1;
  value.rotation_deg = 15;
  value.geometric_coverage = 1;
  value.frames = value.frames.map((f, i) => ({
    ...f,
    image_url: `/api/blink/dynamic/images/${f.id}.png?ra=210.8&dec=54.3&fov_deg=0.1`,
    bandwidth_um: 0.0464,
    geometric_coverage: 1,
    suspect_fraction: 0.012,
    calibration_version: 'cal-1',
    wavelength_um: { min: 1.86, max: 1.9, mean: i === 0 ? 1.8712261376 : 1.8880076269 },
  }));
  value.selection = {
    predicted_gap_nm: 16.196, actual_gap_nm: 16.781489, actual_gap_over_bandwidth: 0.36, field_gap_nm: 47.4,
    bandwidth_difference_fraction: 0.005, epoch_separation_days: 211.7, candidates_tried: 2, rejected_candidates: ['A / B: quality'], thresholds: {},
  };
  value.provenance = { source: 'NASA/IPAC Infrared Science Archive (IRSA)', collection: 'spherex_dr1', release: 'l2b-v27-2026-198', flag_policy: 'SOURCE kept' };
  return value;
};

test('parses an archive-mode response with selection, provenance and per-frame wavelength metadata', () => {
  const parsed = parseBlinkResponse(dynamicPayload(), resolve);
  assert.equal(parsed.mode, 'dynamic');
  assert.equal(parsed.rotationDeg, 15);
  assert.equal(parsed.fovDeg, 0.1);
  assert.equal(parsed.frames[0].imageUrl, 'http://api.test/api/blink/dynamic/images/2025-05.png?ra=210.8&dec=54.3&fov_deg=0.1');
  assert.equal(parsed.frames[0].wavelengthUm.mean, 1.8712261376);
  assert.equal(parsed.frames[1].bandwidthUm, 0.0464);
  assert.equal(parsed.frames[0].suspectFraction, 0.012);
  assert.equal(parsed.selection.actualGapNm, 16.781489);
  assert.equal(parsed.selection.candidatesTried, 2);
  assert.deepEqual(parsed.selection.rejectedCandidates, ['A / B: quality']);
  assert.equal(parsed.provenance.release, 'l2b-v27-2026-198');
});

test('a local-mode response still parses (no archive fields) and is labelled local', () => {
  const parsed = parseBlinkResponse(payload(), resolve);
  assert.equal(parsed.mode, 'local');
  assert.equal(parsed.selection, undefined);
  assert.equal(parsed.frames[0].bandwidthUm, undefined);
});

test('archive responses may only reference the two blink image routes', () => {
  const value = dynamicPayload();
  value.frames[0].image_url = '/api/blink/dynamic/../health';
  assert.throws(() => parseBlinkResponse(value, resolve), BlinkResponseError);
  const bad = dynamicPayload();
  bad.frames[1].image_url = 'https://evil.example/x.png';
  assert.throws(() => parseBlinkResponse(bad, resolve), BlinkResponseError);
  const ok = dynamicPayload();
  assert.doesNotThrow(() => parseBlinkResponse(ok, resolve));
});

test('the archive request carries the captured coordinates and the field of view', () => {
  const url = new URL(dynamicBlinkPath({ ra: 210.80227, dec: 54.34895 }, 0.1), 'http://x');
  assert.equal(url.pathname, '/api/blink/dynamic');
  assert.equal(url.searchParams.get('ra'), '210.80227');
  assert.equal(url.searchParams.get('dec'), '54.34895');
  assert.equal(url.searchParams.get('fov_deg'), '0.1');
});

test('server modes are parsed strictly', () => {
  assert.deepEqual(parseBlinkModes({ dynamic_enabled: true, local_demo_available: false }), { dynamicEnabled: true, localDemoAvailable: false, localProfiles: [] });
  assert.deepEqual(parseBlinkModes({
    dynamic_enabled: true,
    local_demo_available: true,
    local_profiles: [{ id: 'default', label: 'Local demo (real SPHEREx)' }, { id: 'barnards-star', label: "Barnard's Star" }],
  }), {
    dynamicEnabled: true,
    localDemoAvailable: true,
    localProfiles: [{ id: 'default', label: 'Local demo (real SPHEREx)' }, { id: 'barnards-star', label: "Barnard's Star" }],
  });
  assert.throws(() => parseBlinkModes({ dynamic_enabled: true, local_profiles: [{ id: '../fits', label: 'Unsafe' }] }), BlinkResponseError);
  assert.throws(() => parseBlinkModes({ dynamic_enabled: true, local_profiles: [{ id: 'same', label: 'A' }, { id: 'same', label: 'B' }] }), BlinkResponseError);
  assert.deepEqual(parseBlinkModes({ dynamic_enabled: 'yes' }), { dynamicEnabled: false, localDemoAvailable: false, localProfiles: [] });
  assert.throws(() => parseBlinkModes(null), BlinkResponseError);
});

test('archive mode is preferred; the local SPHEREx is chosen only explicitly or when archive mode is off', () => {
  const both = { dynamicEnabled: true, localDemoAvailable: true };
  assert.equal(resolveBlinkMode('dynamic', both), 'dynamic');
  assert.equal(resolveBlinkMode('local', both), 'local'); // an explicit choice is respected
  assert.equal(resolveBlinkMode('dynamic', { dynamicEnabled: false, localDemoAvailable: true }), 'local');
  assert.equal(resolveBlinkMode('local', { dynamicEnabled: true, localDemoAvailable: false }), 'dynamic');
  assert.equal(resolveBlinkMode('dynamic', undefined), 'dynamic'); // modes not loaded yet: do not guess
  assert.equal(resolveBlinkMode('dynamic', { dynamicEnabled: false, localDemoAvailable: false }), 'dynamic'); // nothing to fall back to
});

test('a failed archive request is never answered with local data on its own', () => {
  // The mode only changes through resolveBlinkMode (server capability) or an explicit user action; errors do not feed into it.
  const both = { dynamicEnabled: true, localDemoAvailable: true };
  let mode = 'dynamic';
  const error = { message: 'archive down', code: 'upstream_unavailable', status: 502 };
  assert.equal(describeBlinkError(error).kind, 'archive-unavailable');
  mode = resolveBlinkMode(mode, both);
  assert.equal(mode, 'dynamic');
});

test('queries are keyed by mode and position so a mode switch or a new analysis never shows a stale result', () => {
  const t = { ra: 210.8, dec: 54.3 };
  assert.notDeepEqual(blinkQueryKey('dynamic', t, 0.1), blinkQueryKey('local', t, 256));
  assert.notDeepEqual(blinkQueryKey('dynamic', t, 0.1), blinkQueryKey('dynamic', { ra: 210.9, dec: 54.3 }, 0.1));
  assert.deepEqual(blinkQueryKey('dynamic', t, 0.1), blinkQueryKey('dynamic', { ...t }, 0.1));
  assert.deepEqual(blinkQueryKey('dynamic', t, 0.1, 'default'), blinkQueryKey('dynamic', t, 0.1, 'barnards-star'));
  assert.notDeepEqual(blinkQueryKey('local', t, 256), blinkQueryKey('local', t, 256, 'default'));
  assert.notDeepEqual(blinkQueryKey('local', t, 256, 'default'), blinkQueryKey('local', t, 256, 'barnards-star'));
  assert.equal(modeLabel('dynamic'), 'SPHEREx data');
  assert.equal(modeLabel('local'), 'Local SPHEREx');
});

test('each archive failure reason gets its own explanation and only transient ones are retryable', () => {
  const kinds = {
    no_observations: ['no-observations', false],
    insufficient_coverage: ['insufficient-coverage', false],
    wavelength_mismatch: ['wavelength-mismatch', false],
    invalid_calibration: ['invalid-calibration', true],
    coordinate_mapping_failed: ['coordinate-mapping', false],
    footprint_mismatch: ['footprint-mismatch', false],
    quality_failure: ['quality-failure', false],
    upstream_unavailable: ['archive-unavailable', true],
    upstream_timeout: ['archive-unavailable', true],
  };
  for (const [code, [kind, retryable]] of Object.entries(kinds)) {
    const view = describeBlinkError({ message: `m-${code}`, code, status: code.startsWith('upstream') ? 502 : 404 });
    assert.equal(view.kind, kind, code);
    assert.equal(view.retryable, retryable, code);
    assert.equal(view.message, `m-${code}`); // the backend's own explanation is shown unchanged
  }
});

test('a failed position check is never described as a calibration problem', () => {
  const mapping = describeBlinkError({ message: 'the detector coordinates of the observations could not be verified', code: 'coordinate_mapping_failed', status: 404 });
  const footprint = describeBlinkError({ message: 'the archive footprint contradicts the observations', code: 'footprint_mismatch', status: 404 });
  const calibration = describeBlinkError({ message: 'the wavelength calibration table was unavailable', code: 'invalid_calibration', status: 404 });
  assert.equal(calibration.title, 'Wavelength calibration unavailable');
  for (const view of [mapping, footprint]) {
    assert.notEqual(view.title, calibration.title);
    assert.doesNotMatch(view.title, /calibration/i);
  }
  assert.equal(new Set([mapping.title, footprint.title, calibration.title]).size, 3);
});

test('archive wavelength selection travels in the request and isolates cached pairs', () => {
  const target = { ra: 12, dec: -8 };
  const selected = new URL(dynamicBlinkPath(target, 0.1, 1.861), 'http://x');
  assert.equal(selected.searchParams.get('wavelength_um'), '1.861');
  assert.equal(new URL(dynamicBlinkPath(target, 0.1), 'http://x').searchParams.has('wavelength_um'), false);
  assert.notDeepEqual(blinkQueryKey('dynamic', target, 0.1, 'auto', 1.861), blinkQueryKey('dynamic', target, 0.1, 'auto', 4.112));
  assert.notDeepEqual(blinkQueryKey('dynamic', target, 0.1), blinkQueryKey('dynamic', target, 0.1, 'auto', 1.861));
  assert.deepEqual(blinkQueryKey('local', target, 256, 'auto', 1.861), blinkQueryKey('local', target, 256, 'auto', 4.112));
});

test('requested nominal wavelength survives parsing separately from measured frame wavelengths', () => {
  const value = dynamicPayload();
  value.requested_wavelength_um = 4.112;
  assert.equal(parseBlinkResponse(value, resolve).requestedWavelengthUm, 4.112);
  assert.equal(parseBlinkResponse(dynamicPayload(), resolve).requestedWavelengthUm, undefined);
});

test('detector is sent to archive API and separates query caches', () => {
  const target = { ra: 12, dec: -8 };
  assert.equal(new URL(dynamicBlinkPath(target, 0.1, null, 5), 'http://x').searchParams.get('detector'), '5');
  assert.notDeepEqual(blinkQueryKey('dynamic', target, 0.1, 'auto', null, 3), blinkQueryKey('dynamic', target, 0.1, 'auto', null, 5));
  assert.deepEqual(blinkQueryKey('local', target, 256, 'auto', null, 3), blinkQueryKey('local', target, 256, 'auto', null, 5));
});
