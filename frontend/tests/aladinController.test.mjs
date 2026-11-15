import test from 'node:test';
import assert from 'node:assert/strict';
import { AladinController } from '../src/sky/aladin/controller.ts';

test('native double-click recenters exact clicked sky position despite stale emitted view', () => {
  const originalWindow = globalThis.window;
  let nextTimerId = 0;
  globalThis.window = {
    setTimeout: () => ++nextTimerId,
    clearTimeout: () => {},
  };

  try {
    let current = { ra: 142, dec: 24, fov: 1.5 };
    const pixelCalls = [];
    const navigations = [];
    let receivedPosition = null;
    let prevented = false;
    let stopped = false;
    let controller;
    const aladin = {
      getRaDec: () => [current.ra, current.dec],
      getFov: () => [current.fov, current.fov],
      pix2world: (x, y) => {
        pixelCalls.push([x, y]);
        return [360.25, -7.25];
      },
      gotoRaDec: (ra, dec) => {
        navigations.push([ra, dec]);
        current = { ...current, ra, dec };
      },
      remove: () => {},
    };
    const callbacks = {
      onClick: () => {},
      onDoubleClick: (position) => {
        receivedPosition = position;
        controller.centerOn(position);
      },
      onHover: () => {},
      onLoading: () => {},
      onTileErrors: () => {},
      onUserView: () => {},
    };
    const container = {
      getBoundingClientRect: () => ({ left: 100, top: 50 }),
      replaceChildren: () => {},
      remove: () => {},
      removeEventListener: () => {},
    };
    controller = new AladinController({}, aladin, { container, initial: { frame: 1 }, callbacks });
    controller.lastEmitted = { ra: 0.25, dec: -7.25, fov: 1.5 };

    Reflect.get(controller, 'handleDoubleClick').call(controller, {
      clientX: 120,
      clientY: 80,
      preventDefault: () => { prevented = true; },
      stopPropagation: () => { stopped = true; },
    });

    assert.deepEqual(pixelCalls, [[20, 30]]);
    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.deepEqual(receivedPosition, { ra: 0.25, dec: -7.25 });
    assert.deepEqual(navigations, [[0.25, -7.25]]);
    assert.deepEqual(controller.getView(), { ra: 0.25, dec: -7.25, fov: 1.5 });
    controller.destroy();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('constellation overlay replaces geometry, clears stale outlines and never moves view', () => {
  const layers = [];
  const overlay = { shapes: [], removeAll() { this.shapes = []; }, addFootprints(shapes) { this.shapes.push(...shapes); } };
  const A = { graphicOverlay: () => overlay, polyline: (points, options) => ({ points, options }) };
  const controller = new AladinController(A, { addOverlay: (layer) => layers.push(layer) }, { initial: { frame: 1 } });
  const ring = [[359, 0], [0, 0], [0, 1], [359, 0]];
  controller.setConstellationBoundary([ring]);
  assert.equal(layers.length, 1);
  assert.deepEqual(overlay.shapes[0].points, ring);
  controller.setConstellationBoundary([ring, ring]);
  assert.equal(layers.length, 1);
  assert.equal(overlay.shapes.length, 2);
  controller.setConstellationBoundary(null);
  assert.equal(overlay.shapes.length, 0);
});

test('BUG-002/003: the controller removes Aladin\'s built-in right-click menu when it attaches', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { fetch: async () => ({ status: 200 }), setTimeout: () => 1, clearTimeout: () => {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} };
  try {
    let hidden = 0;
    const handlers = {};
    // Aladin Lite 3.8.2 always creates `contextMenu` in _setupUI, even with showContextMenu: false.
    const aladin = {
      contextMenu: { _hide: () => { hidden += 1; }, attach: () => { throw new Error('menu must not be attached'); } },
      setBaseImageLayer: () => {},
      setCooGrid: () => {},
      addCatalog: () => {},
      on: (name, handler) => { handlers[name] = handler; },
      getRaDec: () => [10, 20],
      getFov: () => [1, 1],
      remove: () => {},
    };
    const A = { imageHiPS: () => ({}), catalog: () => ({ removeAll: () => {}, addSources: () => {} }), source: () => ({}) };
    const container = { addEventListener: () => {}, removeEventListener: () => {}, replaceChildren: () => {}, remove: () => {} };
    const clicks = [];
    const callbacks = { onClick: (p) => clicks.push(p), onDoubleClick: () => {}, onHover: () => {}, onLoading: () => {}, onTileErrors: () => {}, onUserView: () => {} };
    const controller = new AladinController(A, aladin, { container, hipsUrl: 'https://irsa.example/hips', initial: { frame: 1, grid: false }, callbacks });
    Reflect.get(controller, 'attach').call(controller);
    assert.equal(aladin.contextMenu, null, 'Aladin\'s canvas contextmenu handler shows nothing when the menu is null');
    assert.equal(hidden, 1);
    // Ordinary left-click selection still goes through.
    handlers.click({ ra: 370.5, dec: -12, isDragging: false });
    handlers.click({ ra: 20, dec: 5, isDragging: true });
    assert.deepEqual(clicks, [{ ra: 10.5, dec: -12 }]);
    controller.destroy();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test('BUG-002: disableBuiltInContextMenu is safe when the internal is missing or already cleared', async () => {
  const { disableBuiltInContextMenu } = await import('../src/sky/aladin/contextMenu.ts');
  assert.equal(disableBuiltInContextMenu({}), false);
  assert.equal(disableBuiltInContextMenu({ contextMenu: null }), false);
  const instance = { contextMenu: { _hide: () => { throw new Error('never shown'); } } };
  assert.equal(disableBuiltInContextMenu(instance), true);
  assert.equal(instance.contextMenu, null);
});

test('BUG-007: loading tiles or tile errors do not block sky selection', async () => {
  const { skyInteraction } = await import('../src/sky/aladin/interaction.ts');
  assert.deepEqual(skyInteraction({ ready: true, unavailable: false }), { interactive: true, canSelect: true });
  assert.deepEqual(skyInteraction({ ready: false, unavailable: false }), { interactive: false, canSelect: false });
  assert.deepEqual(skyInteraction({ ready: true, unavailable: true }), { interactive: false, canSelect: false });
  // The function deliberately has no loading/tile-error input: imagery status is shown, not used as a gate.
  assert.equal(skyInteraction.length, 1);
});
