import test from 'node:test';
import assert from 'node:assert/strict';
import { parseViewSearch, serializeViewSearch } from '../src/state/urlView.ts';

test('shareable view encodes coordinates, scale, survey, grid and channel', () => {
  const search = serializeViewSearch({ ra: 359.75, dec: -2.5, scale: 2.5, survey: 'spherex', grid: true, channel: 12 });
  assert.match(search, /survey=spherex/);
  assert.match(search, /channel=12/);
  assert.deepEqual(parseViewSearch(search), { ra: 359.75, dec: -2.5, scale: 2.5, survey: 'spherex', grid: true, channel: 12 });
});

test('channel is optional: no parameter means the service default frame', () => {
  const search = serializeViewSearch({ ra: 10, dec: 5, scale: 3, survey: 'spherex', grid: false, channel: null }, '?channel=7&x=1');
  assert.doesNotMatch(search, /channel=/);
  assert.match(search, /x=1/);
  assert.equal(parseViewSearch(search)?.channel, null);
  assert.equal(parseViewSearch('?ra=10&dec=5&scale=3&channel=abc')?.channel, null);
  assert.equal(parseViewSearch('?ra=10&dec=5&scale=3&channel=-3')?.channel, null);
  assert.equal(parseViewSearch('?ra=10&dec=5&scale=3&channel=1.5')?.channel, null);
  assert.equal(parseViewSearch('?ra=10&dec=5&scale=3&channel=0')?.channel, 0);
});

test('invalid or incomplete URL view state does not create a position', () => {
  assert.equal(parseViewSearch('?ra=15&dec=91&scale=2'), null);
  assert.equal(parseViewSearch('?ra=15&scale=2'), null);
  assert.equal(parseViewSearch('?ra=15&dec=1&scale=-2'), null);
  assert.equal(parseViewSearch('?ra=&dec=1&scale=2'), null);
  assert.equal(parseViewSearch('?ra=-1&dec=1&scale=2'), null);
  assert.equal(parseViewSearch('?ra=361&dec=1&scale=2'), null);
  assert.equal(parseViewSearch('?ra=10&dec=1&scale=2&survey=dss'), null);
  assert.equal(parseViewSearch('?ra=10&dec=1&scale=100000'), null);
});

test('URL state wraps an exact 360-degree right ascension to zero', () => {
  assert.equal(parseViewSearch('?ra=360&dec=-1&scale=2')?.ra, 0);
});

test('old SDSS-prototype links still open: survey is remapped, scale stays arcsec/pixel (never degrees)', () => {
  const view = parseViewSearch('?ra=180&dec=0.5&scale=0.4&survey=sdss-dr18&grid=1');
  assert.equal(view?.survey, 'spherex');
  assert.equal(view?.scale, 0.4);
  assert.equal(view?.grid, true);
  // Below the SPHEREx zoom limit the scale is clamped, not reinterpreted.
  assert.equal(parseViewSearch('?ra=1&dec=1&scale=0.05')?.scale, 0.2);
});
