import { useMemo } from 'react';
import type { ConstellationInfo } from '../sky/constellations.ts';
import { projectConstellationOverview } from '../sky/constellationOverview.ts';

/** Read-only chart. Uses the exact lookup position, never the main camera center. */
export function ConstellationOverview({ constellation }: { constellation: ConstellationInfo }) {
  const chart = useMemo(() => projectConstellationOverview(constellation.boundary, constellation), [constellation]);
  return (
    <aside tabIndex={0} className="constellation-overview" aria-label={`${constellation.name} constellation overview`}>
      <header className="constellation-overview__heading">
        <span>Constellation overview</span>
        <strong>{constellation.name}</strong>
      </header>
      {chart ? <svg className="constellation-overview__chart" viewBox="0 0 240 168" role="img" aria-label={`Full official boundary of ${constellation.name}, with selected position marked by a cyan dot and cross. North up and east left at chart center.`}>
        {chart.rings.map((ring, index) => <path key={index} className="constellation-overview__boundary" d={`${ring.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(3)},${point.y.toFixed(3)}`).join(' ')} Z`} />)}
        <g className="constellation-overview__marker" transform={`translate(${chart.marker.x},${chart.marker.y})`}>
          <path d="M-7,0 H7 M0,-7 V7" />
          <circle r="3" />
        </g>
        <text x="12" y="14" className="constellation-overview__orientation">N ↑ · E ←</text>
      </svg> : <p role="status">Boundary overview unavailable.</p>}
      <footer className="constellation-overview__legend"><span aria-hidden="true">⊕</span> Selected position <span>ICRS</span></footer>
    </aside>
  );
}
