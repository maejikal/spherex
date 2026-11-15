import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Move, X } from 'lucide-react';
import { clampToArea, initialPosition, keyboardMoveDelta, placeAvoiding } from '../state/windows.ts';
import type { Box, Placement } from '../state/windows.ts';

interface ToolWindowProps {
  id: string;
  title: string;
  subtitle?: string;
  open: boolean;
  placement: Placement;
  /** Docked panels and mobile sheets retain content and floating position, but cannot be moved. */
  movable?: boolean;
  /** Preferred fixed height for media tools; resize/reposition before sacrificing their content area. */
  preferredHeight?: number;
  /**
   * How keyboard users move the window. `button` (default): a visible Move button toggles arrow-key movement.
   * `header`: no visible control; the focusable title bar does the same (Space/Enter, then arrows, Escape to stop).
   * Pointer dragging works from the header either way.
   */
  keyboardMove?: 'button' | 'header';
  /** For `placement="beside"` / `"left-of"`: id of the window to sit next to on first open. */
  anchorId?: string;
  /**
   * Element (by id) that confines a movable window instead of the whole workspace. The docked Blink Viewer
   * uses the sky viewer so it never covers the docked Find/View/Inspect cards; it also caps the window's size.
   */
  boundsId?: string;
  /** Windows (by id) this one should not cover when it is first placed, above all their title bars. */
  avoidIds?: readonly string[];
  /** Stacking value from the app's window order; a pointer-down on the window raises it. Applies docked too. */
  zIndex?: number;
  onFocus?: () => void;
  workspaceRef: { current: HTMLDivElement | null };
  onClose: () => void;
  children: ReactNode;
}

interface Position {
  x: number;
  y: number;
}

