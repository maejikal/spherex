import { lazy, Suspense } from 'react';
import type { ReviewCase } from '../../review/model.ts';
import { ReviewDialog } from './ReviewDialog.tsx';

const ReviewBlinkViewer = lazy(() => import('./ReviewBlinkViewer.tsx').then((module) => ({ default: module.ReviewBlinkViewer })));

/** Nested modal keeps the review, pending decision and sky navigation mounted and untouched. */
export function ReviewBlinkPopup({ item, onClose }: { item: ReviewCase; onClose: () => void }) {
  return <ReviewDialog title="Blink viewer" className="review-dialog--blink" closeLabel="Close blink viewer" onClose={onClose}>
    <h3 className="review-blink-title">{item.title}</h3>
    <p className="review-muted">Saved observations · RA {item.analysis.ra}°, Dec {item.analysis.dec}° (ICRS)</p>
    <Suspense fallback={<p role="status">Opening blink viewer…</p>}>
      <ReviewBlinkViewer item={item} onReturn={onClose} />
    </Suspense>
  </ReviewDialog>;
}
