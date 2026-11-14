import { useCallback, useEffect, useReducer, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Info, LoaderCircle, MapPin, Pause, Play, RotateCcw, SkipBack, SkipForward, ZoomIn, ZoomOut } from 'lucide-react';
import { getBlinkCutouts } from '../api/client.ts';
import type { BlinkAnalysis, BlinkFrame } from '../api/types.ts';
import { BLINK_COVERED_REGION, BLINK_CUTOUT_SIZE, BLINK_DISCLAIMER } from '../sky/blink/config.ts';
import { describeBlinkError } from '../sky/blink/errors.ts';
import {
  activeTimer,
  BLINK_INTERVALS_MS,
  formatInterval,
  initialPlayer,
  nextZoom,
  playerReducer,
} from '../sky/blink/playback.ts';
import { formatCoordinate } from '../sky/coordinates.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';

interface BlinkViewerProps {
  /** Position captured when the user chose Analyze area; the camera moving afterwards does not change it. */
  target: SkyCoordinates | null;
  onGoToCoveredRegion: (coordinates: SkyCoordinates, label: string) => void;
}

export function BlinkViewer({ target, onGoToCoveredRegion }: BlinkViewerProps) {
  // The query key is the analysed position, so a newer analysis can never show an older response.
  const query = useQuery({
    queryKey: ['blink', target?.ra, target?.dec, BLINK_CUTOUT_SIZE],
    queryFn: ({ signal }) => getBlinkCutouts(target!, BLINK_CUTOUT_SIZE, signal),
    enabled: Boolean(target),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!target) {
    return <div className="blink-panel"><p className="blink-note">Select a position and choose Analyze area to compare SPHEREx observations.</p></div>;
  }

  const position = `RA ${formatCoordinate(target.ra, 5)}°, Dec ${target.dec >= 0 ? '+' : ''}${formatCoordinate(target.dec, 5)}°`;

  if (query.data) {
    return <BlinkPlayer key={query.data.frames.map((frame) => frame.imageUrl).join('|')} analysis={query.data} />;
  }

  if (query.isError && !query.isFetching) {
    const problem = describeBlinkError(query.error);
    return (
      <div className="blink-panel">
        <div className="callout callout--error" role="alert">
          <AlertCircle aria-hidden="true" size={17} />
          <div>
            <strong>{problem.title}</strong>
            <p>{problem.message}</p>
            <p className="blink-position">{position}</p>
          </div>
        </div>
        <div className="button-row">
          {problem.kind === 'no-coverage' && (
            <button className="button button--secondary" type="button" onClick={() => onGoToCoveredRegion(BLINK_COVERED_REGION, 'the covered SPHEREx region')}>
              <MapPin aria-hidden="true" size={15} />Go to covered region
            </button>
          )}
          {problem.retryable && (
            <button className="button button--secondary" type="button" onClick={() => void query.refetch()}>
              <RotateCcw aria-hidden="true" size={15} />Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="blink-panel">
      <div className="blink-stage blink-stage--loading" role="status" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" size={26} />
        <p>Preparing aligned SPHEREx observations…</p>
        <p className="blink-position">{position}</p>
      </div>
      <p className="blink-note">{BLINK_DISCLAIMER}</p>
    </div>
  );
}

function BlinkPlayer({ analysis }: { analysis: BlinkAnalysis }) {
  const frameCount = analysis.frames.length;
  const [player, dispatch] = useReducer(playerReducer, undefined, initialPlayer);
  const [zoom, setZoom] = useState(1);
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [imageFailed, setImageFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const ready = loaded.size === frameCount && !imageFailed;
  const active = (analysis.frames[player.frame] ?? analysis.frames[0]) as BlinkFrame; // the parser guarantees two or more frames

  // One interval exists only while playing with both images ready; changing speed replaces it, and it is
  // always cleared on pause, on unmount, and when the frame count changes.
  const intervalMs = activeTimer(player, frameCount, ready);
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = window.setInterval(() => dispatch({ type: 'tick', frameCount }), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, frameCount]);

  const markLoaded = useCallback((id: string) => setLoaded((current) => (current.has(id) ? current : new Set(current).add(id))), []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      dispatch({ type: 'toggle', frameCount });
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      dispatch({ type: 'step', direction: 1, frameCount });
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      dispatch({ type: 'step', direction: -1, frameCount });
    }
  };

  const retryImages = () => {
    setImageFailed(false);
    setLoaded(new Set());
    setReloads((count) => count + 1);
  };

  return (
    <div className="blink-panel">
      <div className="blink-stage" tabIndex={0} role="group" aria-label={`${active.label} observation. Space plays or pauses; arrow keys change frame.`} onKeyDown={onKeyDown}>
        <div className="blink-stage__scroller">
          <div className="blink-stage__canvas" style={{ width: `${zoom * 100}%` }} data-zoomed={zoom > 1}>
            {analysis.frames.map((frame, index) => (
              <img
                key={`${frame.id}-${reloads}`}
                className="blink-stage__image"
                src={frame.imageUrl}
                alt={index === player.frame ? `SPHEREx ${frame.label}, ${analysis.fieldOfViewArcmin.toFixed(0)} arcminute field` : ''}
                aria-hidden={index !== player.frame}
                draggable={false}
                style={{ visibility: index === player.frame ? 'visible' : 'hidden', imageRendering: zoom > 1 ? 'pixelated' : 'auto' }}
                onLoad={(event) => {
                  // Decode before counting it as ready, so the first switch to this frame cannot flash.
                  const image = event.currentTarget;
                  void (image.decode ? image.decode().catch(() => undefined) : Promise.resolve()).then(() => markLoaded(frame.id));
                }}
                onError={() => setImageFailed(true)}
              />
            ))}
          </div>
        </div>
        <span className="blink-stage__badge" aria-hidden="true">{active.label}<small>{active.date}</small></span>
        <span className="blink-stage__compass" aria-hidden="true">N ↑ · E ←</span>
        {!ready && !imageFailed && <div className="blink-stage__overlay" role="status"><LoaderCircle className="spin" aria-hidden="true" size={22} /><span>Loading images…</span></div>}
        {imageFailed && (
          <div className="blink-stage__overlay" role="alert">
            <AlertCircle aria-hidden="true" size={22} />
            <span>An image failed to load.</span>
            <button className="button button--secondary button--compact" type="button" onClick={retryImages}><RotateCcw aria-hidden="true" size={13} />Retry</button>
          </div>
        )}
      </div>

      <div className="blink-controls" role="group" aria-label="Blink controls">
        <button className="button button--primary button--compact" type="button" disabled={!ready} onClick={() => dispatch({ type: 'toggle', frameCount })} aria-pressed={player.playing}>
          {player.playing ? <Pause aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}{player.playing ? 'Pause' : 'Play'}
        </button>
        <button className="icon-button button button--secondary" type="button" disabled={!ready} aria-label="Previous frame" title="Previous frame" onClick={() => dispatch({ type: 'step', direction: -1, frameCount })}><SkipBack aria-hidden="true" size={14} /></button>
        <button className="icon-button button button--secondary" type="button" disabled={!ready} aria-label="Next frame" title="Next frame" onClick={() => dispatch({ type: 'step', direction: 1, frameCount })}><SkipForward aria-hidden="true" size={14} /></button>
        <label className="blink-speed">
          <span>Speed</span>
          <select className="select-input" value={player.intervalMs} onChange={(event) => dispatch({ type: 'speed', intervalMs: Number(event.target.value) })} aria-label="Seconds per frame">
            {BLINK_INTERVALS_MS.map((value) => <option key={value} value={value}>{formatInterval(value)} / frame</option>)}
          </select>
        </label>
        <div className="blink-zoom" role="group" aria-label="Zoom">
          <button className="icon-button button button--secondary" type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => setZoom((z) => nextZoom(z, 'out'))}><ZoomOut aria-hidden="true" size={14} /></button>
          <button className="button button--quiet button--compact" type="button" aria-label="Reset zoom" disabled={zoom === 1} onClick={() => setZoom(1)}>{zoom}×</button>
          <button className="icon-button button button--secondary" type="button" aria-label="Zoom in" disabled={zoom === 4} onClick={() => setZoom((z) => nextZoom(z, 'in'))}><ZoomIn aria-hidden="true" size={14} /></button>
        </div>
      </div>

      <div className="blink-frames" role="group" aria-label="Observation">
        {analysis.frames.map((frame, index) => (
          <button
            key={frame.id}
            className={`button button--secondary blink-frame${index === player.frame ? ' blink-frame--active' : ''}`}
            type="button"
            aria-pressed={index === player.frame}
            disabled={!ready}
            onClick={() => dispatch({ type: 'select', frame: index, frameCount })}
          >
            {frame.label}
          </button>
        ))}
      </div>

      {analysis.warnings.length > 0 && (
        <div className="callout callout--warning" role="status">
          <Info aria-hidden="true" size={17} />
          <div>{analysis.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>
        </div>
      )}

      <dl className="blink-meta" aria-label="Observation details">
        <div><dt>Observed</dt><dd>{active.date}</dd></div>
        <div><dt>Position</dt><dd>RA {formatCoordinate(analysis.ra, 4)}°, Dec {analysis.dec >= 0 ? '+' : ''}{formatCoordinate(analysis.dec, 4)}°</dd></div>
        {active.detector !== undefined && <div><dt>Detector</dt><dd>{active.detector}</dd></div>}
        {active.obsid && <div><dt>Observation ID</dt><dd>{active.obsid}</dd></div>}
        <div><dt>Usable data</dt><dd>{Math.round(active.coverageFraction * 100)}%</dd></div>
        {active.wavelengthUm && <div><dt>Wavelength here</dt><dd>{active.wavelengthUm.mean.toFixed(2)} µm</dd></div>}
        <div><dt>Field</dt><dd>{analysis.fieldOfViewArcmin.toFixed(1)}′ · {analysis.pixelScaleArcsec}″/px</dd></div>
      </dl>

      <p className="blink-note">{BLINK_DISCLAIMER}</p>
    </div>
  );
}
