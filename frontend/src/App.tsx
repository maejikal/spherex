import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Compass, Eye, Search, Share2, SlidersHorizontal, Telescope } from 'lucide-react';
import { getApiHealth } from './api/client.ts';
import type { ExplorerView } from './api/types.ts';
import { InspectPanel, FindPanel, ViewPanel, type LoadedCutoutInfo } from './components/Panels.tsx';
import { ToolWindow } from './components/ToolWindow.tsx';
import { ViewerCanvas } from './components/ViewerCanvas.tsx';
import {
  DEFAULT_SCALE_ARCSEC_PER_PIXEL,
  formatCoordinate,
  panCenterByDrag,
  zoomScale,
} from './sky/coordinates.ts';
import type { SkyCoordinates } from './sky/coordinates.ts';
import { parseViewSearch, serializeViewSearch } from './state/urlView.ts';
import { useExplorerStore } from './state/explorerStore.ts';

type PanelId = 'find' | 'view' | 'inspect';
type PanelVisibility = Record<PanelId, boolean>;

export default function App() {
  const view = useExplorerStore((state) => state.view);
  const selection = useExplorerStore((state) => state.selection);
  const crosshair = useExplorerStore((state) => state.crosshair);
  const urlUpdateMode = useExplorerStore((state) => state.urlUpdateMode);
  const urlRevision = useExplorerStore((state) => state.urlRevision);
  const setView = useExplorerStore((state) => state.setView);
  const setSelection = useExplorerStore((state) => state.setSelection);
  const setGrid = useExplorerStore((state) => state.setGrid);
  const setCrosshair = useExplorerStore((state) => state.setCrosshair);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const [homeView, setHomeView] = useState<ExplorerView | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1024, height: 768 });
  const [cutoutInfo, setCutoutInfo] = useState<LoadedCutoutInfo | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [shareFallback, setShareFallback] = useState<string | null>(null);
  const [panels, setPanels] = useState<PanelVisibility>(() => {
    const isNarrow = window.matchMedia('(max-width: 760px)').matches;
    return { find: true, view: !isNarrow, inspect: !isNarrow };
  });

  const health = useQuery({
    queryKey: ['api', 'health'],
    queryFn: ({ signal }) => getApiHealth(signal),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });

  useEffect(() => {
    const initialView = parseViewSearch(window.location.search);
    setView(initialView, 'none');
    setHomeView(initialView);
  }, [setView]);

  useEffect(() => {
    if (urlUpdateMode === 'none' || urlRevision === 0) return;
    const timeout = window.setTimeout(() => {
      if (!view) return;
      const search = serializeViewSearch(view, window.location.search);
      const nextUrl = `${window.location.pathname}${search}${window.location.hash}`;
      if (urlUpdateMode === 'push') window.history.pushState(null, '', nextUrl);
      else window.history.replaceState(null, '', nextUrl);
    }, 360);
    return () => window.clearTimeout(timeout);
  }, [urlRevision, urlUpdateMode, view]);

  useEffect(() => {
    const handlePopState = () => {
      const previousView = parseViewSearch(window.location.search);
      setView(previousView, 'none');
      setHomeView(previousView);
      setSelection(null);
      setAnnouncement(null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setSelection, setView]);

  const updateDimensions = useCallback((next: { width: number; height: number }) => {
    setDimensions((current) => current.width === next.width && current.height === next.height ? current : next);
  }, []);

  const updateCutoutInfo = useCallback((next: LoadedCutoutInfo | null) => {
    setCutoutInfo((current) => sameCutoutInfo(current, next) ? current : next);
  }, []);

  const navigateTo = useCallback((coordinates: SkyCoordinates, label?: string) => {
    const nextView: ExplorerView = {
      ...coordinates,
      scale: DEFAULT_SCALE_ARCSEC_PER_PIXEL,
      survey: 'sdss-dr18',
      grid: useExplorerStore.getState().view?.grid ?? false,
    };
    setView(nextView, 'push');
    setHomeView(nextView);
    setSelection(null);
    setAnnouncement(label
      ? `Requested ${label} at RA ${formatCoordinate(nextView.ra, 4)}°, Dec ${formatCoordinate(nextView.dec, 4)}°.`
      : `Requested RA ${formatCoordinate(nextView.ra, 4)}°, Dec ${formatCoordinate(nextView.dec, 4)}°.`);
    setShareFallback(null);
  }, [setSelection, setView]);

  const panByDrag = useCallback((dragX: number, dragY: number) => {
    const current = useExplorerStore.getState().view;
    if (!current) return;
    const center = panCenterByDrag(current, current.scale, dragX, dragY);
    const next = { ...current, ...center };
    setView(next, 'push');
    setSelection(null);
    setAnnouncement(`View centered at RA ${formatCoordinate(next.ra, 4)}°, Dec ${formatCoordinate(next.dec, 4)}°.`);
  }, [setSelection, setView]);

  const panDirection = useCallback((direction: 'north' | 'south' | 'east' | 'west') => {
    const amountX = dimensions.width * 0.18;
    const amountY = dimensions.height * 0.18;
    const movement = {
      north: [0, amountY],
      south: [0, -amountY],
      east: [amountX, 0],
      west: [-amountX, 0],
    } satisfies Record<typeof direction, [number, number]>;
    panByDrag(...movement[direction]);
  }, [dimensions.height, dimensions.width, panByDrag]);

  const zoom = useCallback((direction: 'in' | 'out') => {
    const current = useExplorerStore.getState().view;
    if (!current) return;
    const next = { ...current, scale: zoomScale(current.scale, direction) };
    setView(next, 'push');
    setAnnouncement(`Scale ${next.scale.toFixed(3)} arcseconds per pixel.`);
  }, [setView]);

  const resetView = useCallback(() => {
    if (!homeView) return;
    const current = useExplorerStore.getState().view;
    const reset = { ...homeView, grid: current?.grid ?? homeView.grid };
    setView(reset, 'push');
    setSelection(null);
    setAnnouncement('View reset to initial center and scale.');
  }, [homeView, setSelection, setView]);

  const selectPosition = useCallback((coordinates: SkyCoordinates) => {
    setSelection({ ...coordinates, accuracy: 'approximate' });
    setAnnouncement(`Approximate clicked position: RA ${formatCoordinate(coordinates.ra, 5)}°, Dec ${formatCoordinate(coordinates.dec, 5)}°.`);
    setPanels((current) => ({ ...current, inspect: true }));
  }, [setSelection]);

  const togglePanel = (panel: PanelId) => {
    setPanels((current) => ({ ...current, [panel]: !current[panel] }));
  };

  const shareView = async () => {
    if (!view) return;
    const search = serializeViewSearch(view, window.location.search);
    const link = `${window.location.origin}${window.location.pathname}${search}${window.location.hash}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable.');
      await navigator.clipboard.writeText(link);
      setAnnouncement('Shareable view link copied.');
      setShareFallback(null);
    } catch {
      setShareFallback(link);
      setAnnouncement('Clipboard unavailable. Copy link from the field.');
    }
  };

  const apiStatus = health.isPending ? 'Checking API' : health.isError ? 'API unavailable' : 'API connected';
  const apiStatusClass = health.isError ? 'api-status api-status--offline' : health.isSuccess ? 'api-status api-status--online' : 'api-status';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark"><Telescope aria-hidden="true" size={20} /></span>
          <div>
            <h1>Sky Explorer</h1>
            <p>Interactive sky viewer</p>
          </div>
        </div>
        <span className="survey-badge">SDSS DR18</span>
        <div className="topbar__spacer" />
        <div className="tool-toolbar" role="group" aria-label="Explorer tools">
          <ToolbarButton id="find" label="Find" active={panels.find} onClick={() => togglePanel('find')}><Search size={16} aria-hidden="true" /></ToolbarButton>
          <ToolbarButton id="view" label="View" active={panels.view} onClick={() => togglePanel('view')}><SlidersHorizontal size={16} aria-hidden="true" /></ToolbarButton>
          <ToolbarButton id="inspect" label="Inspect" active={panels.inspect} onClick={() => togglePanel('inspect')}><Eye size={16} aria-hidden="true" /></ToolbarButton>
          <button className="button button--secondary toolbar-share" type="button" onClick={() => void shareView()} disabled={!view} aria-describedby="share-hint">
            <Share2 size={15} aria-hidden="true" /><span>Share view</span>
          </button>
        </div>
        <div className={apiStatusClass} title="FastAPI connection status">
          <Activity aria-hidden="true" size={14} />
          <span>{apiStatus}</span>
        </div>
        <span id="share-hint" className="sr-only">A validated view URL is copied when a position is loaded.</span>
        {shareFallback && (
          <div className="share-fallback">
            <label htmlFor="share-link">Copy share link</label>
            <input id="share-link" readOnly value={shareFallback} onFocus={(event) => event.currentTarget.select()} />
          </div>
        )}
      </header>

      <main className="workspace" ref={workspaceRef} aria-label="Interactive sky explorer workspace">
        <ViewerCanvas
          view={view}
          crosshair={crosshair}
          onDimensions={updateDimensions}
          onCutoutChange={updateCutoutInfo}
          onSelect={selectPosition}
          onPanByDrag={panByDrag}
          onZoom={zoom}
        />

        <ToolWindow
          id="find"
          title="Find a position"
          subtitle="Coordinates · verified targets · object resolver"
          open={panels.find}
          placement="left-top"
          workspaceRef={workspaceRef}
          onClose={() => setPanels((current) => ({ ...current, find: false }))}
        >
          <FindPanel view={view} onNavigate={navigateTo} />
        </ToolWindow>

        <ToolWindow
          id="view"
          title="View controls"
          subtitle="Pan · zoom · source-supported overlays"
          open={panels.view}
          placement="left-bottom"
          workspaceRef={workspaceRef}
          onClose={() => setPanels((current) => ({ ...current, view: false }))}
        >
          <ViewPanel
            view={view}
            width={dimensions.width}
            height={dimensions.height}
            crosshair={crosshair}
            canReset={Boolean(homeView && view)}
            onZoom={zoom}
            onPan={panDirection}
            onReset={resetView}
            onGridChange={setGrid}
            onCrosshairChange={setCrosshair}
          />
        </ToolWindow>

        <ToolWindow
          id="inspect"
          title="Inspect position"
          subtitle="Clicked coordinates · catalogue · provenance"
          open={panels.inspect}
          placement="right-top"
          workspaceRef={workspaceRef}
          onClose={() => setPanels((current) => ({ ...current, inspect: false }))}
        >
          <InspectPanel selection={selection} cutout={cutoutInfo} />
        </ToolWindow>

        {announcement && <p className="workspace-announcement" role="status" aria-live="polite">{announcement}</p>}
      </main>
      <footer className="app-footer">
        <span><Compass aria-hidden="true" size={13} /> ICRS / equatorial coordinates</span>
        <span>SDSS JPEG cutout geometry approximate · no WCS claim</span>
        <span className="app-footer__future">SPHEREx data integration planned separately</span>
      </footer>
    </div>
  );
}

function ToolbarButton({
  id,
  label,
  active,
  onClick,
  children,
}: {
  id: PanelId;
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      className={`button button--secondary toolbar-tool${active ? ' toolbar-tool--active' : ''}`}
      type="button"
      aria-controls={id}
      aria-expanded={active}
      onClick={onClick}
      title={`${active ? 'Close' : 'Open'} ${label} window`}
    >
      {children}<span>{label}</span>
    </button>
  );
}

function sameCutoutInfo(left: LoadedCutoutInfo | null, right: LoadedCutoutInfo | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const metadataMatches = Object.keys(left.metadata).every((key) =>
    left.metadata[key as keyof typeof left.metadata] === right.metadata[key as keyof typeof right.metadata]);
  return left.width === right.width && left.height === right.height &&
    left.requestedWidth === right.requestedWidth && left.requestedHeight === right.requestedHeight && metadataMatches &&
    left.scale === right.scale && left.survey === right.survey &&
    left.center.ra === right.center.ra && left.center.dec === right.center.dec;
}
