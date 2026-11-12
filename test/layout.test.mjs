import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeRoute, graphLayout, mindmapLayout } from '../src/client/layout.mjs';

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


const deepHierarchy = {
  id: 'root', title: '微积分', kind: 'root',
  children: [{
    id: 't1', title: '极限', kind: 'topic',
    children: [{
      id: 's1', title: '极限的定义', kind: 'sub', conceptId: 'kp-def',
      children: [
        { id: 'e1', title: '极限定义法', kind: 'node', belongsTo: { type: 'concept', id: 'kp-def' }, children: [
          { id: 'e1a', title: 'ε-δ 语言', kind: 'node', children: [] },
        ] },
      ],
    }],
  }],
};

test('mindmapLayout draws extension nodes deeper than two levels (chat card data)', () => {
  const h = mindmapLayout(deepHierarchy);
  const ids = h.nodes.map((n) => n.id);
  assert.ok(ids.includes('e1'), 'depth-3 extension is in the layout');
  assert.ok(ids.includes('e1a'), 'depth-4 extension is in the layout');
  assert.equal(h.nodes.find((n) => n.id === 'e1').depth, 3);
  assert.equal(h.nodes.find((n) => n.id === 'e1a').depth, 4);
  assert.ok(h.links.some((l) => l.from.id === 's1' && l.to.id === 'e1'));
  assert.ok(h.links.some((l) => l.from.id === 'e1' && l.to.id === 'e1a'));
  const boxes = h.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h, id: n.id }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
  }
});

test('indentLayout also keeps depth ≥ 3 extensions (narrow chat card)', () => {
  const h = mindmapLayout(deepHierarchy, new Set(), { availableWidth: 200, mode: 'indent' });
  assert.equal(h.mode, 'indent');
  const ids = h.nodes.map((n) => n.id);
  assert.ok(ids.includes('e1') && ids.includes('e1a'));
  assert.ok(h.nodes.find((n) => n.id === 'e1a').x > h.nodes.find((n) => n.id === 'e1').x);
});

test('collapsed topic hides the whole subtree including deep extensions', () => {
  const h = mindmapLayout(deepHierarchy, new Set(['t1']));
  const ids = new Set(h.nodes.map((n) => n.id));
  assert.ok(ids.has('t1') && ids.has('root'));
  assert.ok(!ids.has('s1') && !ids.has('e1') && !ids.has('e1a'));
});
