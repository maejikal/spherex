import { ConstellationCard, type ConstellationCardProps } from './ConstellationCard.tsx';
import { useEffect, useRef, useState } from 'react';
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
import type { SexagesimalCoordinateInput, SkyCoordinates } from '../sky/coordinates.ts';
import { calculateFieldOfView, formatCoordinate, parseCoordinateInput, parseSexagesimalCoordinateInput } from '../sky/coordinates.ts';
import { draftFromView, editDraft, followView, syncDraft, sexagesimalFromView } from '../state/coordinateDraft.ts';
import { isAbortError } from '../state/navigationGuard.ts';
import type { NavigationGuard, NavigationTicket } from '../state/navigationGuard.ts';
import { channelForFrame, channelLabel, formatWavelength, resolveFrame } from '../sky/spherex/channels.ts';
import { SPHEREX_HIPS_URL } from '../sky/spherex/config.ts';
import type { SphereXSurveyInfo } from '../sky/spherex/properties.ts';
import { WavelengthSelector } from './WavelengthSelector.tsx';

interface FindPanelProps {
  view: ExplorerView | null;
  onNavigate: (coordinates: SkyCoordinates, label?: string) => void;
  /** Shared with the app: every navigation supersedes a name/random lookup that is still pending. */
  navigationGuard: NavigationGuard;
  /** Changes on every explicit navigation or reset; the RA/Dec fields then show the new position. */
  syncRevision: number;
}

