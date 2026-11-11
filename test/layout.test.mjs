import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeRoute, graphLayout } from '../src/client/layout.mjs';

test('edgeRoute: straight when clear, curved around an unrelated card in between', () => {
  const a = { x: 0, y: 0, w: 100, h: 40 }, mid = { x: 150, y: 0, w: 100, h: 40 }, b = { x: 300, y: 0, w: 100, h: 40 };
  assert.equal(edgeRoute(a, b, [a, b]).curved, false);
  const r = edgeRoute(a, b, [a, mid, b]);
  assert.equal(r.curved, true);
  assert.match(r.d, /^M[\d.-]+,[\d.-]+ Q/);
  assert.ok(r.ly < 0 || r.ly > 40, 'label sits off the blocked row');
});

test('graphLayout fits 40 nodes without overlap', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, label: `知识点 ${i}` }));
  const { pos } = graphLayout(nodes);
  const rects = [...pos.values()];
  assert.equal(rects.length, 40);
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const p = rects[i], q = rects[j];
    assert.ok(p.x + p.w <= q.x || q.x + q.w <= p.x || p.y + p.h <= q.y || q.y + q.h <= p.y, `n${i} overlaps n${j}`);
  }
});
