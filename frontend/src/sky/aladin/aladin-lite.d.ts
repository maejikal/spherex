// Minimal typings for the parts of Aladin Lite 3.8.2 this app uses (the package ships none).
// Signatures were checked against a live instance; see docs in frontend/README.md.
declare module 'aladin-lite' {
  export interface AladinHiPS {
    setFrequency(frequency: { value: number; unit: string }): void;
    getFrequency(): number;
    readonly isSpectralCube?: boolean;
  }
  export interface AladinCatalog {
    addSources(sources: unknown[]): void;
    removeAll(): void;
    hide(): void;
    show(): void;
  }
  export interface AladinClickEvent {
    ra: number;
    dec: number;
    x: number;
    y: number;
    isDragging?: boolean;
  }
  export interface AladinInstance {
    gotoRaDec(ra: number, dec: number): void;
    setFoV(fovDegrees: number): void;
    /** [horizontal, vertical] field of view in degrees. */
    getFov(): [number, number];
    getRaDec(): [number, number];
    getSize(): [number, number];
    pix2world(x: number, y: number): [number, number] | undefined;
    world2pix(ra: number, dec: number): [number, number] | undefined;
    setBaseImageLayer(layer: AladinHiPS | string): void;
    getBaseImageLayer(): AladinHiPS;
    showCooGrid(show: boolean): void;
    setCooGrid(options: Record<string, unknown>): void;
    addCatalog(catalog: AladinCatalog): void;
    removeLayers?(): void;
    on(event: string, callback: (payload: never) => void): void;
    setBackgroundColor?(color: string): void;
    remove?(): void;
  }
  interface AladinStatic {
    init: Promise<void>;
    aladin(selector: string | HTMLElement, options?: Record<string, unknown>): AladinInstance;
    imageHiPS(
      url: string,
      options?: { name?: string; successCallback?: (hips: AladinHiPS) => void; errorCallback?: (error: unknown) => void },
    ): AladinHiPS;
    catalog(options?: Record<string, unknown>): AladinCatalog;
    source(ra: number, dec: number, data?: Record<string, unknown>): unknown;
  }
  const A: AladinStatic;
  export default A;
}