export function FindPanel({ view, onNavigate, navigationGuard, syncRevision }: FindPanelProps) {
  const [objectName, setObjectName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => draftFromView(view));
  const [coordinateFormat, setCoordinateFormat] = useState<'decimal' | 'sexagesimal'>('decimal');
  const [sexagesimal, setSexagesimal] = useState(() => sexagesimalFromView(view));
  const [coordinateError, setCoordinateError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const viewRef = useRef(view);
  viewRef.current = view;

  // Viewer movement updates the fields only while the user is not editing them (BUG-008).
  useEffect(() => {
    setDraft((current) => followView(current, viewRef.current));
    if (!draftRef.current.edited) setSexagesimal(sexagesimalFromView(viewRef.current));
  }, [view?.ra, view?.dec]);

  const targets = useQuery({
    queryKey: ['targets', 'suggested'],
    queryFn: ({ signal }) => listSuggestedTargets(signal),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Each lookup carries a ticket; only a lookup that is still the newest navigation may move the view.
  const resolveMutation = useMutation({
    mutationFn: ({ name, ticket }: { name: string; ticket: NavigationTicket }) => resolveObjectName(name, ticket.signal),
    onSuccess: (object, { ticket }) => { if (ticket.isCurrent()) onNavigate(object, object.name); },
  });
  const randomMutation = useMutation({
    mutationFn: ({ ticket }: { ticket: NavigationTicket }) => getRandomTarget(ticket.signal),
    onSuccess: (target, { ticket }) => { if (ticket.isCurrent()) onNavigate(target, target.name); },
  });
  const { reset: resetResolve } = resolveMutation;
  const { reset: resetRandom } = randomMutation;

  // An explicit navigation (from here or elsewhere) shows the new position and clears obsolete errors.
  useEffect(() => {
    setDraft(syncDraft(viewRef.current));
    setSexagesimal(sexagesimalFromView(viewRef.current));
    setCoordinateError(null);
  }, [syncRevision]);

  const lookupActive = (variables: { ticket: NavigationTicket } | undefined) => Boolean(variables?.ticket.isCurrent());
  const resolvePending = resolveMutation.isPending && lookupActive(resolveMutation.variables);
  const randomPending = randomMutation.isPending && lookupActive(randomMutation.variables);
  const resolveFailure = resolveMutation.isError && !isAbortError(resolveMutation.error) && lookupActive(resolveMutation.variables)
    ? errorMessage(resolveMutation.error, 'Name resolver failed.')
    : null;
  const randomFailure = randomMutation.isError && !isAbortError(randomMutation.error) && lookupActive(randomMutation.variables)
    ? errorMessage(randomMutation.error, 'No verified covered position was returned.')
    : null;

  const resolveName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const requestedName = objectName.trim();
    resetRandom();
    if (!requestedName) {
      resetResolve();
      setNameError('Enter an object name to search.');
      return;
    }
    setNameError(null);
    resolveMutation.mutate({ name: requestedName, ticket: navigationGuard.begin() });
  };

  const findRandom = () => {
    resetResolve();
    setNameError(null);
    randomMutation.mutate({ ticket: navigationGuard.begin() });
  };

  const editName = (value: string) => {
    setObjectName(value);
    // The previous message described a different name.
    setNameError(null);
    if (!resolveMutation.isPending) resetResolve();
  };

  const editCoordinate = (field: 'ra' | 'dec', value: string) => {
    setDraft((current) => editDraft(current, field, value));
    setCoordinateError(null);
  };

  const submitCoordinates = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCoordinateError(null);
    const result = coordinateFormat === 'sexagesimal'
      ? parseSexagesimalCoordinateInput(sexagesimal)
      : parseCoordinateInput(draft.ra, draft.dec);
    if (!result.ok || !result.value) {
      setCoordinateError(result.error ?? 'Enter valid ICRS coordinates.');
      return;
    }
    onNavigate(result.value);
  };

  const switchCoordinateFormat = (nextFormat: 'decimal' | 'sexagesimal') => {
    if (nextFormat === 'sexagesimal') {
      const parsed = parseCoordinateInput(draft.ra, draft.dec);
      if (!parsed.ok || !parsed.value) {
        setCoordinateError(parsed.error ?? 'Enter valid ICRS coordinates.');
        return;
      }
      setSexagesimal(sexagesimalFromView(parsed.value));
    } else {
      const parsed = parseSexagesimalCoordinateInput(sexagesimal);
      if (!parsed.ok || !parsed.value) {
        setCoordinateError(parsed.error ?? 'Enter valid ICRS coordinates.');
        return;
      }
      setDraft({ ...draftFromView(parsed.value), edited: draft.edited });
    }
    setCoordinateFormat(nextFormat);
    setCoordinateError(null);
  };

  const editSexagesimal = (field: keyof SexagesimalCoordinateInput, value: string) => {
    setSexagesimal((current) => ({ ...current, [field]: value }));
    setDraft((current) => ({ ...current, edited: true }));
    setCoordinateError(null);
  };

  return (
    <div className="panel-stack find-panel-stack">
      <section className="panel-section find-name-section" aria-label="Find by object name">
        <form className="find-name-form" onSubmit={resolveName} onInvalidCapture={() => { setNameError(null); if (!resolveMutation.isPending) resetResolve(); }}>
          <div className="field find-name-field">
            <label className="sr-only" htmlFor="find-object-name">Object name</label>
            <div className="find-name-control">
              <div className="input-with-icon">
                <Search aria-hidden="true" size={16} />
                <input
                  id="find-object-name"
                  type="search"
                  value={objectName}
                  onChange={(event) => editName(event.target.value)}
                  placeholder="Object name · e.g. M31"
                  autoComplete="off"
                  required
                />
              </div>
              {/* Stays enabled while a lookup runs: a new search supersedes it. */}
              <button className="button button--secondary" type="submit" aria-busy={resolvePending}>
                {resolvePending ? <LoaderCircle className="spin" aria-hidden="true" size={15} /> : null}
                {resolvePending ? 'Finding…' : 'Find'}
              </button>
            </div>
          </div>
          {(nameError ?? resolveFailure) && <InlineError message={(nameError ?? resolveFailure)!} />}
        </form>
      </section>

      <div className="find-divider" aria-hidden="true">or</div>

      <section className="panel-section" aria-labelledby="find-coordinates-heading">
        <div className="find-section-heading">
          <h3 id="find-coordinates-heading">Go to coordinates</h3>
          <div className="coordinate-format-toggle" role="group" aria-label="Coordinate format">
            <button type="button" aria-pressed={coordinateFormat === 'decimal'} onClick={() => switchCoordinateFormat('decimal')}>Decimal</button>
            <span aria-hidden="true">|</span>
            <button type="button" aria-pressed={coordinateFormat === 'sexagesimal'} onClick={() => switchCoordinateFormat('sexagesimal')}>HMS/DMS</button>
          </div>
        </div>
        {/* Native range checks run first; an invalid submit must not leave an older message beside the browser's. */}
        <form className="form-stack find-coordinate-form" onSubmit={submitCoordinates} onInvalidCapture={() => setCoordinateError(null)}>
          {coordinateFormat === 'decimal' ? <div className="coordinate-fields">
            <label className="field">
              <span>RA · degrees</span>
              <input
                id="coordinate-ra"
                type="number"
                inputMode="decimal"
                min="0"
                max="359.999999999"
                step="any"
                value={draft.ra}
                onChange={(event) => editCoordinate('ra', event.target.value)}
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
                value={draft.dec}
                onChange={(event) => editCoordinate('dec', event.target.value)}
                placeholder="−90 to +90"
                aria-describedby={coordinateError ? 'coordinate-error' : undefined}
              />
            </label>
          </div> : <div className="coordinate-fields coordinate-fields--sexagesimal">
            <fieldset className="field coordinate-sexagesimal" aria-label="Right ascension in hours, minutes, and seconds">
              <legend className="coordinate-sexagesimal__legend">RA · HMS</legend>
              {([
                ['raHours', 'Hours', '0–23'],
                ['raMinutes', 'Minutes', '0–59'],
                ['raSeconds', 'Seconds', '0–<60'],
              ] as const).map(([key, label, placeholder]) => (
                <label className="coordinate-sexagesimal__field" key={key}>
                  <span>{label}</span>
                  <input
                    type="number" inputMode="decimal" min="0" max={key === 'raHours' ? '23' : key === 'raMinutes' ? '59' : undefined}
                    step={key === 'raSeconds' ? 'any' : '1'} value={sexagesimal[key]} placeholder={placeholder}
                    onChange={(event) => editSexagesimal(key, event.target.value)}
                    aria-label={`Right ascension ${label.toLowerCase()}`}
                    aria-describedby={coordinateError ? 'coordinate-error' : undefined}
                  />
                </label>
              ))}
            </fieldset>
            <fieldset className="field coordinate-sexagesimal" aria-label="Declination in degrees, minutes, and seconds">
              <legend className="coordinate-sexagesimal__legend">
                <span>Dec · DMS</span>
                <label className="coordinate-sexagesimal__sign-control">
                  <select className="coordinate-sexagesimal__sign" aria-label="Declination sign" title="Declination sign" value={sexagesimal.decSign} onChange={(event) => editSexagesimal('decSign', event.target.value)}>
                    <option value="+">+</option>
                    <option value="-">−</option>
                  </select>
                </label>
              </legend>
              {([
                ['decDegrees', 'Degrees', '0–90'],
                ['decMinutes', 'Minutes', '0–59'],
                ['decSeconds', 'Seconds', '0–<60'],
              ] as const).map(([key, label, placeholder]) => (
                <label className="coordinate-sexagesimal__field" key={key}>
                  <span>{label}</span>
                  <input
                    type="number" inputMode="decimal" min="0" max={key === 'decDegrees' ? '90' : key === 'decMinutes' ? '59' : undefined}
                    step={key === 'decSeconds' ? 'any' : '1'} value={sexagesimal[key]} placeholder={placeholder}
                    onChange={(event) => editSexagesimal(key, event.target.value)}
                    aria-label={`Declination ${label.toLowerCase()}`}
                    aria-describedby={coordinateError ? 'coordinate-error' : undefined}
                  />
                </label>
              ))}
            </fieldset>
          </div>}
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
            onClick={findRandom}
            disabled={randomPending}
          >
            {randomPending ? 'Finding…' : 'Random'}
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
                  <span className="target-row__name" title={target.name}>{target.name}</span>
                  <span className="target-row__coordinates" aria-label={`${formatCoordinate(target.ra, 3)} degrees right ascension, ${formatCoordinate(target.dec, 3)} degrees declination`}>
                    <span>{formatCoordinate(target.ra, 3)}°</span>
                    <span aria-hidden="true">,</span>
                    <span>{formatCoordinate(target.dec, 3)}°</span>
                  </span>
                  <ArrowRight aria-hidden="true" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {randomFailure && <InlineError message={randomFailure} />}
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
  constellation: ConstellationCardProps;
  selection: (SkyCoordinates & { accuracy: 'projection' }) | null;
  view: ExplorerView | null;
  survey: SphereXSurveyInfo | undefined;
  loading: boolean;
  analysisEnabled: boolean;
}

export function InspectPanel({
  constellation,
  selection,
  view,
  survey,
  loading,
  analysisEnabled,
}: InspectPanelProps) {
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
    const value = `${formatCoordinate(selection.ra, 5)}°, ${selection.dec >= 0 ? '+' : ''}${formatCoordinate(selection.dec, 5)}°`;
    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage('Selected coordinates copied.');
    } catch {
      setCopyMessage('Clipboard unavailable; coordinates are shown above.');
    }
  };

  const frame = view && survey ? resolveFrame(survey, view.channel) : null;
  const channel = survey && frame !== null ? channelForFrame(survey, frame) : null;

  return (
    <div className="panel-stack">
      <section className="panel-section" aria-labelledby="selection-heading">
        <div className="section-heading">
          <h3 id="selection-heading">Selected position</h3>
        </div>
        {selection ? (
          <div className="coordinate-readout">
            <div><span>RA · ICRS</span><strong>{formatCoordinate(selection.ra, 5)}°</strong></div>
            <div><span>Dec · ICRS</span><strong>{selection.dec >= 0 ? '+' : ''}{formatCoordinate(selection.dec, 5)}°</strong></div>
            <span className="status-badge">Selected</span>
          </div>
        ) : (
          <div className="callout"><Info aria-hidden="true" size={17} /><div><strong>No point selected</strong><p>Single-click to select; double-click to center the position.</p></div></div>
        )}
      </section>

      {selection && <section className="panel-section" aria-label="Selected constellation">
        <div className="section-heading"><h3>Constellation</h3></div>
        <ConstellationCard {...constellation} />
      </section>}

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
