import type { BlinkAnalysis } from '../api/types.ts';

import { DEMO_ACCOUNTS, isDemoAccount } from './accounts.ts';

/** Compatibility export for existing callers. Accounts have no fixed author/reviewer role. */
export const DEMO_PEOPLE = DEMO_ACCOUNTS;
export type Decision = 'investigate' | 'artefact' | 'uncertain';
export const DECISIONS: Record<Decision, string> = {
  investigate: 'Warrants further investigation', artefact: 'Likely imaging artefact', uncertain: 'Uncertain',
};
export type ReviewStatus = 'open' | 'peer-approved' | 'mpc-submitted-simulation' | 'mpc-accepted-simulation' | 'observatory-referred-simulation';
export const STATUS_LABELS: Record<ReviewStatus, string> = {
  open: 'Observation Needs Review', 'peer-approved': 'Community review passed',
  'mpc-submitted-simulation': 'MPC submission simulated', 'mpc-accepted-simulation': 'MPC acceptance simulated',
  'observatory-referred-simulation': 'Observatory referral simulated',
};
/** Fractional original-image pixel centers; integers retain compatibility with earlier saved cases. */
export interface Mark { x: number; y: number }
/** Undefined is unaccounted for, null explicitly means Not visible. Pixels: top-left origin, zero-based. */
export interface ReviewDraft { title: string; description: string; marks: Record<string, Mark | null | undefined> }
export interface ReviewVote { reviewerId: string; decision: Decision; comment: string; updatedAt: string }
export interface ReviewCase extends ReviewDraft {
  id: string;
  revision: number;
  authorId: string;
  createdAt: string;
  analysis: BlinkAnalysis;
  votes: ReviewVote[];
  status: ReviewStatus;
  events: { status: ReviewStatus; at: string }[];
}

const roundPixel = (value: number, size: number) => Math.round(Math.max(0, Math.min(size - 1, value)) * 100) / 100;

/** Rect is the full rendered image, including its zoom, never the scroller or cropped blink viewport.
 * Integer coordinates are pixel centers. Clamp only during captured drags beyond the image edge. */
export function pointFromClient(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, size: number, clampToImage = false): Mark | null {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (![x, y, size].every(Number.isFinite) || size <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  if (!clampToImage && (x < 0 || x > 1 || y < 0 || y > 1)) return null;
  return { x: roundPixel(x * size - 0.5, size), y: roundPixel(y * size - 0.5, size) };
}
export function moveMark(mark: Mark | null | undefined, key: string, size: number, step = 0.1): Mark {
  const start = mark ?? { x: (size - 1) / 2, y: (size - 1) / 2 };
  return {
    x: roundPixel(start.x + (key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0), size),
    y: roundPixel(start.y + (key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0), size),
  };
}
export function validateDraft(analysis: BlinkAnalysis, draft: ReviewDraft): string | null {
  if (!draft.title.trim() || draft.title.length > 160) return 'Enter an observation title (up to 160 characters).';
  if (!draft.description.trim() || draft.description.length > 5000) return 'Describe the unusual feature (up to 5,000 characters).';
  if (!analysis.frames.length || !Number.isInteger(analysis.imageSize) || analysis.imageSize <= 0) return 'Observation images are unavailable.';
  let marked = false;
  for (const frame of analysis.frames) {
    const mark = draft.marks[frame.id];
    if (mark === undefined) return 'Mark the anomaly or choose Not visible for every image.';
    if (mark !== null) {
      if (![mark.x, mark.y].every((n) => Number.isFinite(n) && n >= 0 && n <= analysis.imageSize - 1)) return 'A crosshair is outside its image.';
      marked = true;
    }
  }
  return marked ? null : 'Place a crosshair in at least one image.';
}
export function createReview(analysis: BlinkAnalysis, draft: ReviewDraft, id: string, at: string, authorId = 'author'): ReviewCase {
  if (!isDemoAccount(authorId)) throw new Error('Choose a valid demo account.');
  const error = validateDraft(analysis, draft);
  if (error) throw new Error(error);
  return structuredClone({ ...draft, title: draft.title.trim(), description: draft.description.trim(), analysis,
    id, revision: 0, authorId, createdAt: at, votes: [], status: 'open', events: [{ status: 'open', at }] });
}
export function reviewSummary(item: ReviewCase) {
  const total = item.votes.length;
  const support = item.votes.filter((v) => v.decision === 'investigate').length;
  return { total, support, fraction: total ? support / total : 0, eligible: total >= 5 && support * 5 >= total * 4 };
}
export function vote(item: ReviewCase, reviewerId: string, decision: Decision, comment: string, at: string): ReviewCase {
  if (item.status !== 'open') throw new Error('Voting is closed.');
  if (reviewerId === item.authorId || !DEMO_PEOPLE.some((p) => p.id === reviewerId)) throw new Error('Choose a different demo account; authors cannot review their own observations.');
  if (!Object.hasOwn(DECISIONS, decision) || comment.length > 3000) throw new Error('Invalid review decision or comment.');
  return { ...item, revision: item.revision + 1, votes: [...item.votes.filter((v) => v.reviewerId !== reviewerId), { reviewerId, decision, comment: comment.trim(), updatedAt: at }] };
}
const NEXT: Partial<Record<ReviewStatus, ReviewStatus>> = {
  open: 'peer-approved', 'peer-approved': 'mpc-submitted-simulation', 'mpc-submitted-simulation': 'mpc-accepted-simulation',
  'mpc-accepted-simulation': 'observatory-referred-simulation',
};
export function advance(item: ReviewCase, actor: string, status: ReviewStatus, at: string): ReviewCase {
  if (actor !== item.authorId) throw new Error('Only the observation author can advance this case.');
  if (NEXT[item.status] !== status) throw new Error('Complete the previous stage first.');
  if (item.status === 'open' && !reviewSummary(item).eligible) throw new Error('At least five reviews and 80% support are required.');
  return { ...item, revision: item.revision + 1, status, events: [...item.events, { status, at }] };
}
