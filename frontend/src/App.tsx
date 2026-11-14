import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Compass, Eye, Search, Share2, SlidersHorizontal, Telescope } from 'lucide-react';
import { getApiHealth } from './api/client.ts';
import type { ExplorerView } from './api/types.ts';
import { AladinSkyViewer, type ViewerStatus } from './components/AladinSkyViewer.tsx';
import { InspectPanel, FindPanel, ViewPanel } from './components/Panels.tsx';
import { ToolWindow } from './components/ToolWindow.tsx';
import {
  DEFAULT_SCALE_ARCSEC_PER_PIXEL,
  formatCoordinate,
  panCenterByDrag,
  zoomScale,
} from './sky/coordinates.ts';
import type { SkyCoordinates } from './sky/coordinates.ts';
import { defaultFrame } from './sky/spherex/channels.ts';
import { SPHEREX_HIPS_URL, SPHEREX_SURVEY_ID } from './sky/spherex/config.ts';
import { fetchSurveyInfo } from './sky/spherex/properties.ts';
import { parseViewSearch, serializeViewSearch } from './state/urlView.ts';
import { initialPanels, raise, togglePanel as toggleVisibility, zIndexFor } from './state/windows.ts';
import type { PanelId, PanelVisibility } from './state/windows.ts';
import { useExplorerStore } from './state/explorerStore.ts';
import { sameSkyView } from './state/viewEquality.ts';


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
  // Presentation only: switching layouts never replaces the viewer or its celestial state.
  const [layout, setLayout] = useState<'floating' | 'docked'>('floating');
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const movableTools = layout === 'floating' && !compact;
  const [homeView, setHomeView] = useState<ExplorerView | null>(null);
  const [dimensions, setDimensions] = useState({ width: 1024, height: 768 });
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>({ loading: false, tileError: null });
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [shareFallback, setShareFallback] = useState<string | null>(null);
  const [analysisRequested, setAnalysisRequested] = useState(false);
  // A new session opens only Find. Nothing below reopens View or Inspect except the user (toolbar, or clicking the sky).
  const [panels, setPanels] = useState<PanelVisibility>(initialPanels);
  const [windowOrder, setWindowOrder] = useState<PanelId[]>(['find', 'view', 'inspect']);
  const bringToFront = useCallback((id: PanelId) => setWindowOrder((order) => raise(order, id)), []);

  useEffect(() => {
    const narrowViewport = window.matchMedia('(max-width: 760px)');
    const keepOnePanelOpen = () => {
      setCompact(narrowViewport.matches);
      if (!narrowViewport.matches) return;
      setPanels((current) => {
        const openPanels = (['find', 'view', 'inspect'] as const).filter((panel) => current[panel]);
        if (openPanels.length < 2) return current;
        const next: PanelVisibility = { find: false, view: false, inspect: false };
        next[openPanels[0] ?? 'find'] = true;
        return next;
      });
    };
    keepOnePanelOpen();
    narrowViewport.addEventListener('change', keepOnePanelOpen);
    return () => narrowViewport.removeEventListener('change', keepOnePanelOpen);
  }, []);

  const health = useQuery({
    queryKey: ['api', 'health'],
    queryFn: ({ signal }) => getApiHealth(signal),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });

  // Dataset description verified against NASA/IPAC IRSA; supplies the real wavelength table.
  const survey = useQuery({
    queryKey: ['spherex', 'hips-properties'],
    queryFn: ({ signal }) => fetchSurveyInfo(SPHEREX_HIPS_URL, signal),
    staleTime: 60 * 60 * 1000,
    retry: 1,
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
      setAnalysisRequested(false);
      setAnnouncement(null);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [setSelection, setView]);

  const updateDimensions = useCallback((next: { width: number; height: number }) => {
    setDimensions((current) => current.width === next.width && current.height === next.height ? current : next);
  }, []);

  const updateViewerStatus = useCallback((next: ViewerStatus) => {
    setViewerStatus((current) => (current.loading === next.loading && current.tileError === next.tileError ? current : next));
  }, []);

  const navigateTo = useCallback((coordinates: SkyCoordinates, label?: string) => {
    const nextView: ExplorerView = {
      ...coordinates,
      scale: DEFAULT_SCALE_ARCSEC_PER_PIXEL,
      survey: SPHEREX_SURVEY_ID,
      grid: useExplorerStore.getState().view?.grid ?? false,
      channel: useExplorerStore.getState().view?.channel ?? null,
    };
    setView(nextView, 'push');
    setHomeView(nextView);
    // Keep a cross marker on the requested position after recentering.
    setSelection({ ...coordinates, accuracy: 'projection' });
    setAnalysisRequested(false);
    setAnnouncement(label
      ? `Requested ${label} at RA ${formatCoordinate(nextView.ra, 4)}°, Dec ${formatCoordinate(nextView.dec, 4)}°.`
      : `Requested RA ${formatCoordinate(nextView.ra, 4)}°, Dec ${formatCoordinate(nextView.dec, 4)}°.`);
    setShareFallback(null);
  }, [setSelection, setView]);

  // Pan/zoom made inside Aladin by the user. `replace` keeps continuous panning from flooding history.
  const applyViewerView = useCallback((next: { ra: number; dec: number; scale: number }) => {
    const current = useExplorerStore.getState().view;
    if (!current || sameSkyView(current, next)) return;
    const raDistance = Math.abs(((current.ra - next.ra + 540) % 360) - 180);
    if (raDistance > 1e-6 || Math.abs(current.dec - next.dec) > 1e-6) {
      setSelection(null);
      setAnalysisRequested(false);
    }
    setView({ ...current, ...next }, 'replace');
  }, [setSelection, setView]);

  const changeChannel = useCallback((frame: number) => {
    const current = useExplorerStore.getState().view;
    if (!current) return;
    const info = survey.data;
    const channel = info ? info.wavelengthsUm[frame] : undefined;
    setView({ ...current, channel: frame }, 'push');
    if (channel !== undefined) setAnnouncement(`Wavelength ${channel.toFixed(3)} micrometres (channel ${frame}).`);
  }, [setView, survey.data]);

  const panByDrag = useCallback((dragX: number, dragY: number) => {
    const current = useExplorerStore.getState().view;
    if (!current) return;
    const center = panCenterByDrag(current, current.scale, dragX, dragY);
    const next = { ...current, ...center };
    setView(next, 'push');
    setSelection(null);
    setAnalysisRequested(false);
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
    setAnalysisRequested(false);
    setAnnouncement('View reset to initial center and scale.');
  }, [homeView, setSelection, setView]);

  const selectPosition = useCallback((coordinates: SkyCoordinates) => {
    setSelection({ ...coordinates, accuracy: 'projection' });
    setAnalysisRequested(false);
    setAnnouncement(`Selected position: RA ${formatCoordinate(coordinates.ra, 5)}°, Dec ${formatCoordinate(coordinates.dec, 5)}°. Double-click to center; choose Analyze area to search nearby SIMBAD objects.`);
  }, [setSelection]);

  const centerPosition = useCallback((coordinates: SkyCoordinates) => {
    const current = useExplorerStore.getState().view;
    if (!current) return;
    const raDistance = Math.abs(((current.ra - coordinates.ra + 540) % 360) - 180);
    if (raDistance > 1e-6 || Math.abs(current.dec - coordinates.dec) > 1e-6) {
      setView({ ...current, ...coordinates }, 'push');
    }
    setAnnouncement(`Centered view at RA ${formatCoordinate(coordinates.ra, 5)}°, Dec ${formatCoordinate(coordinates.dec, 5)}°.`);
    setShareFallback(null);
  }, [setView]);

  const analyzeSelection = useCallback(() => {
    const selected = useExplorerStore.getState().selection;
    if (!selected) return;
    setAnalysisRequested(true);
    setPanels((current) => {
      if (window.matchMedia('(max-width: 760px)').matches) {
        return { find: false, view: false, inspect: true };
      }
      return { ...current, inspect: true };
    });
    setWindowOrder((order) => raise(order, 'inspect'));
    setAnnouncement(`Searching SIMBAD around RA ${formatCoordinate(selected.ra, 5)}°, Dec ${formatCoordinate(selected.dec, 5)}°.`);
  }, []);

  const copySelection = useCallback(async () => {
    const selected = useExplorerStore.getState().selection;
    if (!selected) return;
    const value = `${formatCoordinate(selected.ra, 6)}°, ${selected.dec >= 0 ? '+' : ''}${formatCoordinate(selected.dec, 6)}°`;
    try {
      await navigator.clipboard.writeText(value);
      setAnnouncement('Selected coordinates copied.');
    } catch {
      setAnnouncement(`Selected coordinates: RA ${formatCoordinate(selected.ra, 6)}°, Dec ${selected.dec >= 0 ? '+' : ''}${formatCoordinate(selected.dec, 6)}°.`);
    }
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setAnalysisRequested(false);
  }, [setSelection]);

  const togglePanel = (panel: PanelId) => {
    // Opening a window brings it to the front; closing one leaves others untouched.
    if (!panels[panel]) setWindowOrder((order) => raise(order, panel));
    setPanels((current) => toggleVisibility(current, panel, compact));
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
        <span className="survey-badge">SPHEREx DR1</span>
        <div className="topbar__spacer" />
        {!compact && (
          <fieldset className="layout-switch">
            <legend className="sr-only">Workspace layout</legend>
            <span className="layout-switch__label" aria-hidden="true">Layout</span>
            {(['floating', 'docked'] as const).map((value) => (
              <label key={value} className={`layout-choice${layout === value ? ' layout-choice--active' : ''}`}>
                <input type="radio" name="workspace-layout" value={value} checked={layout === value} onChange={() => setLayout(value)} />
                <span>{value === 'floating' ? 'Floating' : 'Docked'}</span>
              </label>
            ))}
          </fieldset>
        )}
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

      <main
        className={`workspace workspace--${layout}${compact ? ' workspace--compact' : ''}`}
        data-left-open={panels.find || panels.view}
        data-left-stacked={panels.find && panels.view}
        data-inspect-open={panels.inspect}
        ref={workspaceRef}
        aria-label="Interactive sky explorer workspace"
      >
        <AladinSkyViewer
          view={view}
          survey={survey.data}
          surveyPending={survey.isPending}
          surveyError={survey.error}
          onRetrySurvey={() => void survey.refetch()}
          selection={selection}
          analysisRequested={analysisRequested}
          crosshair={crosshair}
          onDimensions={updateDimensions}
          onUserView={applyViewerView}
          onSelect={selectPosition}
          onCenter={centerPosition}
          onAnalyze={analyzeSelection}
          onCopySelection={copySelection}
          onClearSelection={clearSelection}
          onKeyPan={panDirection}
          onStatus={updateViewerStatus}
        />

        <ToolWindow
          id="find"
          title="Find a position"
          open={panels.find}
          zIndex={zIndexFor(windowOrder, 'find')}
          onFocus={() => bringToFront('find')}
          placement="left-top"
          movable={movableTools}
          workspaceRef={workspaceRef}
          onClose={() => setPanels((current) => ({ ...current, find: false }))}
        >
          <FindPanel view={view} onNavigate={navigateTo} />
        </ToolWindow>

        <ToolWindow
          id="view"
          title="View controls"
          open={panels.view}
          zIndex={zIndexFor(windowOrder, 'view')}
          onFocus={() => bringToFront('view')}
          placement="beside"
          anchorId="find"
          movable={movableTools}
          workspaceRef={workspaceRef}
          onClose={() => setPanels((current) => ({ ...current, view: false }))}
        >
          <ViewPanel
            view={view}
            width={dimensions.width}
            height={dimensions.height}
            crosshair={crosshair}
            survey={survey.data}
            surveyPending={survey.isPending}
            surveyError={survey.error}
            frame={view && survey.data ? (view.channel ?? defaultFrame(survey.data)) : null}
            loading={viewerStatus.loading}
            onChannelChange={changeChannel}
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
          open={panels.inspect}
          zIndex={zIndexFor(windowOrder, 'inspect')}
          onFocus={() => bringToFront('inspect')}
          placement="right-top"
          movable={movableTools}
          workspaceRef={workspaceRef}
          onClose={() => setPanels((current) => ({ ...current, inspect: false }))}
        >
          <InspectPanel selection={selection} view={view} survey={survey.data} loading={viewerStatus.loading} analysisEnabled={analysisRequested} />
        </ToolWindow>

        {announcement && <p className="workspace-announcement" role="status" aria-live="polite">{announcement}</p>}
      </main>
      <footer className="app-footer">
        <span><Compass aria-hidden="true" size={13} /> ICRS / equatorial coordinates</span>
        <span>SPHEREx DR1 all-sky cube · NASA/IPAC IRSA HiPS · rendered with Aladin Lite (CDS)</span>
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
