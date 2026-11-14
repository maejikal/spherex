/** Floating-window defaults, stacking and first-open placement (pure, so it can be unit-tested). */

export type PanelId = 'find' | 'view' | 'inspect';
export type PanelVisibility = Record<PanelId, boolean>;

/** A fresh session opens only Find; View and Inspect are opened from the toolbar. */
export function initialPanels(): PanelVisibility {
  return { find: true, view: false, inspect: false };
}

export function togglePanel(panels: PanelVisibility, id: PanelId, exclusive = false): PanelVisibility {
  if (exclusive && !panels[id]) return { find: false, view: false, inspect: false, [id]: true };
  return { ...panels, [id]: !panels[id] };
}

/** Stacking order, back to front. Raising a window moves it to the end. */
export function raise(order: readonly PanelId[], id: PanelId): PanelId[] {
  return order[order.length - 1] === id ? [...order] : [...order.filter((item) => item !== id), id];
}

export const BASE_Z_INDEX = 5;
export const zIndexFor = (order: readonly PanelId[], id: PanelId): number =>
  BASE_Z_INDEX + Math.max(0, order.indexOf(id));

export type Placement = 'left-top' | 'left-bottom' | 'right-top' | 'beside';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacementInput {
  placement: Placement;
  workspace: { width: number; height: number };
  panel: { width: number; height: number };
  /** The window this one should sit next to ('beside'); ignored when it is not on screen. */
  anchor?: Box | null;
  gap?: number;
}

/**
 * Where a window first opens (top-left corner, workspace coordinates). `beside` puts the window to the
 * right of its anchor with `gap` spacing; when there is no horizontal room it goes below the anchor,
 * and when that does not fit either it falls back to the top-left corner. Callers clamp the result to
 * the workspace afterwards, so a window is never pushed off screen.
 */
export function initialPosition({ placement, workspace, panel, anchor, gap = 16 }: PlacementInput): { x: number; y: number } {
  const edge = 8;
  if (placement === 'right-top') return { x: workspace.width - panel.width - gap, y: gap };
  if (placement === 'left-bottom') return { x: gap, y: workspace.height - panel.height - gap };
  if (placement === 'beside' && anchor) {
    const right = anchor.x + anchor.width + gap;
    if (right + panel.width <= workspace.width - edge) return { x: right, y: anchor.y };
    const below = anchor.y + anchor.height + gap;
    if (below + panel.height <= workspace.height - edge) return { x: anchor.x, y: below };
  }
  return { x: gap, y: gap };
}
