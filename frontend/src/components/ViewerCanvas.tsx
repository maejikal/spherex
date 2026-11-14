import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, MousePointer2, Move, RotateCcw } from 'lucide-react';
import { ApiError, fetchCutout } from '../api/client.ts';
import type { ExplorerView } from '../api/types.ts';
import { coordinateAtPixelOffset } from '../sky/coordinates.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';
import type { LoadedCutoutInfo } from './Panels.tsx';

interface Dimensions {
  width: number;
  height: number;
}

interface LoadedCutout extends LoadedCutoutInfo {
  key: string;
  url: string;
}

type LoadFailure = 'no-coverage' | 'invalid-response' | 'service-failure';

interface ViewerCanvasProps {
  view: ExplorerView | null;
  crosshair: boolean;
  onDimensions: (dimensions: Dimensions) => void;
  onCutoutChange: (cutout: LoadedCutoutInfo | null) => void;
  onSelect: (coordinates: SkyCoordinates) => void;
  onPanByDrag: (dragX: number, dragY: number) => void;
  onZoom: (direction: 'in' | 'out') => void;
}

const MAX_IMAGE_DIMENSION = 1536;
const MAX_CACHED_CUTOUTS = 6;

export function ViewerCanvas({ view, crosshair, onDimensions, onCutoutChange, onSelect, onPanByDrag, onZoom }: ViewerCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, LoadedCutout>());
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const wheelTimer = useRef<number | null>(null);
  const wheelDirection = useRef<'in' | 'out' | null>(null);
  const previousNavigationKey = useRef('');
  const [dimensions, setDimensions] = useState<Dimensions>({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState<LoadedCutout | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [failure, setFailure] = useState<LoadFailure | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [selectedPoint, setSelectedPoint] = useState<{ x: number; y: number } | null>(null);
  const [cursorCoordinates, setCursorCoordinates] = useState<SkyCoordinates | null>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const updateDimensions = () => {
      const rect = surface.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const rawWidth = Math.max(1, Math.round(rect.width * pixelRatio));
      const rawHeight = Math.max(1, Math.round(rect.height * pixelRatio));
      const reduction = Math.min(1, MAX_IMAGE_DIMENSION / rawWidth, MAX_IMAGE_DIMENSION / rawHeight);
      const next = {
        width: Math.max(1, Math.floor(rawWidth * reduction)),
        height: Math.max(1, Math.floor(rawHeight * reduction)),
      };
      setDimensions((current) => current.width === next.width && current.height === next.height ? current : next);
      onDimensions(next);
    };

    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [onDimensions]);

  const currentKey = view && dimensions.width > 0 && dimensions.height > 0
    ? cutoutKey(view, dimensions)
    : '';
  const navigationKey = view ? `${view.ra}:${view.dec}:${view.scale}` : '';

  useEffect(() => {
    if (previousNavigationKey.current !== navigationKey) {
      previousNavigationKey.current = navigationKey;
      setSelectedPoint(null);
    }
  }, [navigationKey]);

  useEffect(() => {
    if (!view || dimensions.width <= 0 || dimensions.height <= 0) {
      setStatus('idle');
      if (!view) onCutoutChange(null);
      return;
    }

    const key = cutoutKey(view, dimensions);
    const cached = cache.current.get(key);
    if (cached) {
      cache.current.delete(key);
      cache.current.set(key, cached);
      setLoaded(cached);
      onCutoutChange(cached);
      setFailure(null);
      setStatus('ready');
      return;
    }

    const controller = new AbortController();
    setFailure(null);
    setStatus('loading');

    void fetchCutout({ ...view, width: dimensions.width, height: dimensions.height }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const image: LoadedCutout = {
          key,
          url: URL.createObjectURL(response.blob),
          width: dimensions.width,
          height: dimensions.height,
          requestedWidth: dimensions.width,
          requestedHeight: dimensions.height,
          metadata: response.metadata,
          center: { ra: view.ra, dec: view.dec },
          scale: view.scale,
          survey: view.survey,
        };
        cache.current.set(key, image);
        while (cache.current.size > MAX_CACHED_CUTOUTS) {
          const oldestKey = cache.current.keys().next().value;
          if (oldestKey === undefined) break;
          const oldest = cache.current.get(oldestKey);
          if (oldest) URL.revokeObjectURL(oldest.url);
          cache.current.delete(oldestKey);
        }
        setLoaded(image);
        onCutoutChange(image);
        setFailure(null);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus('ready');
        if (error instanceof ApiError && error.code === 'no_coverage') {
          setFailure('no-coverage');
        } else if (error instanceof ApiError && (error.code === 'invalid_content_type' || error.code === 'invalid_image')) {
          setFailure('invalid-response');
        } else {
          setFailure('service-failure');
        }
      });

    return () => controller.abort();
  }, [currentKey, dimensions, onCutoutChange, retryCount, view]);

  useEffect(() => () => {
    for (const image of cache.current.values()) URL.revokeObjectURL(image.url);
    cache.current.clear();
  }, []);

  useEffect(() => () => {
    if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
  }, []);

  const readyForInteraction = Boolean(view && loaded && loaded.key === currentKey && status === 'ready');
  const handleSelect = (clientX: number, clientY: number) => {
    const surface = surfaceRef.current;
    if (!surface || !view || !loaded || !readyForInteraction) return;
    const rect = surface.getBoundingClientRect();
    const imageX = ((clientX - rect.left) - rect.width / 2) * loaded.width / rect.width;
    const imageY = ((clientY - rect.top) - rect.height / 2) * loaded.height / rect.height;
    try {
      onSelect(coordinateAtPixelOffset(view, imageX, imageY, view.scale));
      setSelectedPoint({ x: clientX - rect.left, y: clientY - rect.top });
    } catch {
      setFailure('invalid-response');
    }
  };

  const handlePan = (dragX: number, dragY: number) => {
    if (!readyForInteraction || !view || !loaded || !surfaceRef.current) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    onPanByDrag(dragX * loaded.width / rect.width, dragY * loaded.height / rect.height);
    setSelectedPoint(null);
  };

  const moveKeyboard = (key: string) => {
    const surface = surfaceRef.current;
    if (!surface || !loaded || !readyForInteraction) return;
    const distance = surface.clientWidth * 0.12;
    const verticalDistance = surface.clientHeight * 0.12;
    if (key === 'ArrowUp') handlePan(0, verticalDistance);
    if (key === 'ArrowDown') handlePan(0, -verticalDistance);
    if (key === 'ArrowLeft') handlePan(-distance, 0);
    if (key === 'ArrowRight') handlePan(distance, 0);
  };

  const message = failureMessage(failure);
  const imageIsCurrent = Boolean(loaded && loaded.key === currentKey);
  const brokenVisibleImage = failure === 'invalid-response' && imageIsCurrent;
  const showFullError = Boolean(view && failure && (!loaded || brokenVisibleImage));
  const showErrorPill = Boolean(view && failure && loaded && !brokenVisibleImage);
  const displayLoadedImage = Boolean(view && loaded && !brokenVisibleImage);

  return (
    <section className="viewer-frame" aria-label="SDSS DR18 image viewer">
      <div
        ref={surfaceRef}
        className={`sky-viewer__surface${readyForInteraction ? ' sky-viewer__surface--ready' : ''}`}
        role="region"
        aria-label="Sky image. Drag to pan, use arrow keys to navigate, or click to inspect approximate coordinates."
        tabIndex={readyForInteraction ? 0 : -1}
        onPointerDown={(event) => {
          if (!readyForInteraction || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        }}
        onPointerMove={(event) => {
          const active = pointer.current;
          if (!active || active.id !== event.pointerId) {
            const surface = surfaceRef.current;
            if (!surface || !view || !loaded || !readyForInteraction) return;
            const rect = surface.getBoundingClientRect();
            const imageX = ((event.clientX - rect.left) - rect.width / 2) * loaded.width / rect.width;
            const imageY = ((event.clientY - rect.top) - rect.height / 2) * loaded.height / rect.height;
            try {
              setCursorCoordinates(coordinateAtPixelOffset(view, imageX, imageY, view.scale));
            } catch {
              setCursorCoordinates(null);
            }
            return;
          }
          const x = event.clientX - active.x;
          const y = event.clientY - active.y;
          if (Math.hypot(x, y) > 4) active.moved = true;
          setCursorCoordinates(null);
          setDragOffset(active.moved ? { x, y } : { x: 0, y: 0 });
        }}
        onPointerUp={(event) => {
          const active = pointer.current;
          if (!active || active.id !== event.pointerId) return;
          const x = event.clientX - active.x;
          const y = event.clientY - active.y;
          if (active.moved) handlePan(x, y);
          else handleSelect(event.clientX, event.clientY);
          pointer.current = null;
          setDragOffset({ x: 0, y: 0 });
        }}
        onPointerCancel={() => {
          pointer.current = null;
          setDragOffset({ x: 0, y: 0 });
          setCursorCoordinates(null);
        }}
        onPointerLeave={() => setCursorCoordinates(null)}
        onLostPointerCapture={() => {
          pointer.current = null;
          setDragOffset({ x: 0, y: 0 });
        }}
        onWheel={(event) => {
          if (!readyForInteraction) return;
          event.preventDefault();
          wheelDirection.current = event.deltaY < 0 ? 'in' : 'out';
          if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current);
          wheelTimer.current = window.setTimeout(() => {
            if (wheelDirection.current) onZoom(wheelDirection.current);
            wheelDirection.current = null;
            wheelTimer.current = null;
          }, 140);
        }}
        onKeyDown={(event) => {
          if (event.key.startsWith('Arrow')) {
            event.preventDefault();
            moveKeyboard(event.key);
          } else if (event.key === 'Enter' && readyForInteraction && surfaceRef.current) {
            const rect = surfaceRef.current.getBoundingClientRect();
            handleSelect(rect.left + rect.width / 2, rect.top + rect.height / 2);
          }
        }}
      >
        {displayLoadedImage && loaded && view && (
          <div className="sky-viewer__image-layer" style={{ transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)` }}>
            <img
              className="sky-viewer__image"
              src={loaded.url}
              alt={`SDSS DR18 cutout requested at RA ${loaded.center.ra.toFixed(5)}°, Dec ${loaded.center.dec.toFixed(5)}°`}
              draggable={false}
              onLoad={(event) => {
                const actualWidth = event.currentTarget.naturalWidth;
                const actualHeight = event.currentTarget.naturalHeight;
                if (!actualWidth || !actualHeight || (actualWidth === loaded.width && actualHeight === loaded.height)) return;
                const decodedImage = { ...loaded, width: actualWidth, height: actualHeight };
                cache.current.set(loaded.key, decodedImage);
                setLoaded(decodedImage);
                onCutoutChange(decodedImage);
              }}
              onError={() => {
                if (loaded.key === currentKey) {
                  cache.current.delete(loaded.key);
                  URL.revokeObjectURL(loaded.url);
                  setLoaded(null);
                  onCutoutChange(null);
                  setFailure('invalid-response');
                  setStatus('ready');
                }
              }}
            />
          </div>
        )}

        {crosshair && displayLoadedImage && <div className="sky-viewer__crosshair" aria-hidden="true"><span /><span /></div>}
        {selectedPoint && displayLoadedImage && <span className="sky-viewer__selection" style={{ left: selectedPoint.x, top: selectedPoint.y }} aria-hidden="true" />}

        {!view && (
          <div className="viewer-empty">
            <span className="viewer-empty__glyph"><MousePointer2 aria-hidden="true" size={19} /></span>
            <h2>Choose a verified sky position</h2>
            <p>Enter ICRS coordinates or open Find to load a coverage-checked SDSS DR18 cutout.</p>
            <span className="viewer-empty__note">No simulated stars or substitute imagery shown.</span>
          </div>
        )}

        {view && !loaded && status === 'loading' && (
          <div className="viewer-empty" role="status">
            <LoaderCircle className="spin viewer-empty__loader" aria-hidden="true" size={25} />
            <h2>Requesting SDSS DR18 cutout</h2>
            <p>Keeping sky data source-backed. This may take a few seconds.</p>
          </div>
        )}

        {showFullError && (
          <div className="viewer-empty viewer-empty--error" role="alert">
            <AlertCircle aria-hidden="true" size={23} />
            <h2>{failure === 'no-coverage' ? 'No SDSS coverage returned' : 'Cutout could not be loaded'}</h2>
            <p>{message}</p>
            <button className="button button--secondary" type="button" onClick={() => setRetryCount((count) => count + 1)}>
              <RotateCcw aria-hidden="true" size={15} /> Retry
            </button>
          </div>
        )}

        {view && loaded && status === 'loading' && (
          <div className="viewer-loading-pill" role="status"><LoaderCircle className="spin" aria-hidden="true" size={14} /> Loading requested view</div>
        )}
        {showErrorPill && (
          <div className="viewer-error-pill" role="status">
            <AlertCircle aria-hidden="true" size={14} /> {message}
            <button type="button" className="text-button" onClick={() => setRetryCount((count) => count + 1)}>Retry</button>
          </div>
        )}

        {displayLoadedImage && loaded && view && (
          <div className="viewer-attribution" aria-label="Image information">
            <span>SDSS DR18</span><span aria-hidden="true">·</span>
            <span>{loaded.width} × {loaded.height}</span><span aria-hidden="true">·</span>
            <span>{loaded.scale.toFixed(3)}″/px</span>
            <span className="viewer-attribution__hint">JPEG coordinates approximate</span>
          </div>
        )}
        {cursorCoordinates && displayLoadedImage && view && (
          <div className="viewer-cursor" aria-live="off">
            Cursor · RA {cursorCoordinates.ra.toFixed(5)}° · Dec {cursorCoordinates.dec >= 0 ? '+' : ''}{cursorCoordinates.dec.toFixed(5)}° · approx.
          </div>
        )}
      </div>
      <div className="viewer-instructions" aria-hidden="true">
        <span><Move size={13} /> Drag or use arrow keys to pan</span>
        <span><span aria-hidden="true">↕</span> Wheel to zoom</span>
        <span><MousePointer2 size={13} /> Click image to inspect approximate coordinates</span>
      </div>
    </section>
  );
}

function cutoutKey(view: ExplorerView, dimensions: Dimensions): string {
  return [view.ra, view.dec, view.scale, view.survey, view.grid ? 1 : 0, dimensions.width, dimensions.height].join(':');
}

function failureMessage(failure: LoadFailure | null): string {
  if (failure === 'no-coverage') return 'No SDSS DR18 image coverage returned at this position. Try a verified destination.';
  if (failure === 'invalid-response') return 'Image API returned invalid content. No image was displayed.';
  if (failure === 'service-failure') return 'Image service failed or is unavailable. Current image stays visible when possible.';
  return '';
}
