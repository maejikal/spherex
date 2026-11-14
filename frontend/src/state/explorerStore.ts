import { create } from 'zustand';
import type { ExplorerView } from '../api/types.ts';
import type { SkyCoordinates } from '../sky/coordinates.ts';

export type UrlUpdateMode = 'push' | 'replace' | 'none';

interface SelectedPosition extends SkyCoordinates {
  accuracy: 'approximate';
}

interface ExplorerState {
  view: ExplorerView | null;
  selection: SelectedPosition | null;
  crosshair: boolean;
  urlUpdateMode: UrlUpdateMode;
  urlRevision: number;
  setView: (view: ExplorerView | null, mode?: UrlUpdateMode) => void;
  setSelection: (selection: SelectedPosition | null) => void;
  setGrid: (grid: boolean) => void;
  setCrosshair: (enabled: boolean) => void;
}

export const useExplorerStore = create<ExplorerState>((set) => ({
  view: null,
  selection: null,
  crosshair: false,
  urlUpdateMode: 'none',
  urlRevision: 0,
  setView: (view, mode = 'push') =>
    set((state) => ({
      view,
      urlUpdateMode: mode,
      urlRevision: state.urlRevision + 1,
    })),
  setSelection: (selection) => set({ selection }),
  setGrid: (grid) =>
    set((state) => ({
      view: state.view ? { ...state.view, grid } : null,
      urlUpdateMode: 'replace',
      urlRevision: state.urlRevision + 1,
    })),
  setCrosshair: (enabled) => set({ crosshair: enabled }),
}));
