import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Exercise the component's resize and drag handlers without a DOM dependency.
// Layout measurements below model CSS max-size constraints, not browser rendering.
const file = new URL('../src/components/ToolWindow.tsx', import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const resolved = outputText
  .replace(/import \{ useLayoutEffect, useRef, useState \} from ['"]react['"];?/, 'const { useLayoutEffect, useRef, useState } = globalThis.toolWindowHooks;')
  .replace(/from (['"])([^'"]+)\1/g, (_, quote, name) =>
    `from ${quote}${name.startsWith('.') ? new URL(name, file).href : import.meta.resolve(name)}${quote}`);

for (const preferredHeight of [undefined, 700]) test(`floating window (${preferredHeight ?? 'content'} height) stays inside a shrinking workspace and can grow again`, async (t) => {
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let tree;
  const slots = [];
  const observers = new Set();
  const workspace = {
    clientWidth: 1440, clientHeight: 900,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const panel = {
    get offsetWidth() { return Math.min(360, tree.props.style.maxWidth ?? workspace.clientWidth - 16); },
    get offsetHeight() { return Math.min(tree.props.style.height ?? 720, tree.props.style.maxHeight ?? workspace.clientHeight - 16); },
  };
  const hooks = {
    useRef(value) {
      const index = cursor++;
      return slots[index] ??= { current: value };
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (value) => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(slots[index], next)) { slots[index] = next; dirty = true; }
      }];
    },
    useLayoutEffect(effect, dependencies) {
      const index = cursor++;
      const previous = slots[index];
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      slots[index] = { dependencies };
      effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); });
    },
  };
  const saved = Object.fromEntries(['toolWindowHooks', 'document', 'ResizeObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.toolWindowHooks = hooks;
  globalThis.document = {
    getElementById: () => ({ getBoundingClientRect: () => ({ left: 16, top: 16, width: 352, height: 400 }) }),
  };
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe() {}
    disconnect() { observers.delete(this); }
  };
  const { ToolWindow } = await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}#${preferredHeight ?? 'content'}`);
  const props = {
    preferredHeight, id: 'inspect', title: 'Inspect position', open: true, placement: 'right-top', movable: true,
    avoidIds: ['find'], workspaceRef: { current: workspace }, onClose() {}, children: null,
  };
  function render() {
    let passes = 0;
    do {
      assert.ok(++passes < 30, 'component state settles');
      cursor = 0;
      dirty = false;
      tree = ToolWindow(props);
      tree.props.ref.current = panel;
      const pending = effects;
      effects = [];
      for (const effect of pending) effect();
    } while (dirty);
  }
  function resize(height) {
    workspace.clientHeight = height;
    for (const observer of observers) observer.callback();
    render();
  }
  function assertContained() {
    assert.ok(tree.props.style.top >= 8, 'top stays reachable');
    assert.ok(tree.props.style.top + panel.offsetHeight <= workspace.clientHeight - 8,
      `window bottom ${tree.props.style.top + panel.offsetHeight} exceeds workspace ${workspace.clientHeight}`);
  }
  render();
  const originalHeight = panel.offsetHeight;
  if (preferredHeight) {
    resize(400);
    assertContained();
    assert.equal(panel.offsetHeight, 384, 'media window uses available height rather than preserving a low bottom position');
    resize(900);
    assert.equal(panel.offsetHeight, preferredHeight, 'media window regains preferred height after enlargement');
  }
  const header = tree.props.children[0];
  header.props.onPointerDown({
    target: { closest: () => null }, currentTarget: { setPointerCapture() {} },
    preventDefault() {}, pointerId: 1, clientX: 1100, clientY: 30,
  });
  header.props.onPointerMove({ pointerId: 1, clientX: 1050, clientY: 50 });
  render();
  resize(400);
  assertContained();
  assert.ok(panel.offsetHeight < originalHeight, 'body shrinks instead of being clipped');
  resize(900);
  assertContained();
  assert.equal(panel.offsetHeight, originalHeight, 'temporary viewport limit does not permanently shrink the window');
});
