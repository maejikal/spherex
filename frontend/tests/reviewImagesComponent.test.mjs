import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const file = new URL('../src/components/review/ReviewImages.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText.replace(/from (['"])([^'"]+)\1/g, (_, quote, name) =>
  `from ${quote}${name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name)}${quote}`);
const { ReviewImage, FrameMetadata, AnalysisMetadata } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);
const frame = { id: 'f', label: 'Fixture epoch', imageUrl: '/fixture.png' };

test('annotation exposes image keyboard instructions, independent mark and explicit visibility controls', () => {
  const markup = renderToStaticMarkup(createElement(ReviewImage, { frame, size: 256, src: '/fixture.png', mark: {x:15,y:18}, onMark: () => {} }));
  assert.match(markup, /role="button"/);
  assert.match(markup, /arrow keys move 0.1 pixel/);
  assert.match(markup, /Crosshair at x 15.00, y 18.00/);
  assert.match(markup, /original pixels, top-left origin/);
  assert.match(markup, /Not visible/);
  assert.match(markup, /click and drag/i);
  assert.match(markup, /Zoom Fixture epoch/);
  assert.match(markup, /8×/);
  assert.doesNotMatch(markup, /NaN|Infinity/);
});
test('explicitly invisible frame differs from unaccounted frame; saved evidence has no editing controls', () => {
  const invisible = renderToStaticMarkup(createElement(ReviewImage, { frame, size:256, src:'/fixture.png', mark:null }));
  const pending = renderToStaticMarkup(createElement(ReviewImage, { frame, size:256, src:'/fixture.png', mark:undefined }));
  assert.match(invisible, /Not visible in this image/);
  assert.match(pending, /Not yet marked/);
  assert.doesNotMatch(invisible, /Place crosshair|role="button"/);
  const missing = renderToStaticMarkup(createElement(ReviewImage, { frame, size:256, mark:null }));
  assert.match(missing, /Saved image unavailable/);
});
test('metadata does not invent missing times, wavelengths, IDs, release or source', () => {
  const metadata = renderToStaticMarkup(createElement(FrameMetadata, {frame}));
  assert.equal((metadata.match(/Unavailable/g) ?? []).length, 4);
  assert.doesNotMatch(metadata, /Original image URL|\/fixture.png/);
  const analysis = renderToStaticMarkup(createElement(AnalysisMetadata, {analysis: {ra:1,dec:-2,imageSize:256,pixelScaleArcsec:6,mode:'local',warnings:['Fixture warning']}}));
  assert.match(analysis, /Fixture warning/);
  assert.match(analysis, /not measured celestial positions/);
  assert.doesNotMatch(analysis, /NaN|Infinity|undefined|SPHEREx local observations/);
});
