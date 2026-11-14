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
