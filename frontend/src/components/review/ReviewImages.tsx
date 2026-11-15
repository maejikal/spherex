import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { BlinkAnalysis, BlinkFrame } from '../../api/types.ts';
import { moveMark, pointFromClient } from '../../review/model.ts';
import type { Mark } from '../../review/model.ts';

export function FrameMetadata({ frame }: { frame: BlinkFrame }) {
  return <dl className="review-metadata">
    <div><dt>Observation time</dt><dd>{frame.dateObs || frame.date || 'Unavailable'}</dd></div>
    <div><dt>Wavelength</dt><dd>{frame.wavelengthUm ? `${frame.wavelengthUm.min.toFixed(3)}–${frame.wavelengthUm.max.toFixed(3)} µm` : 'Unavailable'}</dd></div>
    <div><dt>Observation ID</dt><dd>{frame.obsid || 'Unavailable'}</dd></div>
    <div><dt>Usable coverage</dt><dd>{Number.isFinite(frame.coverageFraction) ? `${(frame.coverageFraction * 100).toFixed(1)}%` : 'Unavailable'}</dd></div>
  </dl>;
}
export function AnalysisMetadata({ analysis }: { analysis: BlinkAnalysis }) {
  return <details className="review-provenance"><summary>Source, geometry and observation warnings</summary>
    <dl className="review-metadata">
      <div><dt>Center (ICRS)</dt><dd>RA {analysis.ra}°, Dec {analysis.dec}°</dd></div>
      <div><dt>Source</dt><dd>{analysis.provenance?.source ?? 'Unavailable'} · {analysis.mode === 'dynamic' ? 'Archive analysis' : 'Local analysis'}</dd></div>
      <div><dt>Release / collection</dt><dd>{analysis.provenance ? `${analysis.provenance.release} / ${analysis.provenance.collection}` : 'Unavailable'}</dd></div>
      <div><dt>Original images</dt><dd>{analysis.imageSize} × {analysis.imageSize} px · {analysis.pixelScaleArcsec} arcsec/pixel</dd></div>
      <div><dt>Orientation</dt><dd>{analysis.orientation || 'Unavailable'}</dd></div>
      <div><dt>Quality policy</dt><dd>{analysis.provenance?.flagPolicy || 'Unavailable'}</dd></div>
    </dl>
    <p>Crosshairs identify image pixels, not measured celestial positions. Fractional positioning is an annotation aid, not additional image resolution or astrometric accuracy. Images are evidence for review, not confirmed detections.</p>
    {analysis.warnings.map((warning, index) => <p className="review-warning" key={index}>{warning}</p>)}
  </details>;
}
export function ReviewImage({ frame, size, src, mark, onMark, onReady }: {
  frame: BlinkFrame; size: number; src: string | undefined; mark: Mark | null | undefined;
  onMark?: (mark: Mark | null | undefined) => void; onReady?: (ready: boolean) => void;
}) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const latestMark = useRef(mark);
  latestMark.current = mark;
  const drag = useRef<{ pointerId: number; original: Mark | null | undefined } | null>(null);
  // Zoom around the existing mark (or image center), without following every drag movement.
  useEffect(() => {
    const view = scroller.current;
    if (!view) return;
    const position = latestMark.current ?? { x: (size - 1) / 2, y: (size - 1) / 2 };
    view.scrollLeft = (position.x + 0.5) / size * view.scrollWidth - view.clientWidth / 2;
    view.scrollTop = (position.y + 0.5) / size * view.scrollHeight - view.clientHeight / 2;
  }, [zoom, size]);
  const dragTo = (event: PointerEvent<HTMLImageElement>) => {
    if (!onMark || drag.current?.pointerId !== event.pointerId) return;
    const point = pointFromClient(event.clientX, event.clientY, event.currentTarget.getBoundingClientRect(), size, true);
    if (point) onMark(point);
  };
  const status = mark ? `Crosshair at x ${mark.x.toFixed(2)}, y ${mark.y.toFixed(2)}` : mark === null ? 'Not visible in this image' : 'Not yet marked';
  return <section className="review-image-card" aria-label={frame.label}>
    <h3>{frame.label}</h3>
    <label className="review-image-zoom">Zoom {frame.label}
      <select className="select-input" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
        {[1, 2, 4, 8].map((value) => <option key={value} value={value}>{value}×</option>)}
      </select>
    </label>
    <div ref={scroller} className="review-image-viewport" tabIndex={zoom > 1 ? 0 : undefined} role="group" aria-label={`${frame.label} image viewport. Scroll to inspect the zoomed image.`}>
    <div className="review-image-stage" style={{ width: `${zoom * 100}%` }}>
      {src && <img key={`${src}-${retry}`} src={src} alt={`SPHEREx observation ${frame.label}`} draggable={false}
        tabIndex={onMark && ready ? 0 : undefined} role={onMark ? 'button' : undefined}
        aria-label={onMark ? `${frame.label}. ${status}. Click and drag to position a crosshair, or press Enter to place it; arrow keys move 0.1 pixel, Shift moves 1 pixel, Alt moves 0.01 pixel. Delete removes it.` : undefined}
        onLoad={(event) => {
          const valid = event.currentTarget.naturalWidth === size && event.currentTarget.naturalHeight === size;
          setReady(valid); setFailed(!valid); onReady?.(valid);
        }}
        onError={() => { setReady(false); setFailed(true); onReady?.(false); }}
        onPointerDown={onMark && ready ? (event) => {
          if (event.button !== 0 || !event.isPrimary || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          drag.current = { pointerId: event.pointerId, original: mark };
          event.currentTarget.setPointerCapture(event.pointerId);
          dragTo(event);
        } : undefined}
        onPointerMove={ready ? dragTo : undefined}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          dragTo(event);
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          onMark?.(drag.current.original);
          drag.current = null;
        }}
        onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; }}
        onKeyDown={onMark && ready ? (event) => {
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Delete', 'Backspace'].includes(event.key)) {
            event.preventDefault();
            onMark(event.key === 'Delete' || event.key === 'Backspace' ? undefined : moveMark(mark, event.key, size, event.altKey ? 0.01 : event.shiftKey ? 1 : 0.1));
          }
        } : undefined}
      />}
      {mark && ready && <svg className="review-crosshair" viewBox="-10 -10 20 20" aria-hidden="true"
        style={{ left: `${(mark.x + 0.5) / size * 100}%`, top: `${(mark.y + 0.5) / size * 100}%` }}>
        <path className="review-crosshair__outline" d="M-9 0H-2M2 0H9M0-9V-2M0 2V9" />
        <path d="M-9 0H-2M2 0H9M0-9V-2M0 2V9" />
        <circle r="1" />
      </svg>}
      {!src && <p role="alert">Saved image unavailable. Evidence cannot be reviewed.</p>}
    </div>
    </div>
    {failed && <div role="alert"><p>Image failed to load or dimensions changed.</p><button className="button button--secondary" type="button" onClick={() => { setFailed(false); setRetry((n) => n + 1); }}>Retry image</button></div>}
    <p className="review-mark-status" role="status">{status}{mark ? ' (original pixels, top-left origin)' : ''}</p>
    {onMark && <div className="review-actions">
      <button className="button button--secondary" type="button" disabled={!ready} onClick={() => onMark(moveMark(mark, 'Enter', size))}>Place crosshair</button>
      <button className="button button--secondary" type="button" aria-pressed={mark === null} onClick={() => onMark(null)}>Not visible</button>
      <button className="button button--quiet" type="button" disabled={mark === undefined} onClick={() => onMark(undefined)}>Clear</button>
    </div>}
    <details className="review-disclosure"><summary>Observation details</summary><FrameMetadata frame={frame} /></details>
  </section>;
}
