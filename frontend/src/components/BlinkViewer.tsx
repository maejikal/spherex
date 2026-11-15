import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, Info, LoaderCircle, MapPin, Pause, Play, RotateCcw, SkipBack, SkipForward, ZoomIn, ZoomOut } from 'lucide-react';
import { getBlinkCutouts, getBlinkModes, getDynamicBlink } from '../api/client.ts';
import type { BlinkAnalysis, BlinkFrame, BlinkMode, BlinkModes } from '../api/types.ts';
import { BLINK_COVERED_REGION, BLINK_CUTOUT_SIZE, BLINK_DISCLAIMER, BLINK_DYNAMIC_FOV_DEG } from '../sky/blink/config.ts';
import { blinkQueryKey, modeLabel, resolveBlinkMode } from '../sky/blink/mode.ts';
import { clockView } from '../sky/blink/timing.ts';
import { useLoadingRun } from './useLoadingRun.ts';
import { describeBlinkError } from '../sky/blink/errors.ts';
import {
  activeTimer,
  BLINK_INTERVALS_MS,
  frameDirectionForKey,
  formatInterval,
  initialPlayer,
  nextZoom,
  playerReducer,
} from '../sky/blink/playback.ts';
import { imageBounds, sharedViewport } from '../sky/blink/viewport.ts';
import type { PixelBounds } from '../sky/blink/viewport.ts';
import { formatCoordinate } from '../sky/coordinates.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';

interface BlinkViewerProps {
  /** Position captured when the user chose Analyze area; the camera moving afterwards does not change it. */
  target: (SkyCoordinates & { name?: string }) | null;
  /** `dynamic` asks NASA/IPAC for a wavelength-matched pair at the target; `local` uses the configured local SPHEREx FITS pairs. */
  mode: BlinkMode;
  onModeChange: (mode: BlinkMode) => void;
  onFlagForReview: (analysis: BlinkAnalysis) => void;
  onGoToCoveredRegion: (coordinates: SkyCoordinates, label: string) => void;
}

