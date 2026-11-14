import type { AladinCatalog, AladinGraphicOverlay, AladinHiPS, AladinInstance } from 'aladin-lite';
import { frequencyForFrame } from '../spherex/channels.ts';
import type { SphereXSurveyInfo } from '../spherex/properties.ts';
import { normalizeRightAscension } from '../coordinates.ts';

export interface ViewState {
  ra: number;
  dec: number;
  /** Horizontal field of view in degrees. */
  fov: number;
}

export interface AladinControllerCallbacks {
  /** User navigation finished (pan/zoom settled). Never fired for programmatic changes. */
  onUserView: (view: ViewState) => void;
  onClick: (position: { ra: number; dec: number }) => void;
  onDoubleClick: (position: { ra: number; dec: number }) => void;
  onHover: (position: { ra: number; dec: number } | null) => void;
  /** True while tiles for the latest navigation or channel change are still arriving. */
  onLoading: (loading: boolean) => void;
  /** Repeated tile failures from the HiPS service (network error or 5xx). */
  onTileErrors: (message: string | null) => void;
}

export interface AladinControllerOptions {
  container: HTMLElement;
  hipsUrl: string;
  survey: SphereXSurveyInfo;
  initial: ViewState & { frame: number; grid: boolean };
  callbacks: AladinControllerCallbacks;
}

/** Programmatic-change guard window; Aladin fires change events asynchronously after redraws. */
const SETTLE_MS = 220;
const QUIET_MS = 450;
const MAX_LOADING_MS = 8000;
const TILE_ERROR_WINDOW_MS = 15_000;

const EPSILON_DEG = 1e-7;

type AladinModule = typeof import('aladin-lite');

/**
 * Owns the Aladin Lite instance. React never touches Aladin directly; it calls this class, which
 * keeps programmatic navigation and user navigation apart so that the app state can follow the
 * viewer (and vice versa) without feedback loops.
 */
export class AladinController {
  private aladin: AladinInstance;
  private A: AladinModule['default'];
  private readonly options: AladinControllerOptions;
  private hips: AladinHiPS | null = null;
  private marker: AladinCatalog | null = null;
  private constellationOverlay: AladinGraphicOverlay | null = null;
  private frame: number;
  private destroyed = false;
  private programmaticUntil = 0;
  private settleTimer: number | null = null;
  /** Last view reported to the app; the app echoing it back must not move the camera. */
  private lastEmitted: ViewState | null = null;
  private quietTimer: number | null = null;
  private loadingSince = 0;
  private tilesInFlight = 0;
  private failureTimer: number | null = null;
  private restoreFetch: (() => void) | null = null;
  private tileFailures: number[] = [];
  private hoverFrame: number | null = null;
  private pendingHover: { ra: number; dec: number } | null = null;

  private constructor(
    A: AladinModule['default'],
    aladin: AladinInstance,
    options: AladinControllerOptions,
  ) {
    this.A = A;
    this.aladin = aladin;
    this.options = options;
    this.frame = options.initial.frame;
  }

  /** Use the browser's native double-click gesture, then convert its view pixel to sky coordinates. */
  private handleDoubleClick = (event: MouseEvent): void => {
    const bounds = this.options.container.getBoundingClientRect();
    const position = this.aladin.pix2world(event.clientX - bounds.left, event.clientY - bounds.top);
    if (!position || !Number.isFinite(position[0]) || !Number.isFinite(position[1]) || position[1] < -90 || position[1] > 90) return;
    event.preventDefault();
    event.stopPropagation();
    this.options.callbacks.onDoubleClick({ ra: normalizeRightAscension(position[0]), dec: position[1] });
  };

