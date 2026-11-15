import type { BlinkAnalysis } from '../api/types.ts';
import type { ReviewCase } from './model.ts';

const DATABASE = 'spherex-community-review';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export interface EvidenceImage { key: string; caseId: string; frameId: string; blob: Blob }

/** Native IndexedDB only. Metadata and evidence commit atomically; no remote submissions. */
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('Browser storage is unavailable. Enable IndexedDB to save a review.')); return; }
    let blocked = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('cases', { keyPath: 'id' });
      request.result.createObjectStore('images', { keyPath: 'key' }).createIndex('caseId', 'caseId');
    };
    request.onerror = () => reject(new Error('Could not open browser storage. Check browser privacy settings.'));
    request.onblocked = () => { blocked = true; reject(new Error('Storage upgrade is blocked. Close other Sky Explorer tabs and retry.')); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
async function transaction<T>(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new Error('Browser storage failed. Storage may be full or disabled; no changes were saved.'));
      tx.onabort = () => reject(new Error('Save cancelled or case changed in another tab. Reload the case and retry.'));
      try { run(tx, (value) => { result = value; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}
export function listReviews(): Promise<ReviewCase[]> {
  return transaction(['cases'], 'readonly', (tx, result) => {
    const request = tx.objectStore('cases').getAll();
    request.onsuccess = () => result((request.result as ReviewCase[]).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  });
}
export function readReview(id: string): Promise<ReviewCase | undefined> {
  return transaction(['cases'], 'readonly', (tx, result) => {
    const request = tx.objectStore('cases').get(id);
    request.onsuccess = () => result(request.result as ReviewCase | undefined);
  });
}
export function readEvidence(id: string): Promise<EvidenceImage[]> {
  return transaction(['images'], 'readonly', (tx, result) => {
    const request = tx.objectStore('images').index('caseId').getAll(id);
    request.onsuccess = () => result(request.result as EvidenceImage[]);
  });
}
export function saveNewReview(item: ReviewCase, images: EvidenceImage[]): Promise<void> {
  if (images.length !== item.analysis.frames.length || item.analysis.frames.some((f) => !images.some((i) => i.caseId === item.id && i.frameId === f.id && i.key === `${item.id}:${f.id}` && i.blob.size > 0))) {
    return Promise.reject(new Error('Every observation image must be saved. Retry without closing your draft.'));
  }
  return transaction(['cases', 'images'], 'readwrite', (tx) => {
    tx.objectStore('cases').add(item);
    for (const image of images) tx.objectStore('images').add(image);
  });
}
/** Compare-and-swap revision avoids silently overwriting a vote from another tab. */
export function updateReview(item: ReviewCase): Promise<void> {
  return transaction(['cases'], 'readwrite', (tx) => {
    const store = tx.objectStore('cases');
    const request = store.get(item.id);
    request.onsuccess = () => {
      const current = request.result as ReviewCase | undefined;
      if (!current || current.revision + 1 !== item.revision) tx.abort();
      else store.put(item);
    };
  });
}

async function verifyImage(blob: Blob, size: number) {
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width !== size || bitmap.height !== size) throw new Error('Observation image dimensions changed. Reopen the blink analysis before flagging.');
  } finally { bitmap.close(); }
}
/** Fetch complete originals, not screenshots of a zoomed/cropped viewer. Validate before any database write. */
export async function captureEvidence(
  analysis: BlinkAnalysis, caseId: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch, verify: (blob: Blob, size: number) => Promise<void> = verifyImage,
): Promise<EvidenceImage[]> {
  return Promise.all(analysis.frames.map(async (frame) => {
    const response = await fetcher(frame.imageUrl, { signal });
    if (!response.ok) throw new Error(`Could not copy observation ${frame.label ?? frame.id}. Retry without closing your draft.`);
    const blob = await response.blob();
    if (!/^image\/(png|jpeg|webp)$/i.test(blob.type) || !blob.size || blob.size > MAX_IMAGE_BYTES) throw new Error('Observation evidence is not a supported image or exceeds 20 MB. Nothing was published.');
    await verify(blob, analysis.imageSize);
    signal.throwIfAborted();
    return { key: `${caseId}:${frame.id}`, caseId, frameId: frame.id, blob };
  }));
}
