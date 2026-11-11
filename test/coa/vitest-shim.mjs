// Minimal vitest-style describe/it/expect on node:test + node:assert, so the ported AWS tests (Apache-2.0) run with
// `node --test` unchanged in spirit. Only the matchers those tests use are implemented.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';

export const describe = (name, fn) => nodeTest.describe(name, fn);
export const it = (name, fn) => nodeTest.it(name, fn);
export function expect(actual, message) {
  const m = {
    toBe: (v) => assert.strictEqual(actual, v, message),
    toEqual: (v) => assert.deepStrictEqual(actual, v, message),
    toHaveLength: (n) => assert.strictEqual(actual.length, n, message),
    toBeGreaterThan: (n) => assert.ok(actual > n, message ?? `${actual} > ${n}`),
    toBeLessThan: (n) => assert.ok(actual < n, message ?? `${actual} < ${n}`),
    toBeCloseTo: (n, digits = 2) => assert.ok(Math.abs(actual - n) < 10 ** -digits / 2, message ?? `${actual} ≈ ${n}`),
    toBeTruthy: () => assert.ok(actual, message),
    toBeNull: () => assert.strictEqual(actual, null, message),
    toContain: (v) => assert.ok(actual.includes(v), message ?? `contains ${v}`),
    toBeGreaterThanOrEqual: (n) => assert.ok(actual >= n, message ?? `${actual} >= ${n}`),
  };
  m.not = {
    toBe: (v) => assert.notStrictEqual(actual, v, message),
    toBeCloseTo: (n, digits = 2) => assert.ok(!(Math.abs(actual - n) < 10 ** -digits / 2), message ?? `${actual} not ≈ ${n}`),
    toEqual: (v) => assert.notDeepStrictEqual(actual, v, message),
    toThrow: () => { actual(); },
    toHaveBeenCalled: () => assert.strictEqual(actual.calls.length, 0, message),
  };
  m.toHaveBeenCalled = () => assert.ok(actual.calls.length > 0, message ?? 'called');
  return m;
}
/** vi.fn() replacement: records calls in `.calls` (and `.mock.calls`). */
export function fn() {
  const f = (...args) => { f.calls.push(args); };
  f.calls = []; f.mock = { calls: f.calls };
  return f;
}
