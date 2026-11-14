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
  Crosshair,
  Grid2X2,
  Info,
  LoaderCircle,
  RotateCcw,
  Search,
  Target,
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
  const [notice, setNotice] = useState<string | null>(null);

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

  const resolveMutation = useMutation({ mutationFn: (name: string) => resolveObjectName(name) });
  const randomMutation = useMutation({ mutationFn: () => getRandomTarget() });

  const resolveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedName = objectName.trim();
    if (!requestedName) {
      setNotice('Enter an object name to resolve.');
      return;
    }
    setNotice(null);
    try {
      const object = await resolveMutation.mutateAsync(requestedName);
      onNavigate(object, object.name);
      setNotice(`Resolved ${object.name} from ${object.source ?? 'the name resolver'}.`);
    } catch {
      setNotice(null);
    }
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

  const selectRandomTarget = async () => {
    setNotice(null);
    try {
      const target = await randomMutation.mutateAsync();
      onNavigate(target, target.name);
      setNotice(`Loaded verified sky position${target.name ? ` ${target.name}` : ''}: ${formatCoordinate(target.ra, 4)}°, ${target.dec >= 0 ? '+' : ''}${formatCoordinate(target.dec, 4)}°.`);
    } catch {
      setNotice(null);
    }
  };

  return (
    <div className="panel-stack">
      <section className="panel-section" aria-labelledby="find-resolve-heading">
        <div className="section-heading">
          <h3 id="find-resolve-heading">Resolve object name</h3>
          <p>Coordinates come from a live astronomical resolver.</p>
        </div>
        <form className="form-stack" onSubmit={resolveName}>
          <label className="field">
            <span>Object name</span>
            <div className="input-with-icon">
              <Search aria-hidden="true" size={16} />
              <input
                type="search"
                value={objectName}
                onChange={(event) => setObjectName(event.target.value)}
                placeholder="e.g. M31"
                autoComplete="off"
                aria-describedby="resolver-hint"
              />
            </div>
            <small id="resolver-hint">No results appear until resolver returns them.</small>
          </label>
          <button className="button button--secondary button--full" type="submit" disabled={resolveMutation.isPending}>
            {resolveMutation.isPending ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : <Search aria-hidden="true" size={15} />}
            {resolveMutation.isPending ? 'Resolving…' : 'Resolve name'}
          </button>
          {resolveMutation.isError && <InlineError message={errorMessage(resolveMutation.error, 'Name resolver failed.')} />}
        </form>
      </section>

      <section className="panel-section" aria-labelledby="find-coordinates-heading">
        <div className="section-heading">
          <h3 id="find-coordinates-heading">Go to coordinates</h3>
          <p>ICRS · decimal degrees · RA wraps at 0°/360°.</p>
        </div>
        <form className="form-stack" onSubmit={submitCoordinates}>
          <div className="coordinate-fields">
            <label className="field">
              <span>RA (degrees)</span>
              <input
                type="number"
                inputMode="decimal"
                min="0"
                max="359.999999999"
                step="any"
                value={raText}
                onChange={(event) => setRaText(event.target.value)}
                placeholder="0 to &lt;360"
              />
            </label>
            <label className="field">
              <span>Dec (signed degrees)</span>
              <input
                type="number"
                inputMode="decimal"
                min="-90"
                max="90"
                step="any"
                value={decText}
                onChange={(event) => setDecText(event.target.value)}
                placeholder="−90 to +90"
              />
            </label>
          </div>
          {coordinateError && <InlineError message={coordinateError} />}
          <button className="button button--primary button--full" type="submit">Load position</button>
        </form>
      </section>

      <section className="panel-section" aria-labelledby="suggested-heading">
        <div className="section-heading">
          <h3 id="suggested-heading">Verified destinations</h3>
          <p>Curated SPHEREx destinations returned by the API.</p>
        </div>
        {targets.isPending && (
          <p className="inline-status" role="status"><LoaderCircle className="spin" aria-hidden="true" size={15} /> Checking verified destinations…</p>
        )}
        {targets.isError && (
          <div className="callout callout--error" role="status">
            <AlertCircle aria-hidden="true" size={17} />
            <div>
              <strong>Verified destinations unavailable</strong>
              <p>{errorMessage(targets.error, 'Could not load coverage-checked targets.')}</p>
              <button className="text-button" type="button" onClick={() => void targets.refetch()}>Retry</button>
            </div>
          </div>
        )}
        {targets.isSuccess && targets.data.length === 0 && (
          <div className="callout">
            <Info aria-hidden="true" size={17} />
            <div><strong>No verified suggestions loaded</strong><p>The API returned no curated SPHEREx destinations.</p></div>
          </div>
        )}
        {targets.isSuccess && targets.data.length > 0 && (
          <ul className="target-list" aria-label="Verified destinations">
            {targets.data.map((target) => (
              <li key={target.id ?? `${target.name}-${target.ra}-${target.dec}`}>
                <button type="button" className="target-row" onClick={() => onNavigate(target, target.name)}>
                  <span className="target-row__icon"><Target aria-hidden="true" size={15} /></span>
                  <span className="target-row__copy">
                    <strong>{target.name}</strong>
                    <small>{formatCoordinate(target.ra, 3)}°, {formatCoordinate(target.dec, 3)}°</small>
                    {target.description && <small>{target.description}</small>}
                  </span>
                  <ArrowRight aria-hidden="true" size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <button
          className="button button--secondary button--full"
          type="button"
          onClick={() => void selectRandomTarget()}
          disabled={randomMutation.isPending}
        >
          {randomMutation.isPending ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : <Target aria-hidden="true" size={15} />}
          {randomMutation.isPending ? 'Choosing position…' : 'Random sky position'}
        </button>
        {randomMutation.isError && <InlineError message={errorMessage(randomMutation.error, 'No verified covered position was returned.')} />}
      </section>
      {notice && <p className="inline-status" role="status"><Check aria-hidden="true" size={15} /> {notice}</p>}
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
    <div className="panel-stack">
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
        <div className="section-heading">
          <h3 id="navigate-image-heading">Navigate image</h3>
          <p>Smaller arcseconds per pixel means greater zoom.</p>
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
        <div className="compass-row" aria-label="Pan controls">
          <button type="button" className="icon-button compass compass--north" aria-label="Pan sky north" title="Pan sky north" disabled={!view} onClick={() => onPan('north')}><ArrowUp size={15} aria-hidden="true" /></button>
          <button type="button" className="icon-button compass compass--west" aria-label="Pan sky west" title="Pan sky west" disabled={!view} onClick={() => onPan('west')}><ArrowLeft size={15} aria-hidden="true" /></button>
          <span className="compass__center" aria-hidden="true">N</span>
          <button type="button" className="icon-button compass compass--east" aria-label="Pan sky east" title="Pan sky east" disabled={!view} onClick={() => onPan('east')}><ArrowRight size={15} aria-hidden="true" /></button>
          <button type="button" className="icon-button compass compass--south" aria-label="Pan sky south" title="Pan sky south" disabled={!view} onClick={() => onPan('south')}><ArrowDown size={15} aria-hidden="true" /></button>
          <span className="fov-readout">{fieldOfView ? formatFieldOfView(fieldOfView.widthArcminutes, fieldOfView.heightArcminutes) : 'FOV unavailable'}</span>
        </div>
        {view && <p className="field-hint">Field of view · scale {view.scale.toFixed(2)} arcsec/pixel</p>}
      </section>

      <section className="panel-section" aria-labelledby="overlays-heading">
        <div className="section-heading">
          <h3 id="overlays-heading">Overlays</h3>
          <p>Coordinate grid is drawn by Aladin Lite; crosshair is local.</p>
        </div>
        <label className="toggle-row">
          <span className="toggle-row__icon"><Grid2X2 aria-hidden="true" size={16} /></span>
          <span><strong>Coordinate grid</strong><small>Celestial grid that moves with the sky</small></span>
          <input type="checkbox" checked={view?.grid ?? false} disabled={!view} onChange={(event) => onGridChange(event.target.checked)} />
        </label>
        <label className="toggle-row">
          <span className="toggle-row__icon"><Crosshair aria-hidden="true" size={16} /></span>
          <span><strong>Center crosshair</strong><small>Local visual reference only</small></span>
          <input type="checkbox" checked={crosshair} onChange={(event) => onCrosshairChange(event.target.checked)} />
        </label>
      </section>
      {!view && <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>Load a sky position first</strong><p>Zoom, pan, and grid options activate after coordinates are set.</p></div></div>}
    </div>
  );
}

interface InspectPanelProps {
  selection: (SkyCoordinates & { accuracy: 'projection' }) | null;
  view: ExplorerView | null;
  survey: SphereXSurveyInfo | undefined;
  loading: boolean;
}

export function InspectPanel({ selection, view, survey, loading }: InspectPanelProps) {
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const nearby = useQuery({
    queryKey: ['objects', 'nearby', selection?.ra, selection?.dec],
    queryFn: ({ signal }) => findNearbyObjects(selection as SkyCoordinates, signal),
    enabled: Boolean(selection),
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
          <h3 id="selection-heading">Clicked position</h3>
          <p>Sky position under the pointer, from Aladin Lite's HiPS projection.</p>
        </div>
        {selection ? (
          <div className="coordinate-readout">
            <div><span>RA · ICRS</span><strong>{formatCoordinate(selection.ra, 6)}°</strong></div>
            <div><span>Dec · ICRS</span><strong>{selection.dec >= 0 ? '+' : ''}{formatCoordinate(selection.dec, 6)}°</strong></div>
            <span className="status-badge">Selected</span>
          </div>
        ) : (
          <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>No point selected</strong><p>Click the sky to inspect a position.</p></div></div>
        )}
      </section>

      <section className="panel-section" aria-labelledby="catalogue-heading">
        <div className="section-heading">
          <h3 id="catalogue-heading">Catalogue matches</h3>
          <p>SIMBAD objects near the position. These are not SPHEREx detections.</p>
        </div>
        {!selection && <p className="empty-inline">Select a sky position to query SIMBAD.</p>}
        {selection && nearby.isPending && <p className="inline-status" role="status"><LoaderCircle className="spin" aria-hidden="true" size={15} /> Searching SIMBAD…</p>}
        {selection && nearby.isError && <InlineError message={errorMessage(nearby.error, 'Catalogue lookup failed.')} />}
        {selection && nearby.isSuccess && nearby.data.length === 0 && (
          <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>No catalogue matches returned</strong><p>SIMBAD has no objects within 30 arcseconds.</p></div></div>
        )}
        {selection && nearby.isSuccess && nearby.data.length > 0 && (
          <ul className="match-list">
            {nearby.data.map((object, index) => <MatchRow key={object.id ?? `${object.name ?? 'match'}-${object.ra}-${object.dec}-${index}`} object={object} />)}
          </ul>
        )}
        {selection && (
          <button className="button button--secondary button--full" type="button" onClick={() => void nearby.refetch()} disabled={nearby.isFetching}>
            {nearby.isFetching ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : <Search aria-hidden="true" size={15} />}
            Retry catalogue lookup
          </button>
        )}
      </section>

      <section className="panel-section" aria-labelledby="provenance-heading">
        <div className="section-heading">
          <h3 id="provenance-heading">Image provenance</h3>
          <p>Values come from the HiPS dataset description; unavailable values stay explicit.</p>
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
          Copy clicked coordinates
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
      {object.separationArcsec !== undefined && <small>Separation · {object.separationArcsec.toFixed(2)}″</small>}
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
