import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConstellationOverview } from '../src/sky/constellationOverview.ts';

const ring = (ra = 0, dec = 0) => [[ra - 1, dec - 1], [ra + 1, dec - 1], [ra + 1, dec + 1], [ra - 1, dec + 1], [ra - 1, dec - 1]].map(([r, d]) => [(r + 360) % 360, d]);
const inside = (point) => {
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  assert.ok(point.x >= 16 - 1e-8 && point.x <= 224 + 1e-8);
  assert.ok(point.y >= 16 - 1e-8 && point.y <= 152 + 1e-8);
};

test('overview fits full wrapped boundary and selected marker without mutating sky coordinates', () => {
  const boundary = [ring()];
  const original = JSON.stringify(boundary);
  const chart = projectConstellationOverview(boundary, { ra: 359.9, dec: 0.2 });
  assert.ok(chart);
  chart.rings.flat().forEach(inside);
  inside(chart.marker);
  assert.equal(JSON.stringify(boundary), original);
  assert.deepEqual(chart.rings[0][0], chart.rings[0].at(-1));
});

test('overview puts celestial east left and north up near its center', () => {
  const boundary = [ring()];
  const center = projectConstellationOverview(boundary, { ra: 0, dec: 0 });
  const east = projectConstellationOverview(boundary, { ra: 0.1, dec: 0 });
  const north = projectConstellationOverview(boundary, { ra: 0, dec: 0.1 });
  assert.ok(east.marker.x < center.marker.x);
  assert.ok(north.marker.y < center.marker.y);
});

test('overview preserves disconnected Serpens-style rings', () => {
  const chart = projectConstellationOverview([ring(240, 8), ring(278, 1)], { ra: 240, dec: 8 });
  assert.equal(chart.rings.length, 2);
  chart.rings.flat().forEach(inside);
});

test('overview supports pole-containing rings, including selection exactly at either pole', () => {
  for (const sign of [-1, 1]) {
    const chart = projectConstellationOverview([[[0, sign * 80], [90, sign * 80], [180, sign * 80], [270, sign * 80], [0, sign * 80]]], { ra: 0, dec: sign * 90 });
    assert.ok(chart);
    chart.rings.flat().forEach(inside);
    inside(chart.marker);
  }
});

test('overview rejects empty, invalid and degenerate geometry rather than drawing fake coordinates', () => {
  for (const boundary of [[], [[]], [[[0, NaN], [1, 0], [1, 1], [0, NaN]]], [[[0, 0], [0, 0], [0, 0], [0, 0]]]]) {
    assert.equal(projectConstellationOverview(boundary, { ra: 0, dec: 0 }), null);
  }
});