export function BlinkViewer({ target, mode, onModeChange, onGoToCoveredRegion, onFlagForReview }: BlinkViewerProps) {
  const modes = useQuery({ queryKey: ['blink', 'modes'], queryFn: ({ signal }) => getBlinkModes(signal), staleTime: 5 * 60_000, retry: false });
  const active = resolveBlinkMode(mode, modes.data);
  useEffect(() => {
    if (active !== mode) onModeChange(active); // e.g. the server has archive mode switched off
  }, [active, mode, onModeChange]);

  // The query key is the analysed position and mode, so a newer analysis can never show an older response.
  const query = useQuery({
    queryKey: blinkQueryKey(active, target, active === 'dynamic' ? BLINK_DYNAMIC_FOV_DEG : BLINK_CUTOUT_SIZE),
    queryFn: ({ signal }) => (active === 'dynamic'
      ? getDynamicBlink(target!, BLINK_DYNAMIC_FOV_DEG, signal)
      : getBlinkCutouts(target!, BLINK_CUTOUT_SIZE, signal)),
    enabled: Boolean(target),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const loading = Boolean(target) && !query.data && query.isFetching;
  const run = useLoadingRun({ loading, succeeded: Boolean(query.data), mode: active, requestKey: `${active}|${target?.ra}|${target?.dec}` });

  if (!target) {
    return <div className="blink-panel"><p className="blink-note">Select a position and choose Analyze area to compare SPHEREx observations.</p></div>;
  }

  const position = `RA ${formatCoordinate(target.ra, 5)}°, Dec ${target.dec >= 0 ? '+' : ''}${formatCoordinate(target.dec, 5)}°`;
  const switcher = (
    <>
    <BlinkDestination target={target} />
    <ModeSwitch
      mode={active}
      modes={modes.data}
      onChange={onModeChange}
    />
    </>
  );

  if (query.data) {
    return <BlinkPlayer key={query.data.frames.map((frame) => frame.imageUrl).join('|')} analysis={query.data} switcher={switcher} onFlagForReview={onFlagForReview} />;
  }

  if (query.isError && !query.isFetching) {
    const problem = describeBlinkError(query.error);
    return (
      <div className="blink-panel">
        {switcher}
        <div className="callout callout--error" role="alert">
          <AlertCircle aria-hidden="true" size={17} />
          <div>
            <strong>{problem.title}</strong>
            <p>{problem.message}</p>
            <p className="blink-position">{modeLabel(active)} · {position}</p>
          </div>
        </div>
        <div className="button-row">
          {active === 'local' && problem.kind === 'no-coverage' && (
            <button className="button button--secondary" type="button" onClick={() => onGoToCoveredRegion(BLINK_COVERED_REGION, 'the covered SPHEREx region')}>
              <MapPin aria-hidden="true" size={15} />Go to covered region
            </button>
          )}
          {problem.retryable && (
            <button className="button button--secondary" type="button" onClick={() => void query.refetch()}>
              <RotateCcw aria-hidden="true" size={15} />Retry
            </button>
          )}
          {active === 'dynamic' && modes.data?.localDemoAvailable && (
            <button className="button button--quiet" type="button" onClick={() => onModeChange('local')} title="Compare local SPHEREx observations instead (limited sky coverage)">
              Use local SPHEREx instead
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="blink-panel">
      {switcher}
      <div className="blink-stage blink-stage--loading" role="status" aria-live="polite">
        <LoaderCircle className="spin" aria-hidden="true" size={26} />
        <p>{active === 'dynamic' ? 'Searching NASA/IPAC for wavelength-matched SPHEREx observations…' : 'Preparing aligned SPHEREx observations…'}</p>
        {run && <LoadingClock key={run.startedAt} startedAt={run.startedAt} estimateMs={run.estimateMs} mode={run.mode} />}
        {active === 'dynamic' && <p className="blink-position">Downloads small FITS cutouts; a new field can take a minute or more.</p>}
        <p className="blink-position">{position}</p>
      </div>
      <p className="blink-note">{BLINK_DISCLAIMER}</p>
    </div>
  );
}

/** Navigation names belong to the captured selection, never the moving camera or a nearby match. */
export function BlinkDestination({ target }: { target: SkyCoordinates & { name?: string } }) {
  return (
    <div className="blink-destination" aria-label="Analysis destination">
      <strong>{target.name?.trim() || 'Selected sky position'}</strong>
      <div className="blink-position">RA {formatCoordinate(target.ra, 5)}°, Dec {target.dec >= 0 ? '+' : ''}{formatCoordinate(target.dec, 5)}°</div>
    </div>
  );
}

/** Elapsed time from a monotonic clock (not a counter), refreshed every second; the estimated total is fixed per request. */
function LoadingClock({ startedAt, estimateMs, mode }: { startedAt: number; estimateMs: number | null; mode: BlinkMode }) {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    const refresh = () => setNow(performance.now());
    refresh();
    const timer = window.setInterval(refresh, 1000);
    document.addEventListener('visibilitychange', refresh); // a throttled or suspended tab catches up immediately
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [startedAt]);
  const view = clockView(now - startedAt, estimateMs, mode);
  return (
    <div className={`blink-clock${view.overrun ? ' blink-clock--overrun' : ''}`} role="timer" aria-label={`Elapsed ${view.elapsed}`}>
      <span className="blink-clock__time">{view.elapsed}{view.estimate && <span className="blink-clock__estimate"> / {view.estimate}</span>}</span>
      <span className="blink-clock__caption">{view.caption}</span>
      {/* Announced politely, and only when a new threshold is reached (the text changes at most four times). */}
      <span className="blink-clock__note" role="status" aria-live="polite" data-level={view.noteLevel}>{view.note}</span>
    </div>
  );
}

function ModeSwitch({ mode, modes, onChange }: {
  mode: BlinkMode;
  modes: BlinkModes | undefined;
  onChange: (mode: BlinkMode) => void;
}) {
  const options: { value: BlinkMode; enabled: boolean; hint: string }[] = [
    { value: 'dynamic', enabled: modes ? modes.dynamicEnabled : true, hint: 'Find a wavelength-matched pair from the NASA/IPAC SPHEREx archive for this position' },
    { value: 'local', enabled: modes ? modes.localDemoAvailable : true, hint: 'Automatically match local SPHEREx observations to this position (limited sky coverage)' },
  ];
  return (
    <div className="blink-source-controls">
      <div className="blink-mode" role="group" aria-label="Observation source">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`blink-mode__option${mode === option.value ? ' blink-mode__option--active' : ''}`}
            aria-pressed={mode === option.value}
            disabled={!option.enabled}
            title={option.enabled ? option.hint : 'Not available on this server'}
            onClick={() => mode !== option.value && onChange(option.value)}
          >
            {modeLabel(option.value)}
          </button>
        ))}
      </div>

    </div>
  );
}