  static async create(options: AladinControllerOptions): Promise<AladinController> {
    const module = await import('aladin-lite');
    const A = module.default;
    await A.init;
    const { initial } = options;
    // Option names verified against Aladin Lite 3.8.2. `survey: []` and `log: false` stop it from
    // contacting CDS services (default survey, usage logging); only the IRSA HiPS is used.
    const aladin = A.aladin(options.container, {
      survey: [],
      log: false,
      target: `${initial.ra} ${initial.dec}`,
      fov: initial.fov,
      cooFrame: 'ICRSd',
      backgroundColor: 'rgb(41, 45, 53)',
      showZoomControl: false,
      showFullscreenControl: false,
      showLayersControl: false,
      showGotoControl: false,
      showSimbadPointerControl: false,
      showCooGridControl: false,
      showProjectionControl: false,
      showShareControl: false,
      showSettingsControl: false,
      showColorPickerControl: false,
      showContextMenu: false,
      showStatusBar: false,
      showFrame: false,
      showFov: false,
      showCooLocation: false,
      showReticle: false,
      showCooGrid: initial.grid,
    });
    const controller = new AladinController(A, aladin, options);
    controller.attach();
    return controller;
  }

  private attach(): void {
    const { A, aladin, options } = this;
    const hips = A.imageHiPS(options.hipsUrl, {
      name: 'SPHEREx DR1 all-sky cube',
      successCallback: (loaded) => {
        if (this.destroyed) return;
        // Aladin opens a cube on its middle frame (a blank one for SPHEREx); select ours at once.
        this.selectFrame(loaded, this.frame);
        this.beginLoading();
      },
      errorCallback: () => options.callbacks.onTileErrors('The SPHEREx HiPS service could not be loaded.'),
    });
    this.hips = hips;
    aladin.setBaseImageLayer(hips);
    this.applyGrid(options.initial.grid);
    this.marker = A.catalog({ name: 'selection', shape: 'cross', color: '#6ee7d0', sourceSize: 22 });
    aladin.addCatalog(this.marker);
    options.container.addEventListener('dblclick', this.handleDoubleClick, true);

    const userChange = () => {
      if (this.destroyed) return;
      this.beginLoading();
      if (performance.now() < this.programmaticUntil) return;
      if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
      this.settleTimer = window.setTimeout(() => {
        this.settleTimer = null;
        const view = this.getView();
        if (!view) return;
        this.lastEmitted = view;
        options.callbacks.onUserView(view);
      }, SETTLE_MS);
    };
    aladin.on('positionChanged', userChange);
    aladin.on('zoomChanged', userChange);
    aladin.on('click', ((event: { ra: number; dec: number; isDragging?: boolean }) => {
      if (event.isDragging || !Number.isFinite(event.ra) || !Number.isFinite(event.dec)) return;
      options.callbacks.onClick({ ra: normalizeRightAscension(event.ra), dec: event.dec });
    }) as never);
    aladin.on('mouseMove', ((event: { ra: number; dec: number }) => {
      this.pendingHover = Number.isFinite(event?.ra) ? { ra: normalizeRightAscension(event.ra), dec: event.dec } : null;
      if (this.hoverFrame !== null) return;
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = null;
        options.callbacks.onHover(this.pendingHover);
      });
    }) as never);

    this.installFetchMonitor();
  }

  /** `enabled` must always be passed: Aladin's grid defaults to on once any option is set. */
  private applyGrid(enabled: boolean): void {
    try {
      this.aladin.setCooGrid({ enabled, color: '#6ee7d0', opacity: 0.55, labelSize: 12 });
    } catch (error) {
      console.warn('Could not configure the Aladin coordinate grid', error);
    }
  }

  private selectFrame(hips: AladinHiPS, frame: number): void {
    hips.setFrequency({ value: frequencyForFrame(this.options.survey, frame), unit: 'Hz' });
  }

  /** Project an ICRS position into viewer-local pixels for anchoring overlays. */
  getScreenPosition(position: { ra: number; dec: number }): { x: number; y: number } | null {
    try {
      const aladin = this.aladin as unknown as {
        world2pix?: (ra: number, dec: number) => ArrayLike<number> | null;
      };
      const pixel = aladin.world2pix?.call(this.aladin, position.ra, position.dec);
      if (!pixel || pixel.length < 2) return null;
      const [x, y] = [pixel[0], pixel[1]];
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y };
    } catch {
      return null;
    }
  }

  /** Current viewer state, or null if the instance cannot report it yet. */
  getView(): ViewState | null {
    try {
      const [ra, dec] = this.aladin.getRaDec();
      const [fov] = this.aladin.getFov();
      if (![ra, dec, fov].every(Number.isFinite)) return null;
      return { ra: normalizeRightAscension(ra), dec, fov };
    } catch {
      return null;
    }
  }

  private static sameCenter(a: ViewState, b: ViewState): boolean {
    const tolerance = Math.max(EPSILON_DEG, a.fov * 1e-4);
    const raDelta = Math.abs(((a.ra - b.ra + 540) % 360) - 180) * Math.cos((a.dec * Math.PI) / 180);
    return raDelta < tolerance && Math.abs(a.dec - b.dec) < tolerance;
  }

  private static sameView(a: ViewState, b: ViewState): boolean {
    return AladinController.sameCenter(a, b) && Math.abs(a.fov - b.fov) <= a.fov * 1e-3;
  }

  /**
   * Move the viewer to `target`. Does nothing when Aladin is already there, or when `target` is just
   * the app echoing back the view this controller reported (so a user drag that began after the
   * report is never yanked back to a stale position).
   */
  setView(target: ViewState): void {
    if (this.lastEmitted && AladinController.sameView(target, this.lastEmitted)) return;
    const current = this.getView();
    if (current && AladinController.sameView(target, current)) return;
    this.lastEmitted = null;
    this.programmaticUntil = performance.now() + SETTLE_MS * 3;
    if (!current || Math.abs(target.fov - current.fov) > current.fov * 1e-3) this.aladin.setFoV(target.fov);
    if (!current || !AladinController.sameCenter(target, current)) this.aladin.gotoRaDec(target.ra, target.dec);
    this.beginLoading();
  }

  /** Explicit user intent: bypass stale app-echo guards and center on exact requested coordinates. */
  centerOn(position: { ra: number; dec: number }): void {
    if (this.destroyed || !Number.isFinite(position.ra) || !Number.isFinite(position.dec) || position.dec < -90 || position.dec > 90) return;
    if (this.settleTimer !== null) {
      window.clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.lastEmitted = null;
    this.programmaticUntil = performance.now() + SETTLE_MS * 3;
    this.aladin.gotoRaDec(normalizeRightAscension(position.ra), position.dec);
    this.beginLoading();
  }

  setChannel(frame: number): void {
    if (frame === this.frame) return;
    this.frame = frame;
    if (this.hips) {
      this.selectFrame(this.hips, frame);
      this.beginLoading();
    }
  }

  setGrid(show: boolean): void {
    this.applyGrid(show);
  }

  setSelection(position: { ra: number; dec: number } | null): void {
    if (!this.marker) return;
    this.marker.removeAll();
    if (position) this.marker.addSources([this.A.source(position.ra, position.dec, {})]);
  }

  /** Geometry is already sampled in ICRS. Aladin handles spherical projection and RA wrap. */
  setConstellationBoundary(rings: [number, number][][] | null): void {
    if (this.destroyed) return;
    if (!this.constellationOverlay && rings) {
      this.constellationOverlay = this.A.graphicOverlay({ name: 'Selected constellation boundary', color: '#f0cb85', lineWidth: 2 });
      this.aladin.addOverlay(this.constellationOverlay);
    }
    this.constellationOverlay?.removeAll();
    if (rings) this.constellationOverlay?.addFootprints(rings.map((ring) => this.A.polyline(ring)));
  }

  resize(): void {
    // Aladin tracks its container with a ResizeObserver; this only re-reports the settled view.
    const view = this.getView();
    if (view) this.options.callbacks.onUserView(view);
  }

  // ---- tile activity -> loading / failure feedback -------------------------------------------
  /**
   * Aladin Lite fetches HiPS tiles with `window.fetch` on the main thread (verified in the browser).
   * A wrapper scoped to this HiPS URL, installed only while the controller lives, gives an exact
   * in-flight count and real failure signals. A 404 is not a failure: blank frames and sparse trees
   * legitimately have missing tiles.
   */
  private installFetchMonitor(): void {
    const original = window.fetch;
    const prefix = this.options.hipsUrl;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const wrapped: typeof window.fetch = function (this: unknown, input, init) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      if (self.destroyed || !url.startsWith(prefix) || !/\/Norder\d+\//.test(url)) return original.call(window, input, init);
      self.tilesInFlight += 1;
      return original.call(window, input, init).then(
        (response) => {
          self.tileSettled(response.status >= 500);
          return response;
        },
        (error: unknown) => {
          self.tileSettled(!(error instanceof DOMException && error.name === 'AbortError'));
          throw error;
        },
      );
    };
    window.fetch = wrapped;
    this.restoreFetch = () => {
      if (window.fetch === wrapped) window.fetch = original;
    };
  }

  private tileSettled(failed: boolean): void {
    this.tilesInFlight = Math.max(0, this.tilesInFlight - 1);
    if (failed) this.tileFailures.push(performance.now());
    this.evaluateFailures();
    this.scheduleQuiet();
  }

  /** Any tile failure in the last TILE_ERROR_WINDOW_MS is surfaced, then expires on its own. */
  private evaluateFailures(): void {
    if (this.failureTimer !== null) {
      window.clearTimeout(this.failureTimer);
      this.failureTimer = null;
    }
    const now = performance.now();
    this.tileFailures = this.tileFailures.filter((t) => t >= now - TILE_ERROR_WINDOW_MS);
    const failing = this.tileFailures.length > 0;
    this.options.callbacks.onTileErrors(failing ? 'Some SPHEREx tiles could not be retrieved from NASA/IPAC IRSA.' : null);
    if (failing && !this.destroyed) {
      const oldest = this.tileFailures[0]!;
      this.failureTimer = window.setTimeout(() => this.evaluateFailures(), Math.max(250, oldest + TILE_ERROR_WINDOW_MS - now + 50));
    }
  }

  private beginLoading(): void {
    if (this.destroyed) return;
    if (this.loadingSince === 0) this.options.callbacks.onLoading(true);
    this.loadingSince = this.loadingSince || performance.now();
    this.scheduleQuiet();
  }

  private scheduleQuiet(): void {
    if (this.loadingSince === 0) return;
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer);
    const sinceStart = performance.now() - this.loadingSince;
    const wait = sinceStart >= MAX_LOADING_MS ? 0 : QUIET_MS;
    this.quietTimer = window.setTimeout(() => {
      this.quietTimer = null;
      if (this.tilesInFlight > 0 && performance.now() - this.loadingSince < MAX_LOADING_MS) {
        this.scheduleQuiet();
        return;
      }
      this.loadingSince = 0;
      if (!this.destroyed) this.options.callbacks.onLoading(false);
    }, wait);
  }

  destroy(): void {
    this.destroyed = true;
    this.options.container.removeEventListener('dblclick', this.handleDoubleClick, true);
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    if (this.quietTimer !== null) window.clearTimeout(this.quietTimer);
    if (this.failureTimer !== null) window.clearTimeout(this.failureTimer);
    if (this.hoverFrame !== null) window.cancelAnimationFrame(this.hoverFrame);
    this.restoreFetch?.();
    try {
      this.aladin.remove?.();
    } catch {
      /* instance may already be torn down */
    }
    this.options.container.replaceChildren();
    this.options.container.remove();
  }
}
