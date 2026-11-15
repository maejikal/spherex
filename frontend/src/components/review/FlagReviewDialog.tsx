import { useEffect, useRef, useState } from 'react';
import type { BlinkAnalysis } from '../../api/types.ts';
import { createReview, validateDraft } from '../../review/model.ts';
import type { ReviewDraft } from '../../review/model.ts';
import { captureEvidence, saveNewReview } from '../../review/storage.ts';
import { accountName } from '../../review/accounts.ts';
import { ReviewDialog } from './ReviewDialog.tsx';
import { AnalysisMetadata, ReviewImage } from './ReviewImages.tsx';

export function FlagReviewDialog({ analysis, authorId, onClose, onPublished }: { analysis: BlinkAnalysis; authorId: string; onClose: () => void; onPublished: (id: string) => void }) {
  const [author] = useState(authorId); // Capture owner with the draft, independent of later account switching.
  const [draft, setDraft] = useState<ReviewDraft>({ title: '', description: '', marks: {} });
  const [ready, setReady] = useState<Record<string, boolean>>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const dirty = Boolean(draft.title || draft.description || Object.values(draft.marks).some((value) => value !== undefined));
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const close = () => {
    if (saving) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const publish = async () => {
    const problem = validateDraft(analysis, draft);
    if (problem) { setError(problem); return; }
    setSaving(true); setError(null);
    const abort = new AbortController(); controller.current = abort;
    const timeout = window.setTimeout(() => abort.abort(), 60_000);
    try {
      const item = createReview(analysis, draft, crypto.randomUUID(), new Date().toISOString(), author);
      const images = await captureEvidence(item.analysis, item.id, abort.signal);
      await saveNewReview(item, images);
      onPublished(item.id);
    } catch (failure) {
      setError(abort.signal.aborted ? 'Copying images timed out. Your draft is intact; retry.' : failure instanceof Error ? failure.message : 'Save failed. Your draft is intact; retry.');
    } finally { window.clearTimeout(timeout); abort.abort(); controller.current = null; setSaving(false); }
  };
  return <ReviewDialog title="Flag an observation for review" onClose={close}>
    <p>Mark one suspected anomaly independently in each observation. Choose Not visible when it cannot be seen.</p>
    <p className="review-local-note">Saved on this browser only. Posting as {accountName(author)}. No account or external sharing.</p>
    <form onSubmit={(event) => { event.preventDefault(); if (!saving) void publish(); }}>
      <fieldset disabled={saving} className="review-fieldset">
        <div className="review-fields">
          <label>Observation title<input autoFocus className="text-input" required maxLength={160} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label>What looks unusual?<textarea className="text-input" required maxLength={5000} rows={3} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        </div>
        <p>Click and drag on each image to position the fine crosshair. Zoom up to 8× for detail; scroll to inspect. Keyboard: Enter places a mark; arrow keys move 0.1 pixel, Shift moves 1 pixel, Alt moves 0.01 pixel.</p>
        <div className="review-images">{analysis.frames.map((frame) => <ReviewImage key={frame.id} frame={frame} size={analysis.imageSize} src={frame.imageUrl} mark={draft.marks[frame.id]}
          onReady={(value) => setReady((current) => current[frame.id] === value ? current : { ...current, [frame.id]: value })}
          onMark={saving ? undefined : (mark) => setDraft((current) => ({ ...current, marks: { ...current.marks, [frame.id]: mark } }))} />)}</div>
        <AnalysisMetadata analysis={analysis} />
        {error && <p className="review-error" role="alert">{error}</p>}
        <div className="review-actions review-submit">
          <button className="button button--secondary" type="button" onClick={close}>Cancel</button>
          <button className="button button--primary" type="submit" disabled={!analysis.frames.every((frame) => ready[frame.id])}>Request community review</button>
        </div>
      </fieldset>
      {saving && <p role="status">Copying original images and saving evidence… Keep this window open.</p>}
    </form>
    {confirmDiscard && <ReviewDialog title="Discard unsaved observation?" onClose={() => setConfirmDiscard(false)}>
      <p>Your observation description and image marks have not been saved.</p>
      <div className="review-actions">
        <button className="button button--primary" type="button" autoFocus onClick={() => setConfirmDiscard(false)}>Keep editing</button>
        <button className="button button--secondary" type="button" onClick={onClose}>Discard draft</button>
      </div>
    </ReviewDialog>}
  </ReviewDialog>;
}
