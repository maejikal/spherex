/**
 * Only the newest navigation request may move the view.
 *
 * Name lookups and "Random" are asynchronous. Without a guard, a slow lookup that finishes after a newer
 * search, a typed coordinate, a verified destination, Reset or browser Back would yank the view back to
 * the stale result. Every navigation (asynchronous or not) supersedes the previous one: the pending
 * request is aborted where fetch supports it, and its ticket stops being current, so a response that
 * arrives anyway is ignored.
 */
export interface NavigationTicket {
  readonly signal: AbortSignal;
  /** True until any later navigation starts. */
  isCurrent(): boolean;
}

export class NavigationGuard {
  private generation = 0;
  private controller: AbortController | null = null;

  /** Start an asynchronous navigation, superseding any that is still pending. */
  begin(): NavigationTicket {
    this.supersede();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => generation === this.generation,
    };
  }

  /** A navigation happened (or started) elsewhere; any pending request is now stale. */
  supersede(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}
