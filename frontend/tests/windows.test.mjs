import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPanels, initialPosition, raise, togglePanel, zIndexFor } from '../src/state/windows.ts';

test('a fresh session opens only Find', () => {
  assert.deepEqual(initialPanels(), { find: true, view: false, inspect: false });
});

test('toggling opens and closes one window without touching the others', () => {
  const opened = togglePanel(initialPanels(), 'view');
  assert.deepEqual(opened, { find: true, view: true, inspect: false });
  assert.deepEqual(togglePanel(opened, 'view'), initialPanels());
  assert.deepEqual(togglePanel(opened, 'find'), { find: false, view: true, inspect: false });
  assert.deepEqual(initialPanels(), { find: true, view: false, inspect: false }); // not mutated
});

test('raising a window moves it to the front of the stacking order', () => {
  const order = ['find', 'view', 'inspect'];
  assert.deepEqual(raise(order, 'find'), ['view', 'inspect', 'find']);
  assert.deepEqual(raise(order, 'inspect'), order);
  assert.deepEqual(order, ['find', 'view', 'inspect']);
  const raised = raise(order, 'find');
  assert.ok(zIndexFor(raised, 'find') > zIndexFor(raised, 'view'));
  assert.ok(zIndexFor(raised, 'view') < zIndexFor(raised, 'inspect'));
});

const workspace = { width: 1440, height: 772 };
const find = { x: 16, y: 16, width: 352, height: 700 };

test('View opens to the right of Find with a 16px gap when there is room', () => {
  const pos = initialPosition({ placement: 'beside', workspace, panel: { width: 370, height: 600 }, anchor: find });
  assert.deepEqual(pos, { x: 16 + 352 + 16, y: 16 });
});

test('beside follows the anchor if the user already moved it', () => {
  const moved = { ...find, x: 300, y: 80 };
  assert.deepEqual(initialPosition({ placement: 'beside', workspace, panel: { width: 370, height: 600 }, anchor: moved }), { x: 668, y: 80 });
});

test('with no horizontal room View goes below Find; with no room at all it falls back to the corner', () => {
  const narrow = { width: 560, height: 1000 };
  assert.deepEqual(initialPosition({ placement: 'beside', workspace: narrow, panel: { width: 370, height: 300 }, anchor: { ...find, height: 400 } }), { x: 16, y: 432 });
  assert.deepEqual(initialPosition({ placement: 'beside', workspace: { width: 400, height: 772 }, panel: { width: 370, height: 600 }, anchor: find }), { x: 16, y: 16 });
});

test('without an anchor (Find closed) View opens at the top-left; other placements keep their corners', () => {
  assert.deepEqual(initialPosition({ placement: 'beside', workspace, panel: { width: 370, height: 600 }, anchor: null }), { x: 16, y: 16 });
  assert.deepEqual(initialPosition({ placement: 'right-top', workspace, panel: { width: 360, height: 500 } }), { x: 1440 - 360 - 16, y: 16 });
  assert.deepEqual(initialPosition({ placement: 'left-bottom', workspace, panel: { width: 360, height: 500 } }), { x: 16, y: 772 - 500 - 16 });
});


test('compact navigation opens one tool at a time without changing desktop toggles', () => {
  const panels = { find: true, view: false, inspect: true };
  assert.deepEqual(togglePanel(panels, 'view', true), { find: false, view: true, inspect: false });
  assert.deepEqual(togglePanel(panels, 'view'), { find: true, view: true, inspect: true });
  assert.deepEqual(panels, { find: true, view: false, inspect: true });
});

test('closing a compact tool does not reopen another tool', () => {
  const panels = { find: false, view: true, inspect: false };
  assert.deepEqual(togglePanel(panels, 'view', true), { find: false, view: false, inspect: false });
});
