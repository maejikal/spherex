import { ConstellationOverview } from './ConstellationOverview.tsx';
import { ConstellationCard, type ConstellationCardProps } from './ConstellationCard.tsx';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, Copy, LoaderCircle, MousePointer2, Move, RotateCcw, Search, X } from 'lucide-react';
import type { ExplorerView } from '../api/types.ts';
import { AladinController } from '../sky/aladin/controller.ts';
import type { ViewState } from '../sky/aladin/controller.ts';
import { clampScale, fovFromScale, scaleFromFov } from '../sky/aladin/fov.ts';
import { defaultFrame } from '../sky/spherex/channels.ts';
import { SPHEREX_HIPS_URL } from '../sky/spherex/config.ts';
import type { SphereXSurveyInfo } from '../sky/spherex/properties.ts';
import { formatCoordinate } from '../sky/coordinates.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';

export interface ViewerStatus {
  loading: boolean;
  tileError: string | null;
}

interface AladinSkyViewerProps {
  view: ExplorerView | null;
  survey: SphereXSurveyInfo | undefined;
  surveyPending: boolean;
  surveyError: Error | null;
  onRetrySurvey: () => void;
  selection: SkyCoordinates | null;
  analysisRequested: boolean;
  constellation: ConstellationCardProps;
  crosshair: boolean;
  onDimensions: (dimensions: { width: number; height: number }) => void;
  /** Pan/zoom made by the user inside Aladin, reported after it settles. */
  onUserView: (view: { ra: number; dec: number; scale: number }) => void;
  onSelect: (coordinates: SkyCoordinates) => void;
  onCenter: (coordinates: SkyCoordinates) => void;
  onAnalyze: () => void;
  onCopySelection: () => void;
  onClearSelection: () => void;
  onKeyPan: (direction: 'north' | 'south' | 'east' | 'west') => void;
  onStatus: (status: ViewerStatus) => void;
}

const MAX_FOV_DEGREES = 360;

