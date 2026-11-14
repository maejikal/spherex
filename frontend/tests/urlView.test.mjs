import test from 'node:test';
import assert from 'node:assert/strict';
import { parseViewSearch, serializeViewSearch } from '../src/state/urlView.ts';

test('shareable view encodes coordinates, scale, survey, and grid', () => {
  const search = serializeViewSearch({
    ra: 359.75,
    dec: -2.5,
    scale: 0.2,
    survey: 'sdss-dr18',
    grid: true,
  });

  assert.deepEqual(parseViewSearch(search), {
    ra: 359.75,
    dec: -2.5,
    scale: 0.2,
    survey: 'sdss-dr18',
    grid: true,
  });
});

test('invalid or incomplete URL view state does not create a position', () => {
  assert.equal(parseViewSearch('?ra=15&dec=91&scale=0.4'), null);
  assert.equal(parseViewSearch('?ra=15&scale=0.4'), null);
  assert.equal(parseViewSearch('?ra=15&dec=1&scale=-2'), null);
  assert.equal(parseViewSearch('?ra=&dec=1&scale=0.4'), null);
  assert.equal(parseViewSearch('?ra=-1&dec=1&scale=0.4'), null);
  assert.equal(parseViewSearch('?ra=361&dec=1&scale=0.4'), null);
});

test('URL state wraps an exact 360-degree right ascension to zero', () => {
  assert.equal(parseViewSearch('?ra=360&dec=-1&scale=0.4')?.ra, 0);
});
