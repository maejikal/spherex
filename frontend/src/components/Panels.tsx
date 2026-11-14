import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  Copy,
  Info,
  LoaderCircle,
  RotateCcw,
  Search,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { findNearbyObjects, getRandomTarget, listSuggestedTargets, resolveObjectName } from '../api/client.ts';
import type { CatalogObject, ExplorerView } from '../api/types.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';
import { calculateFieldOfView, formatCoordinate, parseCoordinateInput } from '../sky/coordinates.ts';
import { channelForFrame, channelLabel, formatWavelength } from '../sky/spherex/channels.ts';
import { SPHEREX_HIPS_URL } from '../sky/spherex/config.ts';
import type { SphereXSurveyInfo } from '../sky/spherex/properties.ts';
import { WavelengthSelector } from './WavelengthSelector.tsx';

interface FindPanelProps {
  view: ExplorerView | null;
  onNavigate: (coordinates: SkyCoordinates, label?: string) => void;
}

export function FindPanel({ view, onNavigate }: FindPanelProps) {
  const [objectName, setObjectName] = useState('');
  const [raText, setRaText] = useState('');
  const [decText, setDecText] = useState('');
  const [coordinateError, setCoordinateError] = useState<string | null>(null);

  useEffect(() => {
    if (!view) {
      setRaText('');
      setDecText('');
      return;
    }
    setRaText(String(view.ra));
    setDecText(String(view.dec));
  }, [view?.ra, view?.dec]);

  const targets = useQuery({
    queryKey: ['targets', 'suggested'],
    queryFn: ({ signal }) => listSuggestedTargets(signal),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const resolveMutation = useMutation({
    mutationFn: (name: string) => resolveObjectName(name),
    onSuccess: (object) => onNavigate(object, object.name),
  });
  const randomMutation = useMutation({
    mutationFn: () => getRandomTarget(),
    onSuccess: (target) => onNavigate(target, target.name),
  });

  const resolveName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedName = objectName.trim();
    if (requestedName) resolveMutation.mutate(requestedName);
  };

  const submitCoordinates = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCoordinateError(null);
    const result = parseCoordinateInput(raText, decText);
    if (!result.ok || !result.value) {
      setCoordinateError(result.error ?? 'Enter valid ICRS coordinates.');
      return;
    }
    onNavigate(result.value);
  };

  return (
    <div className="panel-stack find-panel-stack">
      <section className="panel-section find-name-section" aria-label="Find by object name">
        <form className="find-name-form" onSubmit={resolveName}>
          <div className="field find-name-field">
            <label className="sr-only" htmlFor="find-object-name">Object name</label>
            <div className="find-name-control">
              <div className="input-with-icon">
                <Search aria-hidden="true" size={16} />
                <input
                  id="find-object-name"
                  type="search"
                  value={objectName}
                  onChange={(event) => setObjectName(event.target.value)}
                  placeholder="Object name · e.g. M31"
                  autoComplete="off"
                  required
                />
              </div>
              <button className="button button--secondary" type="submit" disabled={resolveMutation.isPending}>
                {resolveMutation.isPending ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
                {resolveMutation.isPending ? 'Finding…' : 'Find'}
              </button>
            </div>
          </div>
          {resolveMutation.isError && <InlineError message={errorMessage(resolveMutation.error, 'Name resolver failed.')} />}
        </form>
      </section>

      <div className="find-divider" aria-hidden="true">or</div>

      <section className="panel-section" aria-labelledby="find-coordinates-heading">
        <div className="find-section-heading">
          <h3 id="find-coordinates-heading">Go to coordinates</h3>
        </div>
        <form className="form-stack find-coordinate-form" onSubmit={submitCoordinates}>
          <div className="coordinate-fields">
            <label className="field">
              <span>RA · degrees</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="359.999999999"
                step="any"
                value={raText}
                onChange={(event) => setRaText(event.target.value)}
                placeholder="0 to <360"
                aria-describedby={coordinateError ? 'coordinate-error' : undefined}
              />
            </label>
            <label className="field">
              <span>Dec · degrees</span>
              <input
                type="number"
                inputMode="decimal"
                min="-90"
                max="90"
                step="any"
                value={decText}
                onChange={(event) => setDecText(event.target.value)}
                placeholder="−90 to +90"
                aria-describedby={coordinateError ? 'coordinate-error' : undefined}
              />
            </label>
          </div>
          {coordinateError && <div id="coordinate-error"><InlineError message={coordinateError} /></div>}
          <button className="button button--primary button--full" type="submit">Go to coordinates</button>
        </form>
      </section>

      <section className="panel-section find-targets" aria-labelledby="suggested-heading">
        <div className="find-section-heading">
          <h3 id="suggested-heading">Verified destinations</h3>
          <button
            className="text-button find-random"
            type="button"
            onClick={() => randomMutation.mutate()}
            disabled={randomMutation.isPending}
          >
            {randomMutation.isPending ? 'Finding…' : 'Random'}
          </button>
        </div>
        {targets.isPending && (
          <p className="inline-status find-target-state" role="status"><LoaderCircle className="spin" aria-hidden="true" size={14} /> Checking destinations…</p>
        )}
        {targets.isError && (
          <div className="find-target-state--error">
            <InlineError message={errorMessage(targets.error, 'Could not load verified destinations.')} />
            <button className="text-button" type="button" onClick={() => void targets.refetch()}>Retry</button>
          </div>
        )}
        {targets.isSuccess && targets.data.length === 0 && (
          <p className="empty-inline find-target-state">No verified destinations available.</p>
        )}
        {targets.isSuccess && targets.data.length > 0 && (
          <ul className="target-list" aria-label="Verified destinations">
            {targets.data.map((target) => (
              <li key={target.id ?? `${target.name}-${target.ra}-${target.dec}`}>
                <button type="button" className="target-row target-row--compact" onClick={() => onNavigate(target, target.name)}>
                  <span className="target-row__name">{target.name}</span>
                  <span className="target-row__coordinates">{formatCoordinate(target.ra, 3)}°, {formatCoordinate(target.dec, 3)}°</span>
                  <ArrowRight aria-hidden="true" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {randomMutation.isError && <InlineError message={errorMessage(randomMutation.error, 'No verified covered position was returned.')} />}
      </section>
    </div>
  );
}

interface ViewPanelProps {
  view: ExplorerView | null;
  width: number;
  height: number;
  crosshair: boolean;
  survey: SphereXSurveyInfo | undefined;
  surveyPending: boolean;
  surveyError: Error | null;
  frame: number | null;
  loading: boolean;
  onChannelChange: (frame: number) => void;
  canReset: boolean;
  onZoom: (direction: 'in' | 'out') => void;
  onPan: (direction: 'north' | 'south' | 'east' | 'west') => void;
  onReset: () => void;
  onGridChange: (enabled: boolean) => void;
  onCrosshairChange: (enabled: boolean) => void;
}

export function ViewPanel({
  view,
  width,
  height,
  crosshair,
  survey,
  surveyPending,
  surveyError,
  frame,
  loading,
  onChannelChange,
  canReset,
  onZoom,
  onPan,
  onReset,
  onGridChange,
  onCrosshairChange,
}: ViewPanelProps) {
  const fieldOfView = view ? calculateFieldOfView(view.scale, width, height) : null;

  return (
    <div className="panel-stack view-panel-stack">
      {!view && <p className="view-empty-state"><Info aria-hidden="true" size={14} />Load a position to enable wavelength, zoom, pan, and grid controls.</p>}
      <WavelengthSelector
        survey={survey}
        surveyPending={surveyPending}
        surveyError={surveyError}
        frame={frame}
        loading={loading}
        disabled={!view}
        onChange={onChannelChange}
      />

      <section className="panel-section" aria-labelledby="navigate-image-heading">
        <div className="section-heading view-section-heading">
          <h3 id="navigate-image-heading">Navigate image</h3>
          <p>Smaller scale means more zoom.</p>
        </div>
        <div className="button-row">
          <button className="button button--secondary" type="button" disabled={!view} onClick={() => onZoom('out')}>
            <ZoomOut aria-hidden="true" size={15} /> Zoom out
          </button>
          <button className="button button--secondary" type="button" disabled={!view} onClick={() => onZoom('in')}>
            <ZoomIn aria-hidden="true" size={15} /> Zoom in
          </button>
          <button className="button button--quiet" type="button" disabled={!canReset} onClick={onReset} aria-label="Reset to initial center and scale">
            <RotateCcw aria-hidden="true" size={15} /> Reset
          </button>
        </div>
        <div className="compass-row" role="group" aria-label="Pan the sky">
          <button type="button" className="icon-button compass compass--north" aria-label="Pan sky north" title="Pan sky north" disabled={!view} onClick={() => onPan('north')}><ArrowUp size={15} aria-hidden="true" /></button>
          <button type="button" className="icon-button compass compass--west" aria-label="Pan sky west" title="Pan sky west" disabled={!view} onClick={() => onPan('west')}><ArrowLeft size={15} aria-hidden="true" /></button>
          <span className="compass__center" aria-hidden="true">N</span>
          <button type="button" className="icon-button compass compass--east" aria-label="Pan sky east" title="Pan sky east" disabled={!view} onClick={() => onPan('east')}><ArrowRight size={15} aria-hidden="true" /></button>
          <button type="button" className="icon-button compass compass--south" aria-label="Pan sky south" title="Pan sky south" disabled={!view} onClick={() => onPan('south')}><ArrowDown size={15} aria-hidden="true" /></button>
          <span className="fov-readout">
            <span>Field of view</span>
            <strong>{fieldOfView ? formatFieldOfView(fieldOfView.widthArcminutes, fieldOfView.heightArcminutes) : 'Unavailable'}</strong>
          </span>
        </div>
        {view && <p className="field-hint view-scale">Scale · {view.scale.toFixed(2)} arcsec/pixel</p>}
      </section>

      <section className="panel-section" aria-labelledby="overlays-heading">
        <div className="section-heading view-section-heading">
          <h3 id="overlays-heading">Overlays</h3>
        </div>
        <label className="toggle-row">
          <span><strong>Coordinate grid</strong></span>
          <input type="checkbox" checked={view?.grid ?? false} disabled={!view} onChange={(event) => onGridChange(event.target.checked)} />
        </label>
        <label className="toggle-row">
          <span><strong>Center crosshair</strong></span>
          <input type="checkbox" checked={crosshair} onChange={(event) => onCrosshairChange(event.target.checked)} />
        </label>
      </section>
    </div>
  );
}

interface InspectPanelProps {
  selection: (SkyCoordinates & { accuracy: 'projection' }) | null;
  view: ExplorerView | null;
  survey: SphereXSurveyInfo | undefined;
  loading: boolean;
  analysisEnabled: boolean;
}

export function InspectPanel({ selection, view, survey, loading, analysisEnabled }: InspectPanelProps) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const nearby = useQuery({
    queryKey: ['objects', 'nearby', selection?.ra, selection?.dec],
    queryFn: ({ signal }) => findNearbyObjects(selection as SkyCoordinates, signal),
    enabled: Boolean(selection && analysisEnabled),
    staleTime: 60 * 1000,
    retry: false,
  });

  const copyCoordinates = async () => {
    if (!selection) return;
    const value = `${formatCoordinate(selection.ra, 6)}°, ${selection.dec >= 0 ? '+' : ''}${formatCoordinate(selection.dec, 6)}°`;
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage('Selected coordinates copied.');
    } catch {
      setCopyMessage('Clipboard unavailable; coordinates are shown above.');
    }
  };

  const frame = view && survey ? (view.channel ?? survey.firstFrame) : null;
  const channel = survey && frame !== null ? channelForFrame(survey, frame) : null;

  return (
    <div className="panel-stack">
      <section className="panel-section" aria-labelledby="selection-heading">
        <div className="section-heading">
          <h3 id="selection-heading">Selected position</h3>
        </div>
        {selection ? (
          <div className="coordinate-readout">
            <div><span>RA · ICRS</span><strong>{formatCoordinate(selection.ra, 6)}°</strong></div>
            <div><span>Dec · ICRS</span><strong>{selection.dec >= 0 ? '+' : ''}{formatCoordinate(selection.dec, 6)}°</strong></div>
            <span className="status-badge">Selected</span>
          </div>
        ) : (
          <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>No point selected</strong><p>Single-click to select; double-click to center the position.</p></div></div>
        )}
      </section>

      <section className="panel-section catalogue-results" aria-labelledby="catalogue-heading">
        <div className="section-heading">
          <h3 id="catalogue-heading">Catalogue matches{selection && analysisEnabled && nearby.isSuccess && <span className="catalogue-results__count" aria-label={`${nearby.data.length} catalogue matches`}>{nearby.data.length}</span>}</h3>
          <p>SIMBAD associations, not SPHEREx detections.</p>
        </div>
        {!selection && <p className="empty-inline">Select a sky position to query SIMBAD.</p>}
        {selection && !analysisEnabled && <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>Area ready to analyze</strong><p>Choose Analyze area on the viewer to search nearby SIMBAD objects; double-click sky to center the selection.</p></div></div>}
        {selection && analysisEnabled && nearby.isPending && <p className="inline-status" role="status"><LoaderCircle className="spin" aria-hidden="true" size={15} /> Searching SIMBAD…</p>}
        {selection && analysisEnabled && nearby.isError && <InlineError message={errorMessage(nearby.error, 'Catalogue lookup failed.')} />}
        {selection && analysisEnabled && nearby.isSuccess && nearby.data.length === 0 && (
          <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>No catalogue matches returned</strong><p>SIMBAD has no objects within 30 arcseconds.</p></div></div>
        )}
        {selection && analysisEnabled && nearby.isSuccess && nearby.data.length > 0 && (
          <ul className="match-list">
            {nearby.data.map((object, index) => <MatchRow key={object.id ?? `${object.name ?? 'match'}-${object.ra}-${object.dec}-${index}`} object={object} />)}
          </ul>
        )}
        {selection && analysisEnabled && (
          <button className="button button--secondary button--full" type="button" onClick={() => void nearby.refetch()} disabled={nearby.isFetching}>
            {nearby.isFetching ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : <Search aria-hidden="true" size={15} />}
            Retry catalogue lookup
          </button>
        )}
      </section>

      <section className="panel-section" aria-labelledby="provenance-heading">
        <div className="section-heading">
          <h3 id="provenance-heading">Image provenance</h3>
        </div>
        <dl className="provenance-list">
          <ProvenanceRow label="Survey / release" value={survey ? `${survey.collection} · ${survey.title}` : 'Unavailable'} />
          <ProvenanceRow label="Wavelength" value={channel ? `${formatWavelength(channel.wavelengthUm)} · ${channelLabel(channel)}` : 'Unavailable'} />
          <ProvenanceRow label="Cube frame" value={channel && survey ? `${channel.frame} of ${survey.depth - 1} (0-based)` : 'Unavailable'} />
          <ProvenanceRow label="Requested center" value={view ? `${formatCoordinate(view.ra, 5)}°, ${view.dec >= 0 ? '+' : ''}${formatCoordinate(view.dec, 5)}°` : 'Unavailable'} />
          <ProvenanceRow label="Scale" value={view ? `${view.scale.toFixed(2)} arcsec/pixel` : 'Unavailable'} />
          <ProvenanceRow label="Tiles" value={survey ? `${survey.tileFormat.toUpperCase()} · ${survey.tileWidth}px · HiPS order ≤ ${survey.maxOrder}` : 'Unavailable'} />
          <ProvenanceRow label="Coordinate frame" value={survey ? `${survey.frame} (ICRS)` : 'Unavailable'} />
          <ProvenanceRow label="Source URL" value={survey ? SPHEREX_HIPS_URL : 'Not available'} link={Boolean(survey)} />
          <ProvenanceRow label="Observation time" value={survey ? 'Combined cube — no single epoch' : 'Unavailable'} />
          <ProvenanceRow label="Imagery status" value={loading ? 'Loading tiles…' : 'Idle'} />
        </dl>
        <button className="button button--secondary button--full" type="button" disabled={!selection} onClick={() => void copyCoordinates()}>
          {copyMessage?.includes('copied') ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
          Copy selected coordinates
        </button>
        {copyMessage && <p className="field-hint" role="status">{copyMessage}</p>}
      </section>
    </div>
  );
}

function MatchRow({ object }: { object: CatalogObject }) {
  return (
    <li className="match-row">
      <strong>{object.name ?? object.id ?? 'Catalogue object'}</strong>
      {object.objectType && <span>{object.objectType}</span>}
      <small>Object position · {formatCoordinate(object.ra, 5)}°, {object.dec >= 0 ? '+' : ''}{formatCoordinate(object.dec, 5)}°</small>
      {object.separationArcsec !== undefined && <small className="match-row__separation"><span>Separation</span><strong>{object.separationArcsec.toFixed(2)}″</strong></small>}
      {object.source && <small>Source · {object.source}</small>}
    </li>
  );
}

function ProvenanceRow({ label, value, link = false }: { label: string; value: string; link?: boolean }) {
  return (
    <div className="provenance-row">
      <dt>{label}</dt>
      <dd>{link ? <a href={value} target="_blank" rel="noreferrer">Open source</a> : value}</dd>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return <p className="inline-error" role="alert"><AlertCircle aria-hidden="true" size={15} />{message}</p>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatFieldOfView(widthArcminutes: number, heightArcminutes: number): string {
  if (widthArcminutes >= 120) return `~${(widthArcminutes / 60).toFixed(1)}° × ${(heightArcminutes / 60).toFixed(1)}°`;
  return `~${widthArcminutes.toFixed(1)}′ × ${heightArcminutes.toFixed(1)}′`;
}
