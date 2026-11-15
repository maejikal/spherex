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

/** Height of a window's title bar (with its close button) that a newly placed window should never cover. */
export const HEADER_HEIGHT = 56;

function overlapArea(a: Box, b: Box): number {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > 0 && y > 0 ? x * y : 0;
}

/** Keep a window of `size` inside `area` with an 8 px margin (top-left wins when it cannot fit). */
export function clampToArea(position: { x: number; y: number }, area: Box, size: { width: number; height: number }, gap = 8): { x: number; y: number } {
  const minX = area.x + gap;
  const minY = area.y + gap;
  const maxX = Math.max(minX, area.x + area.width - size.width - gap);
  const maxY = Math.max(minY, area.y + area.height - size.height - gap);
  return { x: Math.min(maxX, Math.max(minX, position.x)), y: Math.min(maxY, Math.max(minY, position.y)) };
}

/**
 * First position for a window that opens over others. Starts from `preferred` and, if that covers other
 * open windows, tries positions beside, above and below each of them inside `area`. Covering another
 * window's title bar (and so its close button) costs far more than covering its body, so when something
 * has to overlap it is content, never a header. When the workspace is too small for that at full height
 * (tablet widths in the floating layout), the window may open just below the other title bars with a
 * shorter `height` (its body scrolls), never below `minHeight`. Ties keep the earlier candidate, so
 * `preferred` wins whenever it is clear.
 */
export function placeAvoiding({ preferred, area, panel, obstacles, gap = 16, minHeight = 240 }: {
  preferred: { x: number; y: number };
  area: Box;
  panel: { width: number; height: number };
  obstacles: readonly Box[];
  gap?: number;
  minHeight?: number;
}): { x: number; y: number; height?: number } {
  const candidates: { x: number; y: number; height?: number }[] = [preferred];
  for (const o of obstacles) {
    candidates.push(
      { x: o.x + o.width + gap, y: preferred.y },
      { x: o.x - gap - panel.width, y: preferred.y },
      { x: preferred.x, y: o.y + o.height + gap },
      { x: o.x + o.width + gap, y: o.y + HEADER_HEIGHT + gap },
      { x: o.x - gap - panel.width, y: o.y + HEADER_HEIGHT + gap },
    );
  }
  // Shortened fallbacks: open below every title bar it would otherwise cover.
  for (const o of obstacles) {
    const y = o.y + HEADER_HEIGHT + gap;
    const height = Math.min(panel.height, Math.floor(area.y + area.height - 8 - y));
    if (height >= minHeight && height < panel.height) {
      for (const x of [preferred.x, o.x + o.width + gap, o.x - gap - panel.width]) candidates.push({ x, y, height });
    }
  }
  let best: { x: number; y: number; height?: number } = clampToArea(preferred, area, panel);
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const size = { width: panel.width, height: candidate.height ?? panel.height };
    const position = clampToArea(candidate, area, size);
    const box = { ...position, ...size };
    let score = 0;
    for (const o of obstacles) {
      score += overlapArea(box, o) + 1000 * overlapArea(box, { x: o.x, y: o.y, width: o.width, height: Math.min(HEADER_HEIGHT, o.height) });
    }
    // A shorter window is a little worse than a full one with the same overlap.
    if (candidate.height !== undefined) score += 1;
    if (score < bestScore) {
      best = candidate.height !== undefined ? { ...position, height: candidate.height } : position;
      bestScore = score;
    }
  }
  return best;
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

/** Keyboard window movement: the pixel step for an arrow key (larger with Shift), or null for any other key. */
export function keyboardMoveDelta(key: string, shift: boolean): { x: number; y: number } | null {
  const step = shift ? 24 : 8;
  switch (key) {
    case 'ArrowUp': return { x: 0, y: -step };
    case 'ArrowDown': return { x: 0, y: step };
    case 'ArrowLeft': return { x: -step, y: 0 };
    case 'ArrowRight': return { x: step, y: 0 };
    default: return null;
  }
}