export function AladinSkyViewer({
  view, survey, surveyPending, surveyError, onRetrySurvey, selection, analysisRequested, constellation, crosshair,
  onDimensions, onUserView, onSelect, onCenter, onAnalyze, onCopySelection, onClearSelection, onKeyPan, onStatus,
}: AladinSkyViewerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AladinController | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<SkyCoordinates | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ loading: false, tileError: null });
  const actionTrayRef = useRef<HTMLDivElement>(null);
  const [actionTrayPosition, setActionTrayPosition] = useState<{ left: number; top: number } | null>(null);

  // Latest props for long-lived Aladin callbacks (avoids stale closures and re-creating Aladin).
  const latest = useRef({ view, size, selection, onUserView, onSelect, onCenter, onStatus, status });
  latest.current = { view, size, selection, onUserView, onSelect, onCenter, onStatus, status };

  const updateActionTrayPosition = useCallback(() => {
    const selected = latest.current.selection;
    const surface = surfaceRef.current;
    const tray = actionTrayRef.current;
    const screenPosition = selected && controllerRef.current?.getScreenPosition(selected);
    if (!selected || !surface || !tray || !screenPosition || screenPosition.x < 0 || screenPosition.y < 0 || screenPosition.x > surface.clientWidth || screenPosition.y > surface.clientHeight) {
      setActionTrayPosition((current) => current === null ? current : null);
      return;
    }

    const bounds = tray.getBoundingClientRect();
    const edge = 8;
    const gap = 16;
    let left = screenPosition.x + gap;
    let top = screenPosition.y + gap;
    if (left + bounds.width > surface.clientWidth - edge) left = screenPosition.x - bounds.width - gap;
    if (top + bounds.height > surface.clientHeight - edge) top = screenPosition.y - bounds.height - gap;
    left = Math.min(Math.max(edge, left), Math.max(edge, surface.clientWidth - bounds.width - edge));
    top = Math.min(Math.max(edge, top), Math.max(edge, surface.clientHeight - bounds.height - edge));
    const next = { left: Math.round(left), top: Math.round(top) };
    setActionTrayPosition((current) => current?.left === next.left && current.top === next.top ? current : next);
  }, []);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => {
      const rect = surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
      onDimensions(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [onDimensions]);

  const hasView = view !== null;
  const hasSize = size.width > 0;
  const initialFrame = survey ? defaultFrame(survey) : 0;

  // Create Aladin once the survey metadata is verified and there is a view and a laid-out container.
  useEffect(() => {
    const surface = surfaceRef.current;
    const initial = latest.current.view;
    if (!surface || !survey || !initial || !hasSize) return;
    let cancelled = false;
    let controller: AladinController | null = null;
    // A fresh host per effect run: React Strict Mode mounts twice and a late-finishing first
    // instance must never tear down the second one's DOM.
    const host = document.createElement('div');
    host.className = 'aladin-host';
    surface.appendChild(host);

    void AladinController.create({
      container: host,
      hipsUrl: SPHEREX_HIPS_URL,
      survey,
      initial: {
        ra: initial.ra,
        dec: initial.dec,
        fov: Math.min(MAX_FOV_DEGREES, fovFromScale(initial.scale, latest.current.size.width)),
        frame: initial.channel ?? initialFrame,
        grid: initial.grid,
      },
      callbacks: {
        onUserView: (next: ViewState) => {
          const width = latest.current.size.width;
          if (width > 0) latest.current.onUserView({ ra: next.ra, dec: next.dec, scale: clampScale(scaleFromFov(next.fov, width)) });
        },
        onClick: (position) => {
          const current = latest.current;
          if (!current.status.loading && !current.status.tileError) current.onSelect(position);
        },
        onDoubleClick: (position) => {
          const current = latest.current;
          controllerRef.current?.centerOn(position);
          current.onSelect(position);
          current.onCenter(position);
        },
        onHover: setCursor,
        onLoading: (loading) => {
          if (loading) setCursor(null);
          setStatus((current) => (current.loading === loading ? current : { ...current, loading }));
        },
        onTileErrors: (message) => {
          if (message) setCursor(null);
          setStatus((current) => (current.tileError === message ? current : { ...current, tileError: message }));
        },
      },
    })
      .then((created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        controller = created;
        controllerRef.current = created;
        setInitError(null);
        setReady(true);
        if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__skyViewer = created;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error('Aladin Lite failed to start', error);
        setInitError('The sky viewer could not be started in this browser (WebGL may be unavailable).');
      });

    return () => {
      cancelled = true;
      setReady(false);
      controller?.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!controller) host.remove();
    };
    // Recreate only when the verified survey changes or the viewer first becomes usable.
  }, [survey, hasView, hasSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // Application -> Aladin. Controller.setView is a no-op when Aladin is already there.
  const viewRa = view?.ra;
  const viewDec = view?.dec;
  const viewScale = view?.scale;
  useEffect(() => {
    const controller = controllerRef.current;
    if (!ready || !controller || viewRa === undefined || viewDec === undefined || viewScale === undefined || size.width <= 0) return;
    controller.setView({ ra: viewRa, dec: viewDec, fov: Math.min(MAX_FOV_DEGREES, fovFromScale(viewScale, size.width)) });
  }, [ready, viewRa, viewDec, viewScale, size.width]);

  const frame = view ? (view.channel ?? initialFrame) : initialFrame;
  useEffect(() => {
    if (ready) controllerRef.current?.setChannel(frame);
  }, [ready, frame]);

  const grid = view?.grid ?? false;
  useEffect(() => {
    if (ready) controllerRef.current?.setGrid(grid);
  }, [ready, grid]);

  const selRa = selection?.ra;
  const selDec = selection?.dec;
  useEffect(() => {
    if (!ready) return;
    controllerRef.current?.setSelection(selRa === undefined || selDec === undefined ? null : { ra: selRa, dec: selDec });
  }, [ready, selRa, selDec]);

  const boundary = selection && constellation.boundaryEnabled ? constellation.lookup.data?.boundary : null;
  useEffect(() => {
    if (ready) controllerRef.current?.setConstellationBoundary(boundary ?? null);
  }, [ready, boundary]);

  useLayoutEffect(() => {
    updateActionTrayPosition();
  }, [updateActionTrayPosition, selection?.ra, selection?.dec, view?.ra, view?.dec, view?.scale, size.width, size.height, ready, status.loading, status.tileError, constellation.lookup.status, constellation.lookup.data]);

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  const surveyUnavailable = Boolean(view && !survey && !surveyPending && surveyError);
  const showError = surveyUnavailable || Boolean(initError);
  const errorTitle = initError ? 'Sky viewer could not start' : 'SPHEREx imagery unavailable';
  const errorText = initError ?? surveyError?.message ?? 'The SPHEREx HiPS service could not be reached.';
  const showConnecting = Boolean(view && !survey && surveyPending && !showError);
  const interactive = ready && !showError;
  const canInspect = interactive && !status.loading && !status.tileError;

  return (
    <section className="viewer-frame" aria-label="SPHEREx sky viewer">
      <div
        ref={surfaceRef}
        className={`sky-viewer__surface sky-viewer__surface--aladin${interactive ? ' sky-viewer__surface--ready' : ''}`}
        role="region"
        aria-label="Sky image. Drag to pan, scroll to zoom, use arrow keys to navigate, single-click to select, or double-click to center."
        tabIndex={interactive ? 0 : -1}
        onKeyDown={(event) => {
          if (!interactive) return;
          const map = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' } as const;
          const direction = map[event.key as keyof typeof map];
          if (direction) {
            event.preventDefault();
            onKeyPan(direction);
          } else if (event.key === 'Enter' && canInspect) {
            const center = controllerRef.current?.getView();
            if (center) onSelect({ ra: center.ra, dec: center.dec });
          }
        }}
        onPointerMove={updateActionTrayPosition}
        onPointerLeave={() => setCursor(null)}
      >
        {crosshair && interactive && <div className="sky-viewer__crosshair" aria-hidden="true"><span /><span /></div>}

        {selection && canInspect && (
          <div
            ref={actionTrayRef}
            className="viewer-analysis-actions"
            role="group"
            aria-label="Selected area actions"
            style={{ left: actionTrayPosition?.left ?? 0, top: actionTrayPosition?.top ?? 0, visibility: actionTrayPosition ? 'visible' : 'hidden' }}
          >
            <div className="viewer-analysis-actions__position">
              <span>SELECTED POSITION</span>
              <strong>{formatCoordinate(selection.ra, 5)}° · {selection.dec >= 0 ? '+' : ''}{formatCoordinate(selection.dec, 5)}°</strong>
            </div>
            <ConstellationCard {...constellation} compact />
            <button className="button button--primary button--compact" type="button" onClick={onAnalyze} title="Search SIMBAD around this position">
              <Search aria-hidden="true" size={14} />{analysisRequested ? 'View analysis' : 'Analyze area'}
            </button>
            <button className="icon-button viewer-analysis-actions__copy" type="button" onClick={onCopySelection} aria-label="Copy selected coordinates" title="Copy selected coordinates">
              <Copy aria-hidden="true" size={14} />
            </button>
            <button className="icon-button viewer-analysis-actions__close" type="button" onClick={onClearSelection} aria-label="Clear selected area" title="Clear selected area">
              <X aria-hidden="true" size={14} />
            </button>
          </div>
        )}

        {!view && (
          <div className="viewer-empty">
            <span className="viewer-empty__glyph"><MousePointer2 aria-hidden="true" size={19} /></span>
            <h2>Choose a sky position</h2>
            <p>Enter ICRS coordinates or open Find to explore the NASA SPHEREx all-sky infrared map.</p>
            <span className="viewer-empty__note">No simulated stars or substitute imagery shown.</span>
          </div>
        )}

        {showConnecting && (
          <div className="viewer-empty" role="status">
            <LoaderCircle className="spin viewer-empty__loader" aria-hidden="true" size={25} />
            <h2>Connecting to SPHEREx HiPS</h2>
            <p>Reading the NASA/IPAC IRSA dataset description. This may take a few seconds.</p>
          </div>
        )}

        {showError && (
          <div className="viewer-empty viewer-empty--error" role="alert">
            <AlertCircle aria-hidden="true" size={23} />
            <h2>{errorTitle}</h2>
            <p>{errorText}</p>
            {!initError && (
              <button className="button button--secondary" type="button" onClick={onRetrySurvey}>
                <RotateCcw aria-hidden="true" size={15} /> Retry
              </button>
            )}
          </div>
        )}

        {interactive && status.loading && !status.tileError && (
          <div className="viewer-loading-pill" role="status"><LoaderCircle className="spin" aria-hidden="true" size={14} /> Loading sky imagery…</div>
        )}
        {interactive && status.tileError && (
          <div className="viewer-error-pill" role="status"><AlertCircle aria-hidden="true" size={14} /> {status.tileError}</div>
        )}

        {interactive && survey && view && (
          <div className="viewer-attribution" aria-label="Image information">
            <span>SPHEREx DR1</span><span aria-hidden="true">·</span>
            <span>{survey.tileFormat.toUpperCase()} HiPS</span><span aria-hidden="true">·</span>
            <span>{view.scale.toFixed(2)}″/px</span>
            <span className="viewer-attribution__hint">Aladin Lite · CDS</span>
          </div>
        )}
        {cursor && canInspect && (
          <div className="viewer-cursor" aria-live="off">
            Cursor · RA {formatCoordinate(cursor.ra)}° · Dec {cursor.dec >= 0 ? '+' : ''}{formatCoordinate(cursor.dec)}°
          </div>
        )}
      </div>
      {selection && constellation.boundaryEnabled && constellation.lookup.isSuccess && (
        <ConstellationOverview constellation={constellation.lookup.data} />
      )}
      <div className="viewer-instructions" aria-hidden="true">
        <span><Move size={13} /> Drag or use arrow keys to pan</span>
        <span><span aria-hidden="true">↕</span> Wheel to zoom</span>
        <span><MousePointer2 size={13} /> Move for coordinates · double-click to center</span>
      </div>
    </section>
  );
}
