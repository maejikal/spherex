import { useEffect, useRef, useState } from 'react';
import type { BlinkAnalysis } from '../../api/types.ts';
import type { ReviewCase } from '../../review/model.ts';
import { reviewBlinkAnalysis } from '../../review/blink.ts';
import { readEvidence } from '../../review/storage.ts';
import { BlinkPlayer } from '../BlinkViewer.tsx';

/** Same player as live analysis, backed only by the images published with this review. */
export function ReviewBlinkViewer({ item, onReturn }: { item: ReviewCase; onReturn: () => void }) {
  const [analysis, setAnalysis] = useState<BlinkAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setAnalysis(null); setError(null);
    void readEvidence(item.id).then((images) => {
      if (!active) return;
      const saved = reviewBlinkAnalysis(item, images, (blob) => {
        const url = URL.createObjectURL(blob); urls.push(url); return url;
      });
      setAnalysis(saved);
    }).catch((failure) => { if (active) setError(failure instanceof Error ? failure.message : 'Could not load saved review images.'); });
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [item, attempt]);
  useEffect(() => { if (analysis) panel.current?.querySelector<HTMLElement>('.blink-stage')?.focus({ preventScroll: true }); }, [analysis]);
  return <div className="blink-review-player" ref={panel}>
    {analysis ? <BlinkPlayer key={`${item.id}:${attempt}`} analysis={analysis} switcher={<div className="review-actions">
      <span className="blink-note">Saved review: {item.title}</span>
      <button className="button button--secondary button--compact" type="button" onClick={onReturn}>Back to review</button>
    </div>} /> : <div className="blink-panel">
      <button className="button button--secondary" type="button" onClick={onReturn}>Back to review</button>
      {error ? <div role="alert"><p>{error}</p><button className="button button--secondary" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry saved images</button></div> : <p role="status">Loading saved observation images…</p>}
    </div>}
  </div>;
}
