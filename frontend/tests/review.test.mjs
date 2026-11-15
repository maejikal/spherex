import test from 'node:test';
import assert from 'node:assert/strict';
import { pointFromClient, moveMark, validateDraft, reviewSummary, vote, advance, createReview, DEMO_PEOPLE } from '../src/review/model.ts';
import { reviewSearch, readReviewRoute } from '../src/review/route.ts';

const analysis = { ra: 12, dec: -8, imageSize: 256, frames: [{ id: 'a', imageUrl: '/a.png' }, { id: 'b', imageUrl: '/b.png' }], warnings: ['Coverage warning'] };
const draft = () => ({ title: 'Moving feature', description: 'Compare these positions.', marks: { a: { x: 10, y: 20 }, b: null } });
const fresh = () => createReview(analysis, draft(), 'case-1', '2026-11-15T00:00:00Z');

test('maps full original image despite resize; rejects letterbox/outside and clamps edges', () => {
  const rect = { left: 100, top: 50, width: 512, height: 512 };
  assert.deepEqual(pointFromClient(356, 306, rect, 256), { x: 127.5, y: 127.5 });
  assert.deepEqual(pointFromClient(612, 562, rect, 256), { x: 255, y: 255 });
  assert.equal(pointFromClient(99, 70, rect, 256), null);
  assert.equal(pointFromClient(200, 20, rect, 256), null);
  assert.deepEqual(pointFromClient(164, 114, { left: 100, top: 50, width: 128, height: 128 }, 256), { x: 127.5, y: 127.5 });
  assert.deepEqual(moveMark({ x: 255, y: 0 }, 'ArrowRight', 256), { x: 255, y: 0 });
});

test('requires title, description, every frame accounted for and one valid crosshair', () => {
  assert.equal(validateDraft(analysis, draft()), null);
  for (const change of [{ title: ' ' }, { description: '' }, { marks: { a: null, b: null } }, { marks: { a: { x: 2, y: 3 } } }, { marks: { a: { x: NaN, y: 3 }, b: null } }, { marks: { a: { x: 256, y: 3 }, b: null } }]) {
    assert.ok(validateDraft(analysis, { ...draft(), ...change }));
  }
  const saved = fresh();
  analysis.warnings.push('Later warning');
  assert.equal(saved.analysis.warnings.length, 1);
  assert.deepEqual(saved.marks, draft().marks);
});

test('five distinct non-author reviewers; editable votes and uncertain votes count', () => {
  let item = fresh();
  assert.throws(() => vote(item, 'author', 'investigate', '', 'now'));
  assert.throws(() => vote(item, 'unknown', 'investigate', '', 'now'));
  item = vote(item, 'reviewer-1', 'investigate', 'Looks unusual', 'now');
  item = vote(item, 'reviewer-1', 'uncertain', 'Need more data', 'later');
  assert.equal(item.votes.length, 1);
  assert.deepEqual(reviewSummary(item), { total: 1, support: 0, fraction: 0, eligible: false });
  for (const person of DEMO_PEOPLE.slice(2)) item = vote(item, person.id, 'investigate', '', 'now');
  assert.equal(reviewSummary(item).eligible, true);
  assert.equal(reviewSummary(item).fraction, 0.8);
  item = vote(item, 'reviewer-2', 'artefact', '', 'now');
  assert.equal(reviewSummary(item).eligible, false);
});

test('threshold uses exact ratio, requires five votes, author closure and ordered simulation', () => {
  let item = fresh();
  for (const person of DEMO_PEOPLE.slice(1, 5)) item = vote(item, person.id, 'investigate', '', 'now');
  assert.equal(reviewSummary(item).eligible, false);
  assert.throws(() => advance(item, 'author', 'peer-approved', 'now'));
  item = vote(item, 'reviewer-5', 'artefact', '', 'now');
  assert.throws(() => advance(item, 'reviewer-1', 'peer-approved', 'now'));
  assert.throws(() => advance(item, 'author', 'mpc-accepted-simulation', 'now'));
  for (const status of ['peer-approved', 'mpc-submitted-simulation', 'mpc-accepted-simulation', 'observatory-referred-simulation']) item = advance(item, 'author', status, '2026-11-15T01:00:00Z');
  assert.equal(item.events.length, 5);
  assert.throws(() => vote(item, 'reviewer-5', 'investigate', '', 'now'));
  assert.throws(() => advance(item, 'author', 'peer-approved', 'now'));
  const borderline = { ...fresh(), votes: Array.from({length: 1001}, (_, i) => ({ reviewerId: String(i), decision: i < 800 ? 'investigate' : 'uncertain' })) };
  assert.equal(reviewSummary(borderline).eligible, false);
});

test('review URLs preserve sky parameters, hash handled by caller, and local queue route', () => {
  const sky = '?ra=12&dec=-8&scale=6&grid=1&channel=5';
  const search = reviewSearch(sky, 'case-1');
  assert.equal(readReviewRoute(search), 'case-1');
  assert.equal(reviewSearch(search, null), sky);
  assert.equal(readReviewRoute(reviewSearch(sky, 'queue')), 'queue');
  assert.equal(readReviewRoute('?review='), null);
});


test('fractional annotations survive zoom, validation and save without rounding to whole pixels', () => {
  const rect = { left: 0, top: 0, width: 2048, height: 2048 };
  assert.deepEqual(pointFromClient(803, 1002, rect, 256), { x: 99.88, y: 124.75 });
  assert.deepEqual(pointFromClient(-20, 3000, rect, 256, true), { x: 0, y: 255 });
  assert.deepEqual(moveMark({ x: 100.12, y: 40.3 }, 'ArrowRight', 256), { x: 100.22, y: 40.3 });
  assert.deepEqual(moveMark({ x: 100.12, y: 40.3 }, 'ArrowDown', 256, 0.01), { x: 100.12, y: 40.31 });
  assert.deepEqual(moveMark({ x: 100.12, y: 40.3 }, 'ArrowLeft', 256, 1), { x: 99.12, y: 40.3 });
  const fine = { ...draft(), marks: { a: { x: 100.12, y: 40.31 }, b: null } };
  assert.equal(validateDraft(analysis, fine), null);
  assert.deepEqual(createReview(analysis, fine, 'fine', 'now').marks.a, fine.marks.a);
  assert.ok(validateDraft(analysis, { ...fine, marks: { a: { x: 255.1, y: 2 }, b: null } }));
  assert.equal(pointFromClient(0, 0, { left:0, top:0, width:0, height:20 }, 256), null);
});