export function BlinkPlayer({ analysis, switcher, onFlagForReview }: { analysis: BlinkAnalysis; switcher: React.ReactNode; onFlagForReview?: (analysis: BlinkAnalysis) => void }) {
  const frameCount = analysis.frames.length;
  const [player, dispatch] = useReducer(playerReducer, undefined, initialPlayer);
  const [zoom, setZoom] = useState(1);
  const [fitData, setFitData] = useState(true);
  const [bounds, setBounds] = useState<Record<string, PixelBounds | null>>({});
  const [loaded, setLoaded] = useState<ReadonlySet<string>>(() => new Set());
  const [imageFailed, setImageFailed] = useState(false);
  const [reloads, setReloads] = useState(0);
  const frameButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const ready = loaded.size === frameCount && !imageFailed;
  const active = (analysis.frames[player.frame] ?? analysis.frames[0]) as BlinkFrame; // the parser guarantees two or more frames

  const fitted = sharedViewport(analysis.frames.map((frame) => bounds[frame.id] ?? null), analysis.imageSize);
  const cropped = fitData && ready && (fitted.width < analysis.imageSize || fitted.height < analysis.imageSize);
  const viewport = cropped ? fitted : { x: 0, y: 0, width: analysis.imageSize, height: analysis.imageSize };
  const visibleWidth = analysis.fieldOfViewArcmin * viewport.width / analysis.imageSize / zoom;
  const visibleHeight = analysis.fieldOfViewArcmin * viewport.height / analysis.imageSize / zoom;
  const visibleField = viewport.width === viewport.height
    ? `${visibleWidth.toFixed(1)}′`
    : `${visibleWidth.toFixed(1)}′ × ${visibleHeight.toFixed(1)}′`;

  // One interval exists only while playing with both images ready; changing speed replaces it, and it is
  // always cleared on pause, on unmount, and when the frame count changes.
  const intervalMs = activeTimer(player, frameCount, ready);
  useEffect(() => {
    if (intervalMs === null) return;
    const timer = window.setInterval(() => dispatch({ type: 'tick', frameCount }), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, frameCount]);

  const markLoaded = useCallback((id: string) => setLoaded((current) => (current.has(id) ? current : new Set(current).add(id))), []);

  const onStageKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      dispatch({ type: 'toggle', frameCount });
    }
  };

  const onPlayerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = frameDirectionForKey(event.key);
    if (!ready || direction === null || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('input, select, textarea, [contenteditable="true"], [role="combobox"], [role="listbox"]')) return;

    event.preventDefault();
    const focusedFrame = target.closest<HTMLButtonElement>('.blink-frame');
    const focusedIndex = focusedFrame ? frameButtons.current.indexOf(focusedFrame) : -1;
    if (focusedIndex >= 0) {
      const nextFrame = (focusedIndex + direction + frameCount) % frameCount;
      dispatch({ type: 'select', frame: nextFrame, frameCount });
      frameButtons.current[nextFrame]?.focus();
      return;
    }

    dispatch({ type: 'step', direction, frameCount });
  };

  const retryImages = () => {
    setImageFailed(false);
    setLoaded(new Set());
    setBounds({});
    setReloads((count) => count + 1);
  };

  return (
    <div className="blink-panel blink-panel--player" onKeyDown={onPlayerKeyDown}>
      <div className="blink-player-source">{switcher}</div>
      <div className="blink-view-heading">
        <span>{cropped ? 'Fitted to usable data' : 'Full field'} · {visibleField} visible</span>
        <button className="button button--quiet button--compact" type="button" disabled={!ready || (fitted.width === analysis.imageSize && fitted.height === analysis.imageSize)} onClick={() => { setFitData((fit) => !fit); setZoom(1); }}>
          {fitData ? 'Full field' : 'Fit data'}
        </button>
      </div>
      <div className="blink-stage-area">
        <div
          className="blink-stage"
          style={{ aspectRatio: `${viewport.width} / ${viewport.height}`, '--blink-aspect': viewport.width / viewport.height } as CSSProperties}
          tabIndex={0}
          role="group"
          aria-label={`${active.label} observation. Space plays or pauses; arrow keys change frame.`}
          onPointerDownCapture={(event) => {
            const target = event.target;
            if (event.button === 0 && !(target instanceof HTMLElement && target.closest('button, a, input, select'))) {
              event.currentTarget.focus({ preventScroll: true });
            }
          }}
          onKeyDown={onStageKeyDown}
        >
          <div className="blink-stage__scroller">
            <div className="blink-stage__canvas" style={{ width: `${zoom * 100}%`, aspectRatio: `${viewport.width} / ${viewport.height}` }} data-zoomed={zoom > 1}>
              {analysis.frames.map((frame, index) => (
                <img
                  key={`${frame.id}-${reloads}`}
                  className="blink-stage__image"
                  src={frame.imageUrl}
                  alt={index === player.frame ? `SPHEREx ${frame.label}, ${visibleField} visible field` : ''}
                  aria-hidden={index !== player.frame}
                  draggable={false}
                  style={{
                    visibility: index === player.frame ? 'visible' : 'hidden', imageRendering: zoom > 1 ? 'pixelated' : 'auto',
                    width: `${analysis.imageSize / viewport.width * 100}%`, height: `${analysis.imageSize / viewport.height * 100}%`,
                    left: `${-viewport.x / viewport.width * 100}%`, top: `${-viewport.y / viewport.height * 100}%`,
                  }}
                  onLoad={(event) => {
                    // Decode before counting it as ready, so the first switch to this frame cannot flash.
                    const image = event.currentTarget;
                    void (image.decode ? image.decode().catch(() => undefined) : Promise.resolve()).then(() => {
                      const pixels = imageBounds(image);
                      setBounds((current) => ({ ...current, [frame.id]: pixels }));
                      markLoaded(frame.id);
                    });
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
      </div>

      <div className="blink-controls" role="group" aria-label="Blink controls">
        {onFlagForReview && <button className="button button--secondary button--compact" type="button" disabled={!ready} onClick={() => { dispatch({ type: 'pause' }); onFlagForReview(structuredClone(analysis)); }}>Flag for review</button>}
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

      <section className="blink-secondary" tabIndex={0} aria-label="Observation information">
        <details className="blink-details">
          <summary>Observation details{analysis.warnings.length > 0 ? ' · Coverage notes' : ''}<span className="blink-details__return" aria-hidden="true">Back to image</span></summary>
          <div className="blink-details__content">
            <div className="blink-frames" role="group" aria-label="Observation frames. Use Left and Right arrow keys to change frame.">
              {analysis.frames.map((frame, index) => (
                <button
                  key={frame.id}
                  ref={(element) => { frameButtons.current[index] = element; }}
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

            <p className="blink-coverage-note">{analysis.frames.map((frame) => `${frame.label}: ${Math.round(frame.coverageFraction * 100)}% usable`).join(' · ')} of full field. Blank areas have no usable data.</p>

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
              {active.wavelengthUm && <div><dt>Wavelength here</dt><dd>{analysis.mode === 'dynamic' ? `${active.wavelengthUm.mean.toFixed(4)} µm` : `${active.wavelengthUm.mean.toFixed(2)} µm`}{active.bandwidthUm !== undefined && ` ± ${(active.bandwidthUm * 500).toFixed(0)} nm`}</dd></div>}
              {analysis.selection && <div><dt>Wavelength gap</dt><dd>{analysis.selection.actualGapNm.toFixed(1)} nm ({Math.round(analysis.selection.actualGapOverBandwidth * 100)}% of bandwidth)</dd></div>}
              {active.geometricCoverage !== undefined && <div><dt>On detector</dt><dd>{Math.round(active.geometricCoverage * 100)}%</dd></div>}
              {active.suspectFraction !== undefined && <div><dt>Caution flags</dt><dd>{Math.round(active.suspectFraction * 100)}% of usable px</dd></div>}
              <div><dt>Full field</dt><dd>{analysis.fieldOfViewArcmin.toFixed(1)}′ · {analysis.pixelScaleArcsec}″/px{analysis.rotationDeg ? ` · rotated ${analysis.rotationDeg}°` : ''}</dd></div>
              {analysis.provenance && <div className="blink-meta__wide"><dt>Source</dt><dd>{analysis.provenance.source} · {analysis.provenance.collection} · {analysis.provenance.release}</dd></div>}
            </dl>
            <p className="blink-note">{BLINK_DISCLAIMER}</p>
          </div>
        </details>
      </section>
    </div>
  );
}
