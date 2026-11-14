import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinateAtPixelOffset,
  panCenterByDrag,
  pixelOffsetOfCoordinate,
} from '../src/sky/coordinates.ts';
import { placeImage } from '../src/sky/placement.ts';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? ''} expected ${expected}, got ${actual}`);

const surface = { surfaceWidth: 1000, surfaceHeight: 600, cssPerViewPixel: 1 };
const imageAt = (center, scale = 0.4) => ({ imageCenter: center, imageScale: scale, imageWidth: 1000, imageHeight: 600 });

test('forward projection is the exact inverse of coordinateAtPixelOffset (incl. RA wrap and high Dec)', () => {
  for (const center of [{ ra: 180, dec: 0.5 }, { ra: 359.99, dec: 10 }, { ra: 0.01, dec: -45 }, { ra: 10, dec: 85 }, { ra: 200, dec: -85 }]) {
    for (const [x, y] of [[0, 0], [300, -200], [-750, 410], [20, 20]]) {
      const target = coordinateAtPixelOffset(center, x, y, 0.4);
      const back = pixelOffsetOfCoordinate(center, target, 0.4);
      near(back.x, x, 1e-6, `x @${center.ra},${center.dec}`);
      near(back.y, y, 1e-6, `y @${center.ra},${center.dec}`);
    }
  }
});

test('far-hemisphere targets have no projection', () => {
  assert.equal(pixelOffsetOfCoordinate({ ra: 0, dec: 0 }, { ra: 180, dec: 0 }, 1), null);
});

test('after a drag the old image stays exactly where the pointer left it (Test A)', () => {
  const view = { ra: 180, dec: 0.5 };
  const dragX = 200; // pointer moved right: image follows right
  const next = panCenterByDrag(view, 0.4, dragX, 0);
  const p = placeImage({ viewCenter: next, viewScale: 0.4, ...imageAt(view), ...surface });
  near(p.left, dragX, 0.01, 'left'); // was 0 before the drag
  near(p.top, 0, 0.01, 'top');
  assert.equal(p.coversViewport, false); // grey strip is exposed on the left
  assert.ok(p.left > 0);
});

test('consecutive drags accumulate without snap-back (Test B)', () => {
  let center = { ra: 180, dec: 0.5 };
  const original = { ...center };
  center = panCenterByDrag(center, 0.4, -100, 0);
  center = panCenterByDrag(center, 0.4, -150, 0);
  const p = placeImage({ viewCenter: center, viewScale: 0.4, ...imageAt(original), ...surface });
  near(p.left, -250, 0.05);
});

test('placement agrees with astronomy at high declination and across the RA seam (Test F)', () => {
  // Tolerance reflects projection geometry, not error: gnomonic offsets are not translation-invariant,
  // and meridians converge near the pole (about 0.5% of the total drag at Dec 86).
  for (const [start, tolerance] of [[{ ra: 359.999, dec: 5 }, 0.5], [{ ra: 40, dec: 86 }, 3]]) {
    let center = start;
    const drags = [[120, -40], [-300, 90], [75, 75], [-10, 200]];
    let sx = 0, sy = 0;
    for (const [dx, dy] of drags) {
      center = panCenterByDrag(center, 0.4, dx, dy);
      sx += dx; sy += dy;
    }
    const p = placeImage({ viewCenter: center, viewScale: 0.4, ...imageAt(start), ...surface });
    near(p.left + p.width / 2 - 500, sx, tolerance, 'x');
    near(p.top + p.height / 2 - 300, sy, tolerance, 'y');
  }
});

test('no drift: panning out and back returns to the original centre', () => {
  const start = { ra: 10.5, dec: 33.3 };
  let center = start;
  const steps = [[137, -44], [-91, 210], [15, 15], [300, -120]];
  for (const [dx, dy] of steps) center = panCenterByDrag(center, 0.4, dx, dy);
  for (const [dx, dy] of [...steps].reverse()) center = panCenterByDrag(center, 0.4, -dx, -dy);
  near(center.ra, start.ra, 1e-3, 'ra'); // gnomonic steps are not exactly commutative; sub-arcsec
  near(center.dec, start.dec, 1e-3, 'dec');
});

test('zoom: image is scaled by scale ratio, and hidden once stretched too far', () => {
  const c = { ra: 50, dec: 20 };
  const zoomedIn = placeImage({ viewCenter: c, viewScale: 0.2, ...imageAt(c, 0.4), ...surface });
  near(zoomedIn.zoom, 2, 1e-9);
  near(zoomedIn.width, 2000, 1e-6);
  assert.equal(zoomedIn.coversViewport, true);
  const zoomedOut = placeImage({ viewCenter: c, viewScale: 0.8, ...imageAt(c, 0.4), ...surface });
  assert.equal(zoomedOut.coversViewport, false); // grey exposed around a smaller image
  assert.equal(placeImage({ viewCenter: c, viewScale: 0.05, ...imageAt(c, 0.4), ...surface }), null);
  assert.equal(placeImage({ viewCenter: c, viewScale: 4, ...imageAt(c, 0.4), ...surface }), null);
});

test('an image centred on the view covers it exactly when sizes match', () => {
  const c = { ra: 1, dec: 1 };
  const p = placeImage({ viewCenter: c, viewScale: 0.4, ...imageAt(c), ...surface });
  assert.deepEqual([p.left, p.top, p.width, p.height, p.coversViewport], [0, 0, 1000, 600, true]);
});
