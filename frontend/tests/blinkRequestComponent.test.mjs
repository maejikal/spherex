import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { BLINK_FOV_OPTIONS } from '../src/sky/blink/config.ts';
import { dynamicBlinkPath } from '../src/sky/blink/response.ts';

// Exercise real form handlers and query options without a new DOM/test dependency.
const file = new URL('../src/components/BlinkViewer.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText
  .replace(/import \{[^}]+\} from 'react';/, 'const { useState, useEffect } = globalThis.blinkRequestHooks;')
  .replace(/import \{ useQuery \} from [^;]+;/, 'const useQuery = globalThis.blinkRequestHooks.useQuery;')
  .replace(/import \{ useLoadingRun \} from [^;]+;/, 'const useLoadingRun = () => null;')
  .replace(/import \{ getBlinkCutouts, getBlinkModes, getDynamicBlink \} from [^;]+;/,
    'const { getBlinkCutouts, getBlinkModes, getDynamicBlink } = globalThis.blinkRequestHooks;')
  .replace(/from (['"])([^'"]+)\1/g, (_, quote, name) =>
    `from ${quote}${name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name)}${quote}`);

async function setup(t) {
  const previous = globalThis.blinkRequestHooks;
  t.after(() => { globalThis.blinkRequestHooks = previous; });
  const slots = [];
  let cursor = 0;
  let options;
  let result = {};
  let tree;
  const calls = [];
  const props = {
    target: { ra: 12, dec: -8 }, mode: 'dynamic',
    onModeChange: (mode) => { props.mode = mode; },
    onFlagForReview() {}, onGoToCoveredRegion() {},
  };
  globalThis.blinkRequestHooks = {
    useEffect() {},
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useQuery(value) {
      if (value.queryKey[1] === 'modes') return { data: { dynamicEnabled: true, localDemoAvailable: true } };
      options = value;
      return { ...result, refetch: () => calls.push('retry') };
    },
    getBlinkModes() {},
    getDynamicBlink: (...args) => calls.push(['dynamic', ...args]),
    getBlinkCutouts: (...args) => calls.push(['local', ...args]),
  };
  const { BlinkViewer } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}#${Math.random()}`);
  function render() { cursor = 0; tree = BlinkViewer(props); return tree; }
  function walk(predicate, node) {
    if (Array.isArray(node)) return node.flatMap((child) => walk(predicate, child));
    if (!node || typeof node !== 'object') return [];
    return [...(predicate(node) ? [node] : []), ...walk(predicate, node.props?.children), ...walk(predicate, node.props?.switcher)];
  }
  const find = (predicate) => walk(predicate, tree);
  function submit() {
    const form = find((node) => node.type === 'form')[0];
    assert.ok(form, 'explicit load form available before requests');
    form.props.onSubmit({ preventDefault() {} });
    render();
  }
  render();
  return { props, calls, render, find, submit, get options() { return options; }, setResult(value) { result = value; render(); } };
}

test('opening blink and editing FOV sends no observation request until Load', async (t) => {
  const view = await setup(t);
  assert.equal(view.options.enabled, false);
  const select = view.find((node) => node.type === 'select' && node.props['aria-label'] === 'Field of view')[0];
  assert.ok(select, 'labelled field-of-view selector');
  assert.equal(select.props.value, 0.1);
  select.props.onChange({ target: { value: '0.2' } });
  view.render();
  assert.equal(view.options.enabled, false);
  assert.deepEqual(view.calls, []);
  view.submit();
  assert.equal(view.options.enabled, true);
  const signal = new AbortController().signal;
  view.options.queryFn({ signal });
  assert.deepEqual(view.calls, [['dynamic', view.props.target, 0.2, signal, null, null]]);
  assert.ok(view.options.queryKey.includes(0.2));
});

test('FOV and wavelength edits preserve submitted request until explicitly applied', async (t) => {
  const view = await setup(t);
  view.props.survey = { depth: 2, wavelengthsUm: [0.753, 0.771], blankFrames: [] };
  view.submit();
  const originalKey = view.options.queryKey;
  view.find((node) => node.type === 'select' && node.props['aria-label'] === 'Field of view')[0].props.onChange({ target: { value: '0.05' } });
  view.find((node) => node.type?.name === 'BlinkSpectralControls')[0].props.onChange(1);
  view.render();
  assert.deepEqual(view.options.queryKey, originalKey);
  view.submit();
  assert.notDeepEqual(view.options.queryKey, originalKey);
  view.options.queryFn({});
  assert.deepEqual(view.calls.at(-1), ['dynamic', view.props.target, 0.05, undefined, 0.771, null]);
});

test('new target and source wait for Load; local mode does not pretend to set angular FOV', async (t) => {
  const view = await setup(t);
  view.submit();
  view.props.target = { ra: 24, dec: -12 };
  view.render();
  assert.equal(view.options.enabled, false);
  view.submit();
  assert.equal(view.options.enabled, true);
  view.props.mode = 'local';
  view.render();
  assert.equal(view.options.enabled, false);
  assert.equal(view.find((node) => node.type === 'select' && node.props['aria-label'] === 'Field of view').length, 0);
  view.submit();
  view.options.queryFn({});
  assert.deepEqual(view.calls.at(-1), ['local', view.props.target, 256, undefined]);
});

test('draft edits leave loaded player and retry tied to original request', async (t) => {
  const view = await setup(t);
  view.submit();
  const analysis = { frames: [{ imageUrl: '/first' }, { imageUrl: '/second' }] };
  view.setResult({ data: analysis });
  view.find((node) => node.type === 'select' && node.props['aria-label'] === 'Field of view')[0].props.onChange({ target: { value: '0.5' } });
  view.render();
  assert.equal(view.find((node) => node.type?.name === 'BlinkPlayer')[0].props.analysis, analysis);
  const settings = view.find((node) => node.type === 'details' && node.props.className === 'blink-settings')[0];
  assert.ok(settings);
  assert.ok(!settings.props.open, 'loaded settings start collapsed so imagery stays primary');
  view.options.queryFn({});
  assert.equal(view.calls.at(-1)[2], 0.1);
});

test('all FOV presets stay within archive bounds and serialize in degrees', () => {
  assert.deepEqual(BLINK_FOV_OPTIONS.map(option => option.degrees), [0.02, 0.05, 0.1, 0.2, 0.3, 0.5]);
  for (const option of BLINK_FOV_OPTIONS) {
    assert.ok(option.degrees >= 0.02 && option.degrees <= 0.5);
    assert.equal(option.label, `${option.degrees}° × ${option.degrees}°`);
    const url = new URL(dynamicBlinkPath({ ra: 12, dec: -8 }, option.degrees), 'http://localhost');
    assert.equal(Number(url.searchParams.get('fov_deg')), option.degrees);
  }
});

test('retry keeps failed submitted FOV while a changed draft waits for Load', async (t) => {
  const view = await setup(t);
  view.submit();
  view.setResult({ isError: true, error: { status: 502, code: 'upstream_timeout', message: 'Fixture timeout' } });
  view.find(node => node.type === 'select' && node.props['aria-label'] === 'Field of view')[0].props.onChange({ target: { value: '0.3' } });
  view.render();
  const retry = view.find(node => node.type === 'button' && node.props.children?.some?.(child => child === 'Retry'))[0];
  assert.ok(retry);
  retry.props.onClick();
  assert.equal(view.calls.at(-1), 'retry');
  view.options.queryFn({});
  assert.equal(view.calls.at(-1)[2], 0.1);
  view.submit();
  view.options.queryFn({});
  assert.equal(view.calls.at(-1)[2], 0.3);
});

test('detector is a draft until Load and changes request identity', async (t) => {
  const view = await setup(t);
  view.submit();
  const original = view.options.queryKey;
  view.find(node => node.type === 'select' && node.props['aria-label'] === 'Detector')[0].props.onChange({target:{value:'5'}});
  view.render();
  assert.deepEqual(view.options.queryKey, original);
  view.submit();
  assert.notDeepEqual(view.options.queryKey, original);
  view.options.queryFn({});
  assert.equal(view.calls.at(-1).at(-1), 5);
  view.props.mode = 'local';
  view.render();
  assert.equal(view.find(node => node.type === 'select' && node.props['aria-label'] === 'Detector').length, 0);
});


test('blink request form omits repetitive subtitles and dangling hint references', async (t) => {
  const view = await setup(t);
  const notes = view.find(node => node.type === 'p' && node.props.className === 'blink-note');
  assert.equal(notes.length, 0);
  const fov = view.find(node => node.type === 'select' && node.props['aria-label'] === 'Field of view')[0];
  assert.equal(fov.props['aria-describedby'], undefined);
  assert.ok(view.find(node => node.type === 'button' && node.props.type === 'submit').length);
});
