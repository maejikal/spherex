import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, MousePointer2, Move, RotateCcw } from 'lucide-react';
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
  crosshair: boolean;
  onDimensions: (dimensions: { width: number; height: number }) => void;
  /** Pan/zoom made by the user inside Aladin, reported after it settles. */
  onUserView: (view: { ra: number; dec: number; scale: number }) => void;
  onSelect: (coordinates: SkyCoordinates) => void;
  onKeyPan: (direction: 'north' | 'south' | 'east' | 'west') => void;
  onStatus: (status: ViewerStatus) => void;
}

const MAX_FOV_DEGREES = 360;

export function AladinSkyViewer({
  view, survey, surveyPending, surveyError, onRetrySurvey, selection, crosshair,
  onDimensions, onUserView, onSelect, onKeyPan, onStatus,
}: AladinSkyViewerProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AladinController | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<SkyCoordinates | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ loading: false, tileError: null });

  // Latest props for long-lived Aladin callbacks (avoids stale closures and re-creating Aladin).
  const latest = useRef({ view, size, onUserView, onSelect, onStatus });
  latest.current = { view, size, onUserView, onSelect, onStatus };

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
        onClick: (position) => latest.current.onSelect(position),
        onHover: setCursor,
        onLoading: (loading) => setStatus((current) => (current.loading === loading ? current : { ...current, loading })),
        onTileErrors: (message) => setStatus((current) => (current.tileError === message ? current : { ...current, tileError: message })),
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

  useEffect(() => {
    onStatus(status);
  }, [status, onStatus]);

  const surveyUnavailable = Boolean(view && !survey && !surveyPending && surveyError);
  const showError = surveyUnavailable || Boolean(initError);
  const errorTitle = initError ? 'Sky viewer could not start' : 'SPHEREx imagery unavailable';
  const errorText = initError ?? surveyError?.message ?? 'The SPHEREx HiPS service could not be reached.';
  const showConnecting = Boolean(view && !survey && surveyPending && !showError);
  const interactive = ready && !showError;

  return (
    <section className="viewer-frame" aria-label="SPHEREx sky viewer">
      <div
        ref={surfaceRef}
        className={`sky-viewer__surface sky-viewer__surface--aladin${interactive ? ' sky-viewer__surface--ready' : ''}`}
        role="region"
        aria-label="Sky image. Drag to pan, scroll to zoom, use arrow keys to navigate, or click to inspect coordinates."
        tabIndex={interactive ? 0 : -1}
        onKeyDown={(event) => {
          if (!interactive) return;
          const map = { ArrowUp: 'north', ArrowDown: 'south', ArrowLeft: 'west', ArrowRight: 'east' } as const;
          const direction = map[event.key as keyof typeof map];
          if (direction) {
            event.preventDefault();
            onKeyPan(direction);
          } else if (event.key === 'Enter') {
            const center = controllerRef.current?.getView();
            if (center) onSelect({ ra: center.ra, dec: center.dec });
          }
        }}
        onPointerLeave={() => setCursor(null)}
      >
        {crosshair && interactive && <div className="sky-viewer__crosshair" aria-hidden="true"><span /><span /></div>}

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
        {cursor && interactive && (
          <div className="viewer-cursor" aria-live="off">
            Cursor · RA {formatCoordinate(cursor.ra)}° · Dec {cursor.dec >= 0 ? '+' : ''}{formatCoordinate(cursor.dec)}°
          </div>
        )}
      </div>
      <div className="viewer-instructions" aria-hidden="true">
        <span><Move size={13} /> Drag or use arrow keys to pan</span>
        <span><span aria-hidden="true">↕</span> Wheel to zoom</span>
        <span><MousePointer2 size={13} /> Click the sky to inspect coordinates</span>
      </div>
    </section>
  );
}
