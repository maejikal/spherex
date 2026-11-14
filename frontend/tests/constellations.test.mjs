import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConstellation } from '../src/sky/constellations.ts';

const payload = () => ({
  ra: 0, dec: -5, name: 'Orion', abbreviation: 'Ori', coordinate_system: 'ICRS',
  learn_url: 'https://en.wikipedia.org/wiki/Orion_(constellation)',
  boundary_source: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VI/49',
  boundary: [[[359, 0], [0, 0], [0, 1], [359, 0]]],
});

test('constellation parser preserves ICRS geometry across RA wrap', () => {
  assert.deepEqual(parseConstellation(payload()).boundary, payload().boundary);
});

test('constellation parser rejects invalid geometry, frame and unsafe links', () => {
  for (const patch of [
    { ra: 360 }, { dec: -91 }, { coordinate_system: 'B1875' }, { name: '' },
    { learn_url: 'javascript:alert(1)' }, { learn_url: 'https://evil.test/wiki/Orion' },
    { boundary: [] }, { boundary: [[[0, NaN], [0, 0], [1, 1], [0, NaN]]] },
    { boundary: [[[0, 0], [1, 0], [1, 1], [2, 2]]] },
  ]) assert.throws(() => parseConstellation({ ...payload(), ...patch }));
});
