import type { BlinkAnalysis } from '../api/types.ts';
import type { ReviewCase } from './model.ts';
import type { EvidenceImage } from './storage.ts';

/** Reuse immutable review evidence; never silently rediscover a different archive pair. */
export function reviewBlinkAnalysis(item: ReviewCase, images: EvidenceImage[], makeUrl: (blob: Blob) => string): BlinkAnalysis {
  if (item.analysis.frames.some((frame) => !images.some((image) => image.caseId === item.id && image.frameId === frame.id && image.blob.size > 0))) {
    throw new Error('Saved observation images are missing. Cannot open this review in the blink viewer.');
  }
  const analysis = structuredClone(item.analysis);
  analysis.frames = analysis.frames.map((frame) => ({ ...frame, imageUrl: makeUrl(images.find((image) => image.caseId === item.id && image.frameId === frame.id)!.blob) }));
  return analysis;
}
