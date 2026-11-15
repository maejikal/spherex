import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const file = new URL('../src/components/BlinkViewer.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText.replace(/import \{ getBlinkCutouts, getBlinkModes, getDynamicBlink \} from [^;]+;/,
  'const getBlinkCutouts = () => { throw new Error("Unexpected API call in layout test"); }; const getBlinkModes = getBlinkCutouts; const getDynamicBlink = getBlinkCutouts;').replace(/from (['"])([^'"]+)\1/g, (_, quote, name) =>
  `from ${quote}${name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name)}${quote}`);
const { BlinkPlayer, BlinkDestination } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const analysis = {
  ra: 12, dec: -8, imageSize: 256, fieldOfViewArcmin: 6, pixelScaleArcsec: 1.4,
  frames: ['first', 'second'].map(id => ({ id, label: id, date: 'Test fixture', imageUrl: `/fixture-${id}`, coverageFraction: 1 })),
  warnings: [],
};

test('player isolates fitted image and secondary scroll region from persistent playback controls', () => {
  const markup = renderToStaticMarkup(createElement(BlinkPlayer, { analysis, switcher: createElement('div', null, 'Source') }));
  assert.match(markup, /class="blink-panel blink-panel--player"/);
  assert.match(markup, /class="blink-stage-area"/);
  const controls = markup.indexOf('aria-label="Blink controls"');
  const secondary = markup.indexOf('aria-label="Observation information"');
  assert.ok(controls > 0 && secondary > controls, 'controls precede independent scrolling metadata');
  assert.ok(markup.indexOf('class="blink-coverage-note"') > secondary);
  assert.ok(markup.indexOf('class="blink-details"') > secondary);
  assert.match(markup, /tabindex="0"[^>]*aria-label="Observation information"/);
});

test('destination shows captured name alongside coordinates, with honest unnamed fallback', () => {
  const named = renderToStaticMarkup(createElement(BlinkDestination, { target: { ra: 12, dec: -8, name: 'Fixture destination' } }));
  assert.match(named, /Fixture destination/);
  assert.match(named, /RA 12.00000°/);
  assert.match(named, /Dec -8.00000°/);
  for (const name of [undefined, '', '  ']) {
    const unnamed = renderToStaticMarkup(createElement(BlinkDestination, { target: { ra: 0, dec: 8, name } }));
    assert.match(unnamed, /Selected sky position/);
    assert.match(unnamed, /Dec \+8.00000°/);
  }
});

test('observation details provide a dedicated reading view with a visible return affordance', () => {
  const markup = renderToStaticMarkup(createElement(BlinkPlayer, { analysis, switcher: null }));
  assert.match(markup, /class="blink-details__content"/);
  assert.match(markup, /class="blink-details__return"[^>]*>Back to image<\/span>/);
  const css = readFileSync(new URL('../src/workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.blink-panel--player:has\(\.blink-details\[open\]\)\s*\{[^}]*display:\s*flex/);
  assert.match(css, /\.blink-panel--player:has\(\.blink-details\[open\]\)\s*>\s*\.blink-secondary\s*\{[^}]*max-height:\s*none/);
  assert.match(css, /\.blink-panel--player:has\(\.blink-details\[open\]\)\s*>\s*\.blink-controls\s*\{[^}]*order:\s*2/);
});


test('observation warning paragraphs have breathing room without affecting other callouts', () => {
  const css = readFileSync(new URL('../src/workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.blink-details__content \.callout p \+ p\s*\{[^}]*margin-top:\s*12px/);
});
