import { useEffect, useRef, useState } from 'react';
import type { BlinkMode } from '../api/types.ts';
import { RunTracker, type Run } from '../sky/blink/timing.ts';

/**
 * Tracks the current analysis request for the loading clock. Starts when `loading` becomes true for a key
 * (a new analysis, a retry, or a mode change), ends when it stops, and records the duration only for a
 * successful request that is still the current one.
 */
export function useLoadingRun({ loading, succeeded, mode, requestKey }: { loading: boolean; succeeded: boolean; mode: BlinkMode; requestKey: string }): Run | null {
  const tracker = useRef<RunTracker | null>(null);
  if (tracker.current === null) tracker.current = new RunTracker();
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    const t = tracker.current!;
    if (loading) {
      const next = t.begin(requestKey, mode); // idempotent for the same key, so StrictMode cannot create a second run
      setRun((current) => (current === next ? current : next));
    } else if (t.current) {
      t.finish(t.current.key === requestKey ? requestKey : '\u0000stale', succeeded);
      setRun(null);
    }
  }, [loading, succeeded, mode, requestKey]);

  // Closing the viewer abandons the in-flight clock (the request itself keeps running in the query cache).
  useEffect(() => () => tracker.current?.cancel(), []);
  return run;
}
