import test from 'node:test';
import assert from 'node:assert/strict';
import { draftFromView, editDraft, followView, formatDraftCoordinate, syncDraft } from '../src/state/coordinateDraft.ts';

test('BUG-008: fields follow the viewer while untouched, without floating-point noise', () => {
  let draft = draftFromView(null);
  assert.deepEqual(draft, { ra: '', dec: '', edited: false });
  draft = followView(draft, { ra: 211.03582048304906, dec: 54.348950000000002 });
  assert.deepEqual(draft, { ra: '211.03582', dec: '54.34895', edited: false });
  assert.equal(formatDraftCoordinate(0.1 + 0.2), '0.3');
  assert.equal(formatDraftCoordinate(-0.0000001), '0');
  assert.equal(draftFromView({ ra: 359.9999999, dec: 0 }).ra, '0', 'RA wraps instead of showing 360');
});

test('BUG-008: an in-progress edit survives pans and zooms', () => {
  let draft = draftFromView({ ra: 210.80227, dec: 54.34895 });
  draft = editDraft(draft, 'ra', '83.8');
  // Pan, then zoom (centre unchanged), then another pan.
  for (const view of [{ ra: 211.0358, dec: 54.4 }, { ra: 211.0358, dec: 54.4 }, { ra: 212.5, dec: 55.1 }]) draft = followView(draft, view);
  assert.deepEqual(draft, { ra: '83.8', dec: '54.34895', edited: true });
  draft = editDraft(draft, 'dec', '-5.39');
  draft = followView(draft, { ra: 1, dec: 2 });
  assert.deepEqual(draft, { ra: '83.8', dec: '-5.39', edited: true });
  // Partly typed values (not yet numbers) are kept verbatim as well.
  assert.equal(followView(editDraft(draft, 'ra', '-'), { ra: 3, dec: 4 }).ra, '-');
});

test('BUG-008: explicit navigation or reset hands the fields back to the viewer', () => {
  let draft = editDraft(draftFromView({ ra: 10, dec: 20 }), 'ra', '83.8');
  draft = syncDraft({ ra: 83.8, dec: -5.39 });
  assert.deepEqual(draft, { ra: '83.8', dec: '-5.39', edited: false });
  draft = followView(draft, { ra: 84.25, dec: -5.5 });
  assert.deepEqual(draft, { ra: '84.25', dec: '-5.5', edited: false });
  assert.deepEqual(syncDraft(null), { ra: '', dec: '', edited: false });
});
