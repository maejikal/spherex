/**
 * Workaround for Aladin Lite 3.8.2: its built-in right-click menu cannot be turned off through options.
 *
 * `showContextMenu: false` only skips attaching the default actions at start-up. `_setupUI` always creates
 * `aladin.contextMenu`, and the canvas `contextmenu` handler re-attaches and shows the default actions
 * ("Load a local file", "Add → New image layer", "What is this?", ...) whenever that property is set.
 * Those actions bypass this app: they add layers that hide the SPHEREx imagery and cannot be removed
 * here, fail silently for unreadable files, and contact CDS services directly.
 *
 * Every read of `aladin.contextMenu` in 3.8.2 that a user can reach is guarded (`menu && ...`), and the
 * canvas handler still calls `preventDefault()` first, so clearing the property removes the menu without
 * bringing back the browser's own context menu. Left-click selection, dragging, wheel zoom and
 * double-click do not use the menu. `contextMenu` is an undocumented internal: re-check this (and the
 * regression test in tests/aladinController.test.mjs) when upgrading Aladin Lite.
 */
export function disableBuiltInContextMenu(aladin: object): boolean {
  const instance = aladin as { contextMenu?: { _hide?: () => void } | null };
  if (!('contextMenu' in instance) || instance.contextMenu == null) return false;
  try {
    instance.contextMenu._hide?.();
  } catch {
    /* the menu was never shown */
  }
  instance.contextMenu = null;
  return true;
}
