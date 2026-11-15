import test from 'node:test';
import assert from 'node:assert/strict';
import { alphaBounds, sharedViewport } from '../src/sky/blink/viewport.ts';

test('finds usable pixel bounds, ignoring transparent padding but retaining black sky', () => {
  const rgba = new Uint8ClampedArray(8 * 8 * 4);
  for (const [x, y] of [[4, 2], [6, 5]]) rgba[(y * 8 + x) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(rgba, 8, 8), { x: 4, y: 2, width: 3, height: 4 });
  assert.equal(alphaBounds(new Uint8ClampedArray(16), 2, 2), null);
});

test('both epochs share tight union bounds, never independent crops that erase motion', () => {
  assert.deepEqual(sharedViewport([
    { x: 160, y: 50, width: 70, height: 80 },
    { x: 162, y: 48, width: 72, height: 80 },
  ], 256), { x: 160, y: 48, width: 74, height: 82 });
});

test('does not add a large fixed border to small usable fields', () => {
  assert.deepEqual(sharedViewport([{ x: 100, y: 90, width: 20, height: 20 }], 256),
    { x: 100, y: 90, width: 20, height: 20 });
});

test('keeps rectangular footprint instead of padding it to a square', () => {
  assert.deepEqual(sharedViewport([{ x: 0, y: 0, width: 20, height: 50 }], 64),
    { x: 0, y: 0, width: 20, height: 50 });
});

test('falls back to full field for missing data and retains full coverage', () => {
  const full = { x: 0, y: 0, width: 256, height: 256 };
  assert.deepEqual(sharedViewport([{ x: 10, y: 10, width: 20, height: 20 }, null], 256), full);
  assert.deepEqual(sharedViewport([null, null], 256), full);
  assert.deepEqual(sharedViewport([], 256), full);
  assert.deepEqual(sharedViewport([full], 256), full);
});
