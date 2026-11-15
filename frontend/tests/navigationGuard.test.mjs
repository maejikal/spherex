import test from 'node:test';
import assert from 'node:assert/strict';
import { NavigationGuard, isAbortError } from '../src/state/navigationGuard.ts';

/** A lookup whose response the test releases by hand, in any order; rejects with AbortError like fetch. */
function deferredLookup(log) {
  const pending = new Map();
  const request = (name, signal) => new Promise((resolve, reject) => {
    pending.set(name, resolve);
    signal.addEventListener('abort', () => { log.push(`aborted ${name}`); reject(new DOMException('aborted', 'AbortError')); });
  });
  return { request, release: (name, value) => pending.get(name)(value) };
}

/** Mirrors FindPanel: begin a ticket, then navigate only if it is still the newest navigation. */
function startLookup(guard, lookup, name, navigations, failures) {
  const ticket = guard.begin();
  return lookup.request(name, ticket.signal).then(
    (result) => { if (ticket.isCurrent()) navigations.push(result); },
    (error) => { if (!isAbortError(error) && ticket.isCurrent()) failures.push(error); },
  );
}

test('BUG-006: an older name search that resolves last cannot override a newer one', async () => {
  const guard = new NavigationGuard();
  const log = [];
  const navigations = [];
  const failures = [];
  const lookup = deferredLookup(log);
  const first = startLookup(guard, lookup, 'M31', navigations, failures);
  const second = startLookup(guard, lookup, 'M 42', navigations, failures);
  assert.deepEqual(log, ['aborted M31'], 'the superseded request is cancelled');
  lookup.release('M 42', 'M42 @ 83.82,-5.39');
  lookup.release('M31', 'M31 @ 10.68,41.27'); // arrives late (abort not honoured by the transport)
  await Promise.all([first, second]);
  assert.deepEqual(navigations, ['M42 @ 83.82,-5.39']);
  assert.deepEqual(failures, [], 'a cancelled lookup is not reported as an error');
});

test('BUG-006: newer lookups also win when responses arrive in request order', async () => {
  const guard = new NavigationGuard();
  const navigations = [];
  const lookup = deferredLookup([]);
  const a = startLookup(guard, lookup, 'A', navigations, []);
  const b = startLookup(guard, lookup, 'B', navigations, []);
  const c = startLookup(guard, lookup, 'C', navigations, []);
  lookup.release('A', 'A'); lookup.release('C', 'C'); lookup.release('B', 'B');
  await Promise.all([a, b, c]);
  assert.deepEqual(navigations, ['C']);
});

test('BUG-006: coordinate, verified-destination, Reset and Back navigation supersede a pending lookup', async () => {
  for (const label of ['coordinates', 'verified destination', 'reset', 'popstate', 'double-click centre']) {
    const guard = new NavigationGuard();
    const navigations = [];
    const log = [];
    const lookup = deferredLookup(log);
    const pending = startLookup(guard, lookup, 'M31', navigations, []);
    guard.supersede(); // what App.navigateTo / resetView / popstate / centerPosition do synchronously
    navigations.push(label);
    lookup.release('M31', 'M31');
    await pending;
    assert.deepEqual(navigations, [label], label);
    assert.deepEqual(log, ['aborted M31'], label);
  }
});

test('BUG-006: a lookup with no newer navigation still navigates, and real failures are reported', async () => {
  const guard = new NavigationGuard();
  const navigations = [];
  const failures = [];
  const ok = guard.begin();
  assert.equal(ok.isCurrent(), true);
  await Promise.resolve('Vega').then((r) => { if (ok.isCurrent()) navigations.push(r); });
  assert.deepEqual(navigations, ['Vega']);
  const failing = guard.begin();
  await Promise.reject(new Error('Name not found')).catch((error) => { if (!isAbortError(error) && failing.isCurrent()) failures.push(error.message); });
  assert.deepEqual(failures, ['Name not found']);
  assert.equal(ok.signal.aborted, true, 'starting a newer lookup aborts the older signal');
});
