import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Move, X } from 'lucide-react';
import { initialPosition } from '../state/windows.ts';
import type { Placement } from '../state/windows.ts';

interface ToolWindowProps {
  id: string;
  title: string;
  subtitle: string;
  open: boolean;
  placement: Placement;
  /** For `placement="beside"`: id of the window to sit next to on first open. */
  anchorId?: string;
  /** Stacking value from the app's window order; a pointer-down on the window raises it. */
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
  anchorId,
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

  useLayoutEffect(() => {
    if (!open || position) return;
    const workspace = workspaceRef.current;
    const panel = panelRef.current;
    if (!workspace || !panel) return;

    // Only the first open is placed automatically; afterwards `position` holds wherever the user left it.
    const workspaceBox = workspace.getBoundingClientRect();
    const anchorElement = anchorId ? document.getElementById(anchorId) : null;
    const anchorRect = anchorElement?.getBoundingClientRect();
    const anchor = anchorRect && anchorRect.width > 0
      ? { x: anchorRect.left - workspaceBox.left, y: anchorRect.top - workspaceBox.top, width: anchorRect.width, height: anchorRect.height }
      : null;
    const next = initialPosition({
      placement,
      workspace: { width: workspace.clientWidth, height: workspace.clientHeight },
      panel: { width: panel.offsetWidth, height: panel.offsetHeight },
      anchor,
    });
    setPosition(clampPosition(next, workspace, panel));
  }, [open, placement, anchorId, position, workspaceRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const workspace = workspaceRef.current;
    const panel = panelRef.current;
    if (!workspace || !panel) return;

    const observer = new ResizeObserver(() => {
      setPosition((current) => {
        if (!current) return current;
        const next = clampPosition(current, workspace, panel);
        return next.x === current.x && next.y === current.y ? current : next;
      });
    });
    observer.observe(workspace);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [open, workspaceRef]);

  if (!open) return null;

  const moveBy = (dx: number, dy: number) => {
    const workspace = workspaceRef.current;
    const panel = panelRef.current;
    if (!workspace || !panel || !position) return;
    setPosition(clampPosition({ x: position.x + dx, y: position.y + dy }, workspace, panel));
  };

  return (
    <aside
      id={id}
      ref={panelRef}
      className={`tool-window tool-window--${id}`}
      aria-label={title}
      style={{
        left: position ? position.x : placement === 'right-top' ? undefined : 16,
        right: !position && placement === 'right-top' ? 16 : undefined,
        top: position ? position.y : placement === 'left-bottom' ? undefined : 16,
        bottom: !position && placement === 'left-bottom' ? 16 : undefined,
        visibility: 'visible',
        zIndex,
      }}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      <header
        className="tool-window__header"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          const node = panelRef.current;
          if (!node || !position) return;
          event.preventDefault();
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
            clampPosition(
              { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y },
              workspace,
              panel,
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
          <p>{subtitle}</p>
        </div>
        <button
          className="button button--quiet button--compact tool-window__move"
          type="button"
          aria-label={`Move ${title} window`}
          aria-pressed={keyboardMove}
          title="Press Space to move with arrow keys; press Escape to stop"
          onClick={() => setKeyboardMove((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && keyboardMove) {
              event.preventDefault();
              setKeyboardMove(false);
              return;
            }
            if (!keyboardMove) return;
            const step = event.shiftKey ? 24 : 8;
            const movement: Record<string, Position> = {
              ArrowUp: { x: 0, y: -step },
              ArrowDown: { x: 0, y: step },
              ArrowLeft: { x: -step, y: 0 },
              ArrowRight: { x: step, y: 0 },
            };
            const delta = movement[event.key];
            if (delta) {
              event.preventDefault();
              moveBy(delta.x, delta.y);
            }
          }}
        >
          <Move aria-hidden="true" size={14} />
          <span>{keyboardMove ? 'Moving' : 'Move'}</span>
        </button>
        <button className="icon-button" type="button" aria-label={`Close ${title} window`} onClick={onClose}>
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <div className="tool-window__body">{children}</div>
    </aside>
  );
}

function clampPosition(position: Position, workspace: HTMLElement, panel: HTMLElement): Position {
  const gap = 8;
  const maxX = Math.max(gap, workspace.clientWidth - panel.offsetWidth - gap);
  const maxY = Math.max(gap, workspace.clientHeight - panel.offsetHeight - gap);
  return {
    x: Math.min(maxX, Math.max(gap, position.x)),
    y: Math.min(maxY, Math.max(gap, position.y)),
  };
}
