import type { UseQueryResult } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type { ConstellationInfo } from '../sky/constellations.ts';

export interface ConstellationCardProps {
  lookup: UseQueryResult<ConstellationInfo, Error>;
  boundaryEnabled: boolean;
  onBoundaryChange: (enabled: boolean) => void;
  compact?: boolean;
}

export function ConstellationCard({ lookup, boundaryEnabled, onBoundaryChange, compact = false }: ConstellationCardProps) {
  return (
    <div className={`constellation-card${compact ? ' constellation-card--compact' : ''}`}>
      {lookup.isPending && <p role="status">Finding constellation…</p>}
      {lookup.isError && <div role="status"><p>Constellation lookup unavailable.</p><button type="button" className="button button--quiet button--compact" onClick={() => void lookup.refetch()}>Retry constellation lookup</button></div>}
      {lookup.isSuccess && <div className="constellation-card__identity">
        <p role="status"><span className="sr-only">This position is in </span><strong>{lookup.data.name}</strong><span className="sr-only">.</span></p>
        <a className="constellation-card__article" href={lookup.data.learnUrl} target="_blank" rel="noopener noreferrer" aria-label={`Learn about ${lookup.data.name} on Wikipedia (opens in a new tab)`}>
          Wikipedia <ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>}
      <label className="constellation-card__toggle">
        <span>Official boundary outline</span>
        <input type="checkbox" checked={boundaryEnabled} onChange={(event) => onBoundaryChange(event.target.checked)} />
      </label>
      {!compact && <details className="constellation-card__details">
        <summary>About this boundary</summary>
        <div className="constellation-card__explanation">
          <p>Outline follows the selected constellation, not the view center. At close zoom, its edges may be outside the view. Zoom out to see more.</p>
          {lookup.data && <a href={lookup.data.boundarySource} target="_blank" rel="noopener noreferrer">CDS VI/49 · Davenhall &amp; Leggett, 1989<span className="sr-only"> (opens in a new tab)</span></a>}
        </div>
      </details>}
    </div>
  );
}
