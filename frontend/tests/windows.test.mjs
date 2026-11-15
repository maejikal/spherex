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

import { keyboardMoveDelta } from '../src/state/windows.ts';

test('keyboard move: arrow keys step 8 px (24 with Shift); any other key does nothing', () => {
  assert.deepEqual(keyboardMoveDelta('ArrowLeft', false), { x: -8, y: 0 });
  assert.deepEqual(keyboardMoveDelta('ArrowRight', false), { x: 8, y: 0 });
  assert.deepEqual(keyboardMoveDelta('ArrowUp', false), { x: 0, y: -8 });
  assert.deepEqual(keyboardMoveDelta('ArrowDown', true), { x: 0, y: 24 });
  for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'Home']) assert.equal(keyboardMoveDelta(key, false), null, key);
});

test('BUG-011: placeAvoiding keeps the preferred spot when it is clear', async () => {
  const { placeAvoiding } = await import('../src/state/windows.ts');
  const area = { x: 0, y: 0, width: 1440, height: 764 };
  const position = placeAvoiding({ preferred: { x: 600, y: 200 }, area, panel: { width: 480, height: 500 }, obstacles: [{ x: 16, y: 16, width: 320, height: 300 }] });
  assert.deepEqual(position, { x: 600, y: 200 });
});

test('BUG-011: placeAvoiding never covers another window\'s title bar when there is room elsewhere', async () => {
  const { placeAvoiding, HEADER_HEIGHT } = await import('../src/state/windows.ts');
  const area = { x: 0, y: 0, width: 1440, height: 764 };
  const find = { x: 16, y: 16, width: 320, height: 300 };
  const view = { x: 352, y: 16, width: 340, height: 620 };
  const inspect = { x: 1064, y: 16, width: 360, height: 700 };
  const panel = { width: 480, height: 520 };
  // Preferred (left of Inspect, bottom-aligned) overlaps View.
  const p = placeAvoiding({ preferred: { x: 568, y: 228 }, area, panel, obstacles: [find, view, inspect] });
  const box = { ...p, ...panel };
  for (const o of [find, view, inspect]) {
    const header = { x: o.x, y: o.y, width: o.width, height: HEADER_HEIGHT };
    const overlaps = box.x < header.x + header.width && header.x < box.x + box.width && box.y < header.y + header.height && header.y < box.y + box.height;
    assert.equal(overlaps, false, `covers a title bar at ${JSON.stringify(o)}`);
  }
  assert.ok(p.x >= 8 && p.y >= 8 && p.x + panel.width <= 1432 && p.y + panel.height <= 756, 'stays inside the workspace');
});

test('BUG-011: docked confinement keeps the Blink Viewer inside the sky area (tablet portrait)', async () => {
  const { clampToArea } = await import('../src/state/windows.ts');
  // 820x1180 docked: Find/View column 0-272, sky 272-568, Inspect 568-820. Blink capped to sky width - 16.
  const sky = { x: 272, y: 0, width: 296, height: 1005 };
  const panel = { width: 280, height: 700 };
  const p = clampToArea({ x: 72, y: 289 }, sky, panel);
  assert.deepEqual(p, { x: 280, y: 289 });
  assert.ok(p.x >= sky.x && p.x + panel.width <= sky.x + sky.width, 'never over the docked columns');
  // A window larger than the area pins to its top-left corner rather than leaving it.
  assert.deepEqual(clampToArea({ x: 900, y: 900 }, sky, { width: 400, height: 2000 }), { x: 280, y: 8 });
});

test('BUG-011: on a small floating workspace a window opens below other title bars, shortened, instead of covering them', async () => {
  const { placeAvoiding, HEADER_HEIGHT } = await import('../src/state/windows.ts');
  // 820x1180 floating (workspace coords): Find and View side by side; Inspect (360x671) prefers right-top.
  const area = { x: 0, y: 0, width: 820, height: 1035 };
  const find = { x: 16, y: 16, width: 352, height: 597 };
  const view = { x: 384, y: 16, width: 370, height: 620 };
  const p = placeAvoiding({ preferred: { x: 444, y: 16 }, area, panel: { width: 360, height: 671 }, obstacles: [find, view] });
  assert.ok(p.y >= view.y + HEADER_HEIGHT, `opens below View's title bar (y=${p.y})`);
  assert.ok(p.y + (p.height ?? 671) <= area.height - 8, 'still inside the workspace');
  // 1024x768: too short for the full height below the headers, so it is shortened (never below 240 px).
  const short = { x: 0, y: 0, width: 1024, height: 623 };
  const q = placeAvoiding({ preferred: { x: 648, y: 8 }, area: short, panel: { width: 360, height: 607 }, obstacles: [{ x: 16, y: 16, width: 352, height: 597 }, { x: 384, y: 8, width: 370, height: 607 }] });
  assert.ok(q.y >= 8 + HEADER_HEIGHT && q.height >= 240 && q.y + q.height <= 615, JSON.stringify(q));
});
