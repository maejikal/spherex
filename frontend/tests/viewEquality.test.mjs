import test from 'node:test';
import assert from 'node:assert/strict';
import { sameSkyView } from '../src/state/viewEquality.ts';

const view = { ra: 10.684708, dec: 41.26875, scale: 2.5 };

test('layout resize round-off does not become a new celestial view or URL', () => {
  assert.equal(sameSkyView(view, { ...view, scale: 2.499999999999874 }), true);
  assert.equal(sameSkyView(view, { ...view, ra: view.ra + 1e-12, dec: view.dec - 1e-12 }), true);
});

test('view equality respects RA wrapping and signed declination', () => {
  assert.equal(sameSkyView({ ...view, ra: 0 }, { ...view, ra: 360 }), true);
  assert.equal(sameSkyView(view, { ...view, dec: -view.dec }), false);
});

test('real panning and zoom changes still update the celestial view', () => {
  assert.equal(sameSkyView(view, { ...view, ra: view.ra + .000001 }), false);
  assert.equal(sameSkyView(view, { ...view, dec: view.dec + .000001 }), false);
  assert.equal(sameSkyView(view, { ...view, scale: view.scale * 1.001 }), false);
});