export function ToolWindow({
  id,
  title,
  subtitle,
  open,
  placement,
  movable = true,
  preferredHeight,
  keyboardMove: keyboardMoveMode = 'button',
  anchorId,
  boundsId,
  avoidIds,
  zIndex,
  onFocus,
  workspaceRef,
  onClose,
  children,
}: ToolWindowProps) {
  const panelRef = useRef<HTMLElement>(null);
  const pointerDrag = useRef<{ pointerId: number; x: number; y: number; origin: Position } | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [keyboardMove, setKeyboardMove] = useState(false);
  /** Live size cap from the confinement area, including the workspace after a manual move. */
  const [limit, setLimit] = useState<{ width: number; height: number } | null>(null);
  /**
   * While a window sits where it was auto-placed, it may not grow past the bottom of its area: growing
   * content (e.g. catalogue results) then scrolls instead of the clamp pushing it up over other title bars.
   * The cap is kept, but no longer updated, once the user moves the window.
   */
  const [heightCap, setHeightCap] = useState<number | null>(null);
  const autoPlaced = useRef(false);

  useLayoutEffect(() => {
    if (!movable) {
      pointerDrag.current = null;
      setKeyboardMove(false);
      return;
    }
    if (!open || position) return;
    const workspace = workspaceRef.current;
    const panel = panelRef.current;
    if (!workspace || !panel) return;

    // Only the first open is placed automatically; afterwards `position` holds wherever the user left it.
    const anchor = boxOf(anchorId, workspace);
    const area = confinement(workspace, boundsId);
    const nextLimit = limitFor(area);
    setLimit(nextLimit);
    const size = effectiveSize(panel, nextLimit, preferredHeight);
    const preferred = initialPosition({
      placement,
      workspace: { width: workspace.clientWidth, height: workspace.clientHeight },
      panel: size,
      anchor,
    });
    const obstacles = (avoidIds ?? []).map((other) => boxOf(other, workspace)).filter((box): box is Box => box !== null);
    if (obstacles.length > 0) {
      const placed = placeAvoiding({ preferred, area, panel: size, obstacles, minHeight: preferredHeight ? size.height : undefined });
      autoPlaced.current = preferredHeight === undefined;
      setHeightCap(preferredHeight === undefined ? Math.max(MIN_AUTO_HEIGHT, Math.floor(area.y + area.height - placed.y - 8)) : null);
      setPosition({ x: placed.x, y: placed.y });
    } else {
      autoPlaced.current = false;
      setHeightCap(null);
      setPosition(clampToArea(preferred, area, size));
    }
  }, [open, movable, preferredHeight, placement, anchorId, boundsId, avoidIds, position, workspaceRef]);

  useLayoutEffect(() => {
    if (!open || !movable) return;
    const workspace = workspaceRef.current;
    const panel = panelRef.current;
    if (!workspace || !panel) return;

    // Re-confine on any resize, including the docked columns opening/closing and switching layout.
    const reconfine = () => {
      const area = confinement(workspace, boundsId);
      const nextLimit = limitFor(area);
      setLimit((current) => current?.width === nextLimit?.width && current?.height === nextLimit?.height ? current : nextLimit);
      const size = effectiveSize(panel, nextLimit, preferredHeight);
      setPosition((current) => {
        if (!current) return current;
        const cap = autoPlaced.current ? Math.max(MIN_AUTO_HEIGHT, Math.floor(area.y + area.height - current.y - 8)) : null;
        const next = clampToArea(current, area, cap === null ? size : { width: size.width, height: Math.min(size.height, cap) });
        if (cap !== null) setHeightCap((previous) => (previous === cap ? previous : cap));
        return next.x === current.x && next.y === current.y ? current : next;
      });
    };
    const observer = new ResizeObserver(reconfine);
    observer.observe(workspace);
    observer.observe(panel);
    const bounds = boundsId ? document.getElementById(boundsId) : null;
    if (bounds) observer.observe(bounds);
    reconfine();
    return () => observer.disconnect();
  }, [open, movable, preferredHeight, boundsId, workspaceRef]);

  if (!open) return null;

  const moveBy = (dx: number, dy: number) => {
    const workspace = workspaceRef.current;
    const panel = panelRef.current;
    if (!workspace || !panel || !position) return;
    autoPlaced.current = false;
    setPosition(clampToArea({ x: position.x + dx, y: position.y + dy }, confinement(workspace, boundsId), effectiveSize(panel, limit, preferredHeight)));
  };

  /** Arrow keys move the window while keyboard-move mode is on; Escape leaves it. Shared by both modes. */
  const onMoveKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && keyboardMove) {
      event.preventDefault();
      setKeyboardMove(false);
      return;
    }
    if (!keyboardMove) return;
    const delta = keyboardMoveDelta(event.key, event.shiftKey);
    if (delta) {
      event.preventDefault();
      moveBy(delta.x, delta.y);
    }
  };
  const headerKeyboard = movable && keyboardMoveMode === 'header';

  return (
    <aside
      id={id}
      ref={panelRef}
      className={`tool-window tool-window--${id}`}
      aria-label={title}
      style={movable ? {
        height: preferredHeight,
        left: position ? position.x : placement === 'right-top' ? undefined : 16,
        right: !position && placement === 'right-top' ? 16 : undefined,
        top: position ? position.y : placement === 'left-bottom' ? undefined : 16,
        bottom: !position && placement === 'left-bottom' ? 16 : undefined,
        visibility: 'visible',
        maxWidth: limit ? limit.width : undefined,
        maxHeight: heightCap !== null || limit ? Math.min(heightCap ?? Infinity, limit?.height ?? Infinity) : undefined,
        zIndex,
      } : { zIndex }}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <header
        className={`tool-window__header${headerKeyboard && keyboardMove ? ' tool-window__header--moving' : ''}`}
        {...(headerKeyboard ? {
          tabIndex: 0,
          'aria-label': `${title} window title bar. Press Space to move it with the arrow keys; Escape to stop.`,
          'aria-description': keyboardMove ? 'Moving: use the arrow keys, Shift for larger steps, Escape to stop' : undefined,
          onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
            if (event.target !== event.currentTarget) return; // keys pressed on the buttons inside the header stay theirs
            if ((event.key === ' ' || event.key === 'Enter') && !keyboardMove) {
              event.preventDefault();
              setKeyboardMove(true);
              return;
            }
            onMoveKeyDown(event);
          },
          onBlur: (event: React.FocusEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget)) setKeyboardMove(false); },
        } : {})}
        onPointerDown={(event) => {
          if (!movable || (event.target as HTMLElement).closest('button')) return;
          const node = panelRef.current;
          if (!node || !position) return;
          event.preventDefault();
          autoPlaced.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
          pointerDrag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            origin: position,
          };
        }}
        onPointerMove={(event) => {
          const drag = pointerDrag.current;
          const workspace = workspaceRef.current;
          const panel = panelRef.current;
          if (!drag || drag.pointerId !== event.pointerId || !workspace || !panel) return;
          setPosition(
            clampToArea(
              { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y },
              confinement(workspace, boundsId),
              effectiveSize(panel, limit, preferredHeight),
            ),
          );
        }}
        onPointerUp={(event) => {
          if (pointerDrag.current?.pointerId === event.pointerId) pointerDrag.current = null;
        }}
        onPointerCancel={() => {
          pointerDrag.current = null;
        }}
        onLostPointerCapture={() => {
          pointerDrag.current = null;
        }}
      >
        <div className="tool-window__heading">
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {movable && keyboardMoveMode === 'button' && <button
          className="button button--quiet button--compact tool-window__move"
          type="button"
          aria-label={`Move ${title} window`}
          aria-pressed={keyboardMove}
          title="Press Space to move with arrow keys; press Escape to stop"
          onClick={() => setKeyboardMove((current) => !current)}
          onKeyDown={onMoveKeyDown}
        >
          <Move aria-hidden="true" size={14} />
          <span>{keyboardMove ? 'Moving' : 'Move'}</span>
        </button>}
        <button className="icon-button" type="button" aria-label={`Close ${title} window`} onClick={onClose}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <div className="tool-window__body">{children}</div>
    </aside>
  );
}

/** Smallest height an auto-placed window is given before it scrolls. */
const MIN_AUTO_HEIGHT = 240;

/** An element's box in workspace coordinates, or null when it is not rendered. */
function boxOf(id: string | undefined, workspace: HTMLElement): Box | null {
  const element = id ? document.getElementById(id) : null;
  const rect = element?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  const origin = workspace.getBoundingClientRect();
  return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height };
}

/** The area a window must stay inside: the `boundsId` element when rendered, else the whole workspace. */
function confinement(workspace: HTMLElement, boundsId: string | undefined): Box {
  return boxOf(boundsId, workspace) ?? { x: 0, y: 0, width: workspace.clientWidth, height: workspace.clientHeight };
}

function limitFor(area: Box): { width: number; height: number } {
  return { width: Math.max(0, Math.floor(area.width - 16)), height: Math.max(0, Math.floor(area.height - 16)) };
}

/** The window's rendered size once the size cap applies (the cap may not have been rendered yet). */
function effectiveSize(panel: HTMLElement, limit: { width: number; height: number } | null, preferredHeight?: number): { width: number; height: number } {
  return limit
    ? { width: Math.min(panel.offsetWidth, limit.width), height: Math.min(preferredHeight ?? panel.offsetHeight, limit.height) }
    : { width: panel.offsetWidth, height: preferredHeight ?? panel.offsetHeight };
}
