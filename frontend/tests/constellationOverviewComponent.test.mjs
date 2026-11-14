import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const file = new URL('../src/components/ConstellationOverview.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText.replace(/from (['"])(react(?:\/jsx-runtime)?|\.\.\/sky\/constellationOverview\.ts)\1/g,
  (_, quote, name) => `from ${quote}${name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name)}${quote}`);
const { ConstellationOverview } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const constellation = {
  ra: 0, dec: 0, name: 'Pisces',
  boundary: [[[359, -1], [1, -1], [1, 1], [359, 1], [359, -1]]],
};

test('overview provides named SVG, separate outline and selected-position marker', () => {
  const markup = renderToStaticMarkup(createElement(ConstellationOverview, { constellation }));
  assert.match(markup, /aria-label="Pisces constellation overview"/);
  assert.match(markup, /role="img"/);
  assert.match(markup, /Full official boundary of Pisces/);
  assert.match(markup, /class="constellation-overview__boundary"/);
  assert.match(markup, /class="constellation-overview__marker"/);
  assert.match(markup, /Selected position/);
  assert.doesNotMatch(markup, /NaN|Infinity/);
});

test('unrenderable overview gives explicit unavailable state, never fake geometry', () => {
  const markup = renderToStaticMarkup(createElement(ConstellationOverview, { constellation: { ...constellation, boundary: [] } }));
  assert.match(markup, /Boundary overview unavailable/);
  assert.doesNotMatch(markup, /<svg/);
});
