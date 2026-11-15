import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const file = new URL('../src/components/review/DemoAccountSwitcher.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText.replace(/from (['"])([^'"]+)\1/g, (_, quote, name) =>
  `from ${quote}${name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name)}${quote}`);
const { DemoAccountSwitcher } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`);

test('demo selector shows six profiles with current account selected and no login fields', () => {
  const markup = renderToStaticMarkup(createElement(DemoAccountSwitcher,{identity:'reviewer-3',onChange:()=>{}}));
  assert.equal((markup.match(/<option /g) ?? []).length,6);
  assert.match(markup,/value="reviewer-3" selected=""/);
  assert.match(markup,/Jordan \(Demo\)/);
  assert.match(markup,/no sign-in/);
  assert.doesNotMatch(markup,/password|email|<form/);
});
test('compact header selector remains explicitly labelled as demo account', () => {
  const markup = renderToStaticMarkup(createElement(DemoAccountSwitcher,{identity:'author',onChange:()=>{},compact:true}));
  assert.match(markup,/demo-account--compact/);
  assert.match(markup,/>Demo account<\/label>/);
  const id = markup.match(/<select id="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.ok(markup.includes(`for="${id}"`));
});
