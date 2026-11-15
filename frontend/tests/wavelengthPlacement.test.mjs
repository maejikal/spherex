import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ts from 'typescript';

function componentUrl(file) {
  if (file.pathname.endsWith('/api/client.ts')) {
    return `data:text/javascript,${encodeURIComponent('export const findNearbyObjects = async () => []; export const getRandomTarget = async () => null; export const listSuggestedTargets = async () => []; export const resolveObjectName = async () => null;')}`;
  }
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const resolved = outputText.replace(/from (['"])([^'"]+)\1/g, (_, quote, name) => {
    const url = name.startsWith('.') ? new URL(name, file) : null;
    return `from ${quote}${url ? (name.endsWith('.tsx') || name.endsWith('/api/client.ts')) ? componentUrl(url) : url.href : import.meta.resolve(name)}${quote}`;
  });
  return `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
}
const { FindPanel, ViewPanel } = await import(componentUrl(new URL('../src/components/Panels.tsx', import.meta.url)));
// Synthetic channel metadata used only to test control placement and disabled states.
const survey = { depth: 2, wavelengthsUm: [1, 2], blankFrames: [] };
const view = { ra: 12, dec: -8, scale: 2, grid: false };
const noop = () => {};

for (const position of [null, view]) {
  test(`Find keeps wavelength directly below coordinates (${position ? 'loaded' : 'empty'})`, () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client },
      createElement(FindPanel, {
        view: position, onNavigate: noop, navigationGuard: {}, syncRevision: 0,
        survey, surveyPending: false, surveyError: null, frame: 0, loading: false, onChannelChange: noop,
      })));
    assert.match(markup, /Go to coordinates/);
    assert.match(markup, /Choose channel/);
    assert.match(markup, /<section class="panel-section find-wavelength-section" aria-labelledby="wavelength-heading"/);
    assert.ok(markup.indexOf('find-coordinates-heading') < markup.indexOf('wavelength-heading'));
    assert.ok(markup.indexOf('wavelength-heading') < markup.indexOf('suggested-heading'));
    assert.match(markup, /<\/form><\/section><section[^>]*aria-labelledby="wavelength-heading"/);
    assert.equal(/<select class="select-input" disabled=""/.test(markup), !position);
    client.clear();
  });
}

test('View contains navigation and overlays, never wavelength controls', () => {
  const markup = renderToStaticMarkup(createElement(ViewPanel, {
    view, width: 800, height: 600, crosshair: true, canReset: true,
    onZoom: noop, onPan: noop, onReset: noop, onGridChange: noop, onCrosshairChange: noop,
  }));
  assert.match(markup, /Navigate image/);
  assert.match(markup, /Overlays/);
  assert.doesNotMatch(markup, /Wavelength|Choose channel|wavelength-slider/);
});

test('Find wavelength section retains spacing and divider between coordinate and channel controls', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const rule = css.match(/\.find-panel-stack > \.panel-section\.find-wavelength-section\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, 'Dedicated Find wavelength spacing rule exists');
  assert.match(rule, /margin-top:\s*14px/);
  assert.match(rule, /padding-top:\s*12px/);
  assert.match(rule, /border-top:\s*1px solid/);
});
