import { useCallback, useEffect, useReducer, useState } from 'react';
import type { KeyboardEvent } from 'react';
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
  /** `dynamic` asks NASA/IPAC for a wavelength-matched pair at the target; `local` uses the two fixed demo files. */
  mode: BlinkMode;
  onModeChange: (mode: BlinkMode) => void;
  onGoToCoveredRegion: (coordinates: SkyCoordinates, label: string) => void;
}

export function BlinkViewer({ target, mode, onModeChange, onGoToCoveredRegion }: BlinkViewerProps) {
  const modes = useQuery({ queryKey: ['blink', 'modes'], queryFn: ({ signal }) => getBlinkModes(signal), staleTime: 5 * 60_000, retry: false });
  const active = resolveBlinkMode(mode, modes.data);
  useEffect(() => {
    if (active !== mode) onModeChange(active); // e.g. the server has archive mode switched off
  }, [active, mode, onModeChange]);

  // The query key is the analysed position and mode, so a newer analysis can never show an older response.
  const query = useQuery({
    queryKey: blinkQueryKey(active, target, active === 'dynamic' ? BLINK_DYNAMIC_FOV_DEG : BLINK_CUTOUT_SIZE),
    queryFn: ({ signal }) => (active === 'dynamic' ? getDynamicBlink(target!, BLINK_DYNAMIC_FOV_DEG, signal) : getBlinkCutouts(target!, BLINK_CUTOUT_SIZE, signal)),
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
  const switcher = <ModeSwitch mode={active} modes={modes.data} onChange={onModeChange} />;

  if (query.data) {
    return <BlinkPlayer key={query.data.frames.map((frame) => frame.imageUrl).join('|')} analysis={query.data} switcher={switcher} />;
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
            <button className="button button--quiet" type="button" onClick={() => onModeChange('local')} title="Compare the two fixed local observations instead (limited sky region)">
              Use local demo instead
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

function ModeSwitch({ mode, modes, onChange }: { mode: BlinkMode; modes: BlinkModes | undefined; onChange: (mode: BlinkMode) => void }) {
  const options: { value: BlinkMode; enabled: boolean; hint: string }[] = [
    { value: 'dynamic', enabled: modes ? modes.dynamicEnabled : true, hint: 'Find a wavelength-matched pair from the NASA/IPAC SPHEREx archive for this position' },
    { value: 'local', enabled: modes ? modes.localDemoAvailable : true, hint: 'Two fixed local observations that cover only a small region of sky' },
  ];
  return (
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
  );
}

function BlinkPlayer({ analysis, switcher }: { analysis: BlinkAnalysis; switcher: React.ReactNode }) {
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
      {switcher}
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
        {active.wavelengthUm && <div><dt>Wavelength here</dt><dd>{analysis.mode === 'dynamic' ? `${active.wavelengthUm.mean.toFixed(4)} µm` : `${active.wavelengthUm.mean.toFixed(2)} µm`}{active.bandwidthUm !== undefined && ` ± ${(active.bandwidthUm * 500).toFixed(0)} nm`}</dd></div>}
        {analysis.selection && <div><dt>Wavelength gap</dt><dd>{analysis.selection.actualGapNm.toFixed(1)} nm ({Math.round(analysis.selection.actualGapOverBandwidth * 100)}% of bandwidth)</dd></div>}
        {active.geometricCoverage !== undefined && <div><dt>On detector</dt><dd>{Math.round(active.geometricCoverage * 100)}%</dd></div>}
        {active.suspectFraction !== undefined && <div><dt>Caution flags</dt><dd>{Math.round(active.suspectFraction * 100)}% of usable px</dd></div>}
        <div><dt>Field</dt><dd>{analysis.fieldOfViewArcmin.toFixed(1)}′ · {analysis.pixelScaleArcsec}″/px{analysis.rotationDeg ? ` · rotated ${analysis.rotationDeg}°` : ''}</dd></div>
        {analysis.provenance && <div className="blink-meta__wide"><dt>Source</dt><dd>{analysis.provenance.source} · {analysis.provenance.collection} · {analysis.provenance.release}</dd></div>}
      </dl>

      <p className="blink-note">{BLINK_DISCLAIMER}</p>
    </div>
  );
}
