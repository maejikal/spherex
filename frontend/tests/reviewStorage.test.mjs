import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEvidence, saveNewReview, listReviews } from '../src/review/storage.ts';
const analysis = { imageSize: 256, frames: [{ id: 'a', imageUrl: '/a.png' }, { id: 'b', imageUrl: '/b.png' }] };
const signal = new AbortController().signal;
const png = () => new Response(new Blob(['test bytes'], { type: 'image/png' }));

test('captures all original frame URLs with image validation before persistence', async () => {
  const urls = []; let verified = 0;
  const images = await captureEvidence(analysis, 'case', signal, async (url) => { urls.push(url); return png(); }, async (_, size) => { assert.equal(size, 256); verified++; });
  assert.deepEqual(urls, ['/a.png', '/b.png']);
  assert.equal(verified, 2);
  assert.equal(images[1].key, 'case:b');
  assert.equal(images[0].blob.type, 'image/png');
});
test('rejects HTML, upstream failure, corrupt images, empty evidence and aborts', async () => {
  for (const fetcher of [async () => new Response('<html>error</html>', { headers: { 'Content-Type': 'text/html' } }), async () => new Response('', { status: 503 }), async () => new Response(new Blob([], {type:'image/png'}))]) {
    await assert.rejects(captureEvidence(analysis, 'case', signal, fetcher));
  }
  await assert.rejects(captureEvidence(analysis, 'case', signal, async () => png(), async () => { throw new Error('decode failed'); }), /decode failed/);
  await assert.rejects(captureEvidence(analysis, 'case', AbortSignal.abort(), async () => png(), async () => {}));
  await assert.rejects(saveNewReview({ id: 'case', analysis }, []), /Every observation/);
});
test('storage unavailable reports actionable failure instead of losing draft', async () => {
  await assert.rejects(listReviews(), /storage is unavailable/);
});
