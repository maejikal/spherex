import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Node strips TS but not TSX. Compile this leaf component in memory with the
// project's existing compiler; no new DOM/test dependencies or generated files.
const source = readFileSync(new URL('../src/components/ConstellationCard.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText.replace(/from (['"])(react\/jsx-runtime|lucide-react)\1/g,
  (_, quote, name) => `from ${quote}${import.meta.resolve(name)}${quote}`);
const { ConstellationCard } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const render = (lookup, boundaryEnabled = false) => renderToStaticMarkup(createElement(ConstellationCard, {
  lookup, boundaryEnabled, onBoundaryChange: () => {},
}));

const data = {
  name: 'Orion', learnUrl: 'https://en.wikipedia.org/wiki/Orion_(constellation)',
  boundarySource: 'https://cdsarc.cds.unistra.fr/viz-bin/cat/VI/49',
};

test('constellation pending state announces lookup without inventing a name', () => {
  const markup = render({ isPending: true });
  assert.match(markup, /role="status"/);
  assert.match(markup, /Finding constellation/);
  assert.doesNotMatch(markup, /This position is in/);
});

test('constellation failure offers retry and never presents old metadata as success', () => {
  const markup = render({ isError: true, data });
  assert.match(markup, /Constellation lookup unavailable/);
  assert.match(markup, /Retry constellation lookup/);
  assert.doesNotMatch(markup, /This position is in|Learn about Orion/);
});

test('constellation success links to article and labels persistent boundary checkbox', () => {
  const markup = render({ isSuccess: true, data }, true);
  assert.match(markup, /<strong>Orion<\/strong>/);
  assert.match(markup, /Learn about Orion on Wikipedia/);
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /Official boundary outline/);
  assert.match(markup, /type="checkbox" checked=""/);
});


test('constellation hierarchy keeps article beside name and attribution in closed details', () => {
  const markup = render({ isSuccess: true, data });
  assert.match(markup, /class="constellation-card__identity"/);
  assert.match(markup, /aria-label="Learn about Orion on Wikipedia/);
  assert.match(markup, /<details class="constellation-card__details"><summary>About this boundary<\/summary>/);
  assert.doesNotMatch(markup, /<details[^>]* open/);
  assert.doesNotMatch(markup, /class="toggle-row"/);
});
