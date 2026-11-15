import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateAtPixelOffset,
  calculateFieldOfView,
  formatRightAscension,
  normalizeRightAscension,
  panCenterByDrag,
  parseCoordinateInput,
  parseSexagesimalCoordinateInput,
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

test('coordinate form accepts decimal-hour RA and converts to degrees', () => {
  assert.deepEqual(parseCoordinateInput('12.345', '-31.25', 'hours'), {
    ok: true,
    value: { ra: 185.175, dec: -31.25 },
  });
  assert.equal(parseCoordinateInput('24', '0', 'hours').ok, false);
  assert.equal(parseCoordinateInput('-0.001', '0', 'hours').ok, false);
});

test('sexagesimal coordinate form converts HMS and signed DMS to decimal degrees', () => {
  const positive = parseSexagesimalCoordinateInput({
    raHours: '16', raMinutes: '32', raSeconds: '27.1',
    decSign: '+', decDegrees: '66', decMinutes: '45', decSeconds: '18',
  });
  assert.equal(positive.ok, true);
  assert.ok(positive.value && Math.abs(positive.value.ra - 248.1129166667) < 1e-9);
  assert.equal(positive.value?.dec, 66.755);
  assert.deepEqual(parseSexagesimalCoordinateInput({
    raHours: '0', raMinutes: '0', raSeconds: '0',
    decSign: '-', decDegrees: '0', decMinutes: '30', decSeconds: '0',
  }).value, { ra: 0, dec: -0.5 });
});

test('sexagesimal coordinates validate components and pole boundaries', () => {
  const input = {
    raHours: '23', raMinutes: '59', raSeconds: '59.9',
    decSign: '+', decDegrees: '90', decMinutes: '0', decSeconds: '0',
  };
  assert.equal(parseSexagesimalCoordinateInput(input).ok, true);
  assert.equal(parseSexagesimalCoordinateInput({ ...input, raHours: '24' }).ok, false);
  assert.equal(parseSexagesimalCoordinateInput({ ...input, raMinutes: '60' }).ok, false);
  assert.equal(parseSexagesimalCoordinateInput({ ...input, decDegrees: '90', decSeconds: '1' }).ok, false);
  assert.equal(parseSexagesimalCoordinateInput({ ...input, decSign: '?' }).ok, false);
});

test('right ascension formats in degrees or hours without displaying the upper wrap limit', () => {
  assert.equal(formatRightAscension(187.5, 'hours'), '12.500');
  assert.equal(formatRightAscension(359.9999, 'degrees'), '0.000');
  assert.equal(formatRightAscension(359.9999, 'hours'), '0.000');
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

  const zoomed = zoomScale(2.5, 'in');
  assert.ok(zoomed < 2.5);
  assert.ok(Math.abs(zoomScale(zoomed, 'out') - 2.5) < 1e-12);
  assert.equal(zoomScale(0.2, 'in'), 0.2);
  assert.equal(zoomScale(500, 'out'), 500);
});
