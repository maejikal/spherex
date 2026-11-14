import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateAtPixelOffset,
  calculateFieldOfView,
  normalizeRightAscension,
  panCenterByDrag,
  parseCoordinateInput,
  zoomScale,
} from '../src/sky/coordinates.ts';

test('right ascension wraps into [0, 360)', () => {
  assert.equal(normalizeRightAscension(360), 0);
  assert.equal(normalizeRightAscension(-0.25), 359.75);
});

test('coordinate form rejects out-of-range RA and preserves signed declination', () => {
  assert.deepEqual(parseCoordinateInput('12.5', '-31.25'), {
    ok: true,
    value: { ra: 12.5, dec: -31.25 },
  });
  assert.equal(parseCoordinateInput('360', '0').ok, false);
  assert.equal(parseCoordinateInput('12', '-91').ok, false);
});

test('pixel center maps to requested center and east-left offset wraps RA', () => {
  const center = { ra: 359.999, dec: -12 };
  assert.deepEqual(coordinateAtPixelOffset(center, 0, 0, 0.4), center);

  const east = coordinateAtPixelOffset(center, -100, 0, 0.4);
  assert.ok(east.ra < 0.02 || east.ra > 359.999);
  assert.ok(east.dec < 0);
});

test('tangent-plane offsets remain stable near high declination', () => {
  const highDec = coordinateAtPixelOffset({ ra: 10, dec: 89.95 }, -30, 40, 0.4);
  assert.ok(Number.isFinite(highDec.ra));
  assert.ok(Number.isFinite(highDec.dec));
  assert.ok(highDec.dec >= -90 && highDec.dec <= 90);
});

test('east-west angular offset accounts for high-declination convergence', () => {
  const equatorial = coordinateAtPixelOffset({ ra: 120, dec: 0 }, -1, 0, 1);
  const highDeclination = coordinateAtPixelOffset({ ra: 120, dec: 60 }, -1, 0, 1);
  assert.ok(Math.abs(highDeclination.ra - 120) > Math.abs(equatorial.ra - 120) * 1.9);
});

test('field of view uses requested image scale and pixel dimensions', () => {
  assert.deepEqual(calculateFieldOfView(0.4, 900, 600), {
    widthArcminutes: 6,
    heightArcminutes: 4,
  });
  assert.equal(calculateFieldOfView(0.4, 0, 600), null);
});

test('drag pans from absolute sky center and zoom round trip is stable', () => {
  const center = { ra: 150, dec: 20 };
  const panned = panCenterByDrag(center, 0.4, 120, -60);
  assert.ok(panned.ra > center.ra);
  assert.ok(panned.dec < center.dec);

  const zoomed = zoomScale(0.4, 'in');
  assert.ok(zoomed < 0.4);
  assert.ok(Math.abs(zoomScale(zoomed, 'out') - 0.4) < 1e-12);
});
