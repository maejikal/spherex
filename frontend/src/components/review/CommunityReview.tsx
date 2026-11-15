import { useCallback, useEffect, useState } from 'react';
import { Flag } from 'lucide-react';
import type { BlinkAnalysis } from '../../api/types.ts';
import { advance, DECISIONS, reviewSummary, STATUS_LABELS, vote } from '../../review/model.ts';
import type { Decision, ReviewCase, ReviewStatus } from '../../review/model.ts';
import { navigateReview, readReviewRoute } from '../../review/route.ts';
import { listReviews, readEvidence, readReview, updateReview } from '../../review/storage.ts';
import { accountName, isDemoAccount, readDemoAccount, saveDemoAccount } from '../../review/accounts.ts';
import { DemoAccountSwitcher } from './DemoAccountSwitcher.tsx';
import { FlagReviewDialog } from './FlagReviewDialog.tsx';
import { ReviewDialog } from './ReviewDialog.tsx';
import { ReviewBlinkPopup } from './ReviewBlinkPopup.tsx';
import { AnalysisMetadata, ReviewImage } from './ReviewImages.tsx';
import './review.css';

const message = (error: unknown) => error instanceof Error ? error.message : 'Browser storage failed. Retry.';

export function CommunityReview({ analysis, onDraftClosed }: { analysis: BlinkAnalysis | null; onDraftClosed: () => void }) {
  const [route, setRoute] = useState(() => readReviewRoute(window.location.search));
  const [blinkItem, setBlinkItem] = useState<ReviewCase | null>(null);
  const [identity, setIdentity] = useState(readDemoAccount);
  const [accountWarning, setAccountWarning] = useState(false);
  const switchAccount = (id: string) => {
    if (!isDemoAccount(id)) return;
    setIdentity(id);
    setAccountWarning(!saveDemoAccount(id));
  };
  useEffect(() => {
    const update = () => { setBlinkItem(null); setRoute(readReviewRoute(window.location.search)); };
    window.addEventListener('popstate', update);
    window.addEventListener('reviewnavigate', update);
    return () => { window.removeEventListener('popstate', update); window.removeEventListener('reviewnavigate', update); };
  }, []);
  return <>
    <div className="community-tools" role="group" aria-label="Demo account and community review">
    <DemoAccountSwitcher identity={identity} onChange={switchAccount} compact />
    {accountWarning && <span className="demo-account-warning" role="status">Account selected for this visit only; browser storage is unavailable.</span>}
    <button className="button button--secondary community-review-entry" type="button" onClick={() => navigateReview('queue')}><Flag size={15} aria-hidden="true" /><span>Community review</span></button>
    </div>
    {analysis ? <FlagReviewDialog analysis={analysis} authorId={identity} onClose={onDraftClosed} onPublished={(id) => { onDraftClosed(); navigateReview(id); }} /> : route &&
      <ReviewDialog title={route === 'queue' ? 'Community review' : 'Review observation'} onClose={() => navigateReview(null)}>
        <div className="review-session">
          <p className="review-muted">Local demo · Cases and votes stay in this browser. Clearing browser data removes them.</p>
          <DemoAccountSwitcher identity={identity} onChange={switchAccount} compact />
        </div>
        <details className="review-disclosure review-demo-help"><summary>About this demo</summary>
          <p>Accounts are fictional; no sign-in or identity verification. Switch accounts to review another account’s observation. Cases and evidence are not shared across devices.</p>
        </details>
        {accountWarning && <p role="status">Account selected for this visit only; browser storage is unavailable.</p>}
        {route === 'queue' ? <ReviewQueue onOpenBlink={setBlinkItem} /> : <ReviewDetail key={route} id={route} identity={identity} onOpenBlink={setBlinkItem} />}
        {blinkItem && <ReviewBlinkPopup key={`blink-${blinkItem.id}`} item={blinkItem} onClose={() => setBlinkItem(null)} />}
      </ReviewDialog>}
  </>;
}
function ReviewQueue({ onOpenBlink }: { onOpenBlink: (item: ReviewCase) => void }) {
  const [cases, setCases] = useState<ReviewCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(null);
    void listReviews().then((items) => { if (active) setCases(items); }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; };
  }, [attempt]);
  return <section aria-label="Local community review queue">
    <p className="review-muted">Choose an observation to compare its images and contribute a review.</p>
    {error ? <div role="alert"><p>{error}</p><button className="button button--secondary" onClick={() => setAttempt((n) => n + 1)}>Retry loading reviews</button></div> : !cases ? <p role="status">Loading saved reviews…</p> : cases.length === 0 ?
      <div className="review-empty"><h3>No observations flagged yet</h3><p>Load a blink analysis, choose Flag for review, and mark the unusual feature to create your first case.</p></div> :
      <ul className="review-queue">{cases.map((item) => <ReviewQueueEntry key={item.id} item={item} onOpenBlink={onOpenBlink} />)}</ul>}

  </section>;
}
function ReviewQueueEntry({ item, onOpenBlink }: { item: ReviewCase; onOpenBlink: (item: ReviewCase) => void }) {
  const summary = reviewSummary(item);
  return <li>
    <button className="review-queue__entry" type="button" onClick={() => navigateReview(item.id)}>
      <span className="review-eyebrow">{STATUS_LABELS[item.status]}</span><strong>{item.title}</strong>
      <span>{accountName(item.authorId)} · {summary.total} {summary.total === 1 ? 'review' : 'reviews'}</span>
    </button>
    <button className="button button--secondary review-queue__blink" type="button" aria-label={`Open ${item.title} in blink viewer`} onClick={() => onOpenBlink(item)}>Open in blink viewer</button>
  </li>;
}
function ReviewDetail({ id, identity, onOpenBlink }: { id: string; identity: string; onOpenBlink: (item: ReviewCase) => void }) {
  const [item, setItem] = useState<ReviewCase | null | undefined>(undefined);
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const urls: string[] = [];
    setError(null);
    void Promise.all([readReview(id), readEvidence(id)]).then(([saved, evidence]) => {
      if (!active) return;
      const sources: Record<string, string> = {};
      for (const image of evidence) { const url = URL.createObjectURL(image.blob); urls.push(url); sources[image.frameId] = url; }
      setImages(sources); setItem(saved ?? null);
    }).catch((failure) => { if (active) setError(message(failure)); });
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [id, attempt]);
  const persist = useCallback(async (next: ReviewCase) => {
    setSaving(true); setError(null);
    try { await updateReview(next); setItem(next); }
    catch (failure) { setError(message(failure)); }
    finally { setSaving(false); }
  }, []);
  const transition = (status: ReviewStatus) => {
    if (!item || saving) return;
    try { void persist(advance(item, identity, status, new Date().toISOString())); }
    catch (failure) { setError(message(failure)); }
  };
  return <section aria-label="Observation review details">
    <button className="button button--quiet" type="button" onClick={() => navigateReview('queue')}>Back to review queue</button>
    {error && <div role="alert" className="review-error"><p>{error}</p><button className="button button--secondary" disabled={saving} onClick={() => setAttempt((n) => n + 1)}>Reload saved case</button></div>}
    {item === undefined ? !error && <p role="status">Loading observation and saved images…</p> : item === null ?
      <div className="review-empty"><h3>Observation unavailable on this browser</h3><p>This link identifies a locally saved case, not a shared online observation. Open it in the browser where it was created. Browser data may also have been cleared.</p></div> : <>
        <div className="review-actions"><button className="button button--secondary" type="button" onClick={() => onOpenBlink(item)}>Open in blink viewer</button></div>
        <div className="review-case-heading"><span className="review-eyebrow">{STATUS_LABELS[item.status]}</span><h3>{item.title}</h3></div>
        <p className="review-description">{item.description}</p>
        <p className="review-muted">Flagged by {accountName(item.authorId)} · Saved {new Date(item.createdAt).toLocaleString()} (application time)</p>
        <div className="review-images">{item.analysis.frames.map((frame) => <ReviewImage key={`${id}:${frame.id}:${attempt}`} frame={frame} size={item.analysis.imageSize} src={images[frame.id]} mark={item.marks[frame.id]} />)}</div>
        <ReviewResults item={item} />
        {item.status === 'open' ? identity === item.authorId ? <p className="review-local-note">Authors cannot review their own observation. Switch to another demo account to contribute.</p> :
          <VoteForm key={`${identity}:${attempt}`} item={item} identity={identity} saving={saving} onSave={persist} /> : <p>Voting closed. Community approval indicates interest in further investigation, not a confirmed discovery.</p>}
        <AnalysisMetadata analysis={item.analysis} />
        <details className="review-disclosure review-handoff">
          <summary>Simulated handoff and history</summary>
          <p className="review-warning"><strong>Simulation — nothing is sent externally.</strong> No actual MPC validation, observatory receipt, or scientific confirmation occurs.</p>
          {identity === item.authorId ? <div className="review-actions">
            {item.status === 'open' && <button className="button button--primary" disabled={saving || !reviewSummary(item).eligible} onClick={() => transition('peer-approved')}>Close review and advance</button>}
            {item.status === 'peer-approved' && <button className="button button--primary" disabled={saving} onClick={() => transition('mpc-submitted-simulation')}>Simulate MPC submission</button>}
            {item.status === 'mpc-submitted-simulation' && <button className="button button--primary" disabled={saving} onClick={() => transition('mpc-accepted-simulation')}>Simulate MPC acceptance</button>}
            {item.status === 'mpc-accepted-simulation' && <button className="button button--primary" disabled={saving} onClick={() => transition('observatory-referred-simulation')}>Simulate observatory referral</button>}
          </div> : <p>Only the observation author can close review or advance simulated handoff.</p>}
          {saving && <p role="status">Saving changes…</p>}
          <ol className="review-timeline">{item.events.map((event) => <li key={event.status}><strong>{STATUS_LABELS[event.status]}</strong><time dateTime={event.at}>{new Date(event.at).toLocaleString()} · application time</time></li>)}</ol>
        </details>
      </>}
  </section>;
}
function ReviewResults({ item }: { item: ReviewCase }) {
  const summary = reviewSummary(item);
  return <section className="review-results" aria-label="Community decisions">
    <p role="status"><strong>{summary.total ? `${summary.total} ${summary.total === 1 ? 'review' : 'reviews'} · ${Math.round(summary.fraction * 100)}% support further investigation` : 'No reviews yet'}</strong></p>
    <details className="review-disclosure"><summary>Review breakdown and comments</summary>
    <p>{summary.support} supportive · {item.votes.filter((v) => v.decision === 'artefact').length} likely artefact · {item.votes.filter((v) => v.decision === 'uncertain').length} uncertain</p>
    <p>At least five distinct reviewers and 80% support required. Uncertain decisions count toward the total, not support. Author closes voting when eligible.</p>
    <ul className="review-votes">{item.votes.map((entry) => <li key={entry.reviewerId}>
      <strong>{accountName(entry.reviewerId)} · {DECISIONS[entry.decision]}</strong>
      <p className="review-description">{entry.comment || 'No comment added.'}</p>
    </li>)}</ul>
    </details>
  </section>;
}
function VoteForm({ item, identity, saving, onSave }: { item: ReviewCase; identity: string; saving: boolean; onSave: (next: ReviewCase) => Promise<void> }) {
  const existing = item.votes.find((entry) => entry.reviewerId === identity);
  const [decision, setDecision] = useState<Decision | ''>(existing?.decision ?? '');
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [error, setError] = useState<string | null>(null);
  return <form className="review-vote-form" onSubmit={(event) => {
    event.preventDefault();
    if (!decision || saving) return;
    try { void onSave(vote(item, identity, decision, comment, new Date().toISOString())); }
    catch (failure) { setError(message(failure)); }
  }}>
    <fieldset disabled={saving} className="review-fieldset">
      <legend>Your peer review</legend>
      <div className="review-decisions">{(Object.entries(DECISIONS) as [Decision, string][]).map(([value, label]) => <label key={value}><input type="radio" name="review-decision" required checked={decision === value} onChange={() => setDecision(value)} />{label}</label>)}</div>
      <details className="review-disclosure" open={existing?.comment ? true : undefined}><summary>Add a comment (optional)</summary>
        <label>Review comment<textarea className="text-input" maxLength={3000} rows={3} value={comment} onChange={(event) => setComment(event.target.value)} /></label>
      </details>
      {error && <p role="alert">{error}</p>}
      <button className="button button--primary" type="submit" disabled={!decision}>{existing ? 'Update review' : 'Submit review'}</button>
    </fieldset>
  </form>;
}
