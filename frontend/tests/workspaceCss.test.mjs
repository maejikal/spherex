import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/workspace.css', import.meta.url), 'utf8');

// fit-content() is a track size of its own. Inside minmax() the whole declaration is invalid, the browser
// drops it, and the docked Find/View column silently falls back to two equal rows.
test('no grid track list nests fit-content() inside minmax()', () => {
  const declarations = [...css.matchAll(/grid-template-(?:rows|columns)\s*:\s*([^;}]*)/g)].map((m) => m[1]);
  assert.ok(declarations.length > 0);
  for (const value of declarations) assert.doesNotMatch(value, /minmax\([^)]*fit-content\(/, value);
});

test('the docked Find/View stack sizes Find by its content, View takes the rest', () => {
  const rule = css.match(/\.workspace--docked\[data-left-stacked="true"\]\s*\{\s*grid-template-rows:\s*([^;]*);/);
  assert.ok(rule, 'stacked rows rule exists');
  assert.match(rule[1], /^fit-content\(/);
  assert.match(rule[1], /minmax\(0,\s*1fr\)\s*$/);
});
