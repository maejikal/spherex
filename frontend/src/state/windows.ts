/** Floating-window defaults, stacking and first-open placement (pure, so it can be unit-tested). */

export type PanelId = 'find' | 'view' | 'inspect';
export type PanelVisibility = Record<PanelId, boolean>;
/** Every floating window that takes part in stacking: the three panels plus the blink viewer. */
export type WindowId = PanelId | 'blink';

/** A fresh session opens only Find; View and Inspect are opened from the toolbar. */
export function initialPanels(): PanelVisibility {
  return { find: true, view: false, inspect: false };
}

export function togglePanel(panels: PanelVisibility, id: PanelId, exclusive = false): PanelVisibility {
  if (exclusive && !panels[id]) return { find: false, view: false, inspect: false, [id]: true };
  return { ...panels, [id]: !panels[id] };
}

/** Stacking order, back to front. Raising a window moves it to the end. */
export function raise(order: readonly WindowId[], id: WindowId): WindowId[] {
  return order[order.length - 1] === id ? [...order] : [...order.filter((item) => item !== id), id];
}

export const BASE_Z_INDEX = 5;
export const zIndexFor = (order: readonly WindowId[], id: WindowId): number =>
  BASE_Z_INDEX + Math.max(0, order.indexOf(id));

export type Placement = 'left-top' | 'left-bottom' | 'right-top' | 'beside' | 'left-of' | 'center-bottom';

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
  /** The window this one should sit next to ('beside', 'left-of'); ignored when it is not on screen. */
  anchor?: Box | null;
  gap?: number;
}

/**
 * Where a window first opens (top-left corner, workspace coordinates). `beside` puts the window to the
 * right of its anchor with `gap` spacing (`left-of` is the mirror image, bottom-aligned); when there is no horizontal room it goes below the anchor,
 * and when that does not fit either it falls back to the top-left corner. Callers clamp the result to
 * the workspace afterwards, so a window is never pushed off screen.
 */
export function initialPosition({ placement, workspace, panel, anchor, gap = 16 }: PlacementInput): { x: number; y: number } {
  const edge = 8;
  if (placement === 'right-top') return { x: workspace.width - panel.width - gap, y: gap };
  if (placement === 'left-of' && anchor) {
    // Bottom-aligned, immediately left of the anchor, so the anchor window stays fully visible and reachable.
    return { x: Math.max(gap, anchor.x - gap - panel.width), y: workspace.height - panel.height - gap };
  }
  if (placement === 'center-bottom' || placement === 'left-of') {
    return { x: Math.round((workspace.width - panel.width) / 2), y: workspace.height - panel.height - gap };
  }
  if (placement === 'left-bottom') return { x: gap, y: workspace.height - panel.height - gap };
  if (placement === 'beside' && anchor) {
    const right = anchor.x + anchor.width + gap;
    if (right + panel.width <= workspace.width - edge) return { x: right, y: anchor.y };
    const below = anchor.y + anchor.height + gap;
    if (below + panel.height <= workspace.height - edge) return { x: anchor.x, y: below };
  }
  return { x: gap, y: gap };
}

/**
 * What "Analyze area" opens. Inspect (the SIMBAD search) always opens, exactly as before; the blink viewer
 * opens with it and is raised last, so it is the front window while Inspect stays open beside it. On a
 * phone-sized screen only one sheet fits, so the blink viewer takes it and Inspect is one tap away.
 */
export function panelsForAnalysis(panels: PanelVisibility, compact: boolean): PanelVisibility {
  return compact ? { find: false, view: false, inspect: false } : { ...panels, inspect: true };
}

export function orderForAnalysis(order: readonly WindowId[], compact: boolean): WindowId[] {
  return raise(compact ? order : raise(order, 'inspect'), 'blink');
}
