import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateState } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';
import { buildGraph, visibleGraph, neighbours, shortestPath, searchNodes } from '../src/client/graph-model.mjs';
import { layoutGraph, layoutTopicClusters, shelfPack, nodeBox, NODE_SIZE } from '../src/client/coa/graphLayout.mjs';
import { createLiveForceSimulation, forceRectCollide } from '../src/client/coa/liveForceSimulation.mjs';

const st = validateState(JSON.parse(await readFile(new URL('./fixtures/spaced-repetition.state.json', import.meta.url), 'utf8')));
const cid = Object.keys(st.courses)[0];
const topics = st.courses[cid].syllabus.topics;
const view = projectCourse(st, cid, 'graph');
const g = buildGraph(view, topics);
const overlap = (a, b) => !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

test('graph model: one category node per topic, every knowledge point, containment + directed labelled relations', () => {
  assert.equal(g.nodes.filter((n) => n.kind === 'topic').length, topics.length);
  assert.equal(g.nodes.filter((n) => n.kind === 'concept').length, view.nodes.length);
  assert.equal(g.edges.filter((e) => e.kind === 'contains').length, view.nodes.length);
  const rel = g.edges.filter((e) => e.kind === 'relation');
  assert.equal(rel.length, view.edges.length);
  for (const e of rel) { const src = view.edges.find((x) => x.id === e.id); assert.equal(e.source, src.from); assert.equal(e.target, src.to); assert.ok(e.label); }
});

test('collapse a topic: its knowledge points disappear, their relations re-attach to the topic (nothing silently lost)', () => {
  const rel = g.edges.find((e) => e.kind === 'relation');
  const t = g.nodes.find((n) => n.id === rel.target).topicId;
  const v = visibleGraph(g, new Set([t]));
  const members = g.nodes.filter((n) => n.kind === 'concept' && n.topicId === t);
  assert.equal(v.nodes.length, g.nodes.length - members.length);
  const topic = v.nodes.find((n) => n.id === `topic:${t}`);
  assert.equal(topic.collapsed, true); assert.equal(topic.count, members.length);
  const agg = v.edges.find((e) => e.kind === 'relation');
  assert.equal(agg.target, `topic:${t}`); assert.equal(agg.aggregated, true); assert.deepEqual(agg.members, [rel.id]);
  assert.equal(visibleGraph(g, new Set()).edges.length, g.edges.length, 'expanding restores everything');
});

test('neighbours, shortest path (BFS) and search', () => {
  const rel = g.edges.find((e) => e.kind === 'relation');
  const nb = neighbours(g.edges, rel.source);
  assert.ok(nb.has(rel.target));
  const p = shortestPath(g.edges, `topic:${g.nodes.find((n) => n.id === rel.source).topicId}`, rel.target);
  assert.ok(p && p.nodes[0].startsWith('topic:') && p.nodes.at(-1) === rel.target && p.edges.length === p.nodes.length - 1);
  // two topics with no relation between them: no path
  const lonely = topics.map((t) => `topic:${t.id}`).find((id) => !shortestPath(g.edges, id, rel.target));
  if (lonely) assert.equal(shortestPath(g.edges, lonely, rel.target), null);
  assert.deepEqual(searchNodes(g.nodes, '  '), []);
  const hit = searchNodes(g.nodes, view.nodes[0].label.slice(0, 3));
  assert.ok(hit.includes(view.nodes[0].id));
});

const circles = (pos, nodes) => nodes.map((n) => { const b = nodeBox(n); const p = pos.get(n.id); return { id: n.id, x: p.x, y: p.y, width: b.w, height: b.h }; });

test('course graph layouts (ported AWS layoutGraph): force packs clusters with no overlap, dagre layers left → right, both deterministic', () => {
  const v = visibleGraph(g);
  for (const layout of ['force', 'hierarchical']) {
    const a = layoutGraph(v.nodes, v.edges, layout), b = layoutGraph(v.nodes, v.edges, layout);
    assert.deepEqual([...a.entries()], [...b.entries()], `${layout} deterministic`);
    assert.equal(a.size, v.nodes.length);
    const bx = circles(a, v.nodes);
    const over = bx.flatMap((p, i) => bx.slice(i + 1).filter((q) => overlap(p, q))).length;
    assert.equal(over, 0, `${layout}: ${over} overlaps`);
  }
  const h = layoutGraph(v.nodes, v.edges, 'hierarchical');
  for (const e of v.edges.filter((x) => x.kind === 'contains')) assert.ok(h.get(e.target).x > h.get(e.source).x, 'topic left of its knowledge points');
  // a collapsed topic shrinks the force layout's extent
  const ext = (m) => { const ps = [...m.values()]; return (Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x))) * (Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y))); };
  const small = visibleGraph(g, new Set(topics.map((t) => t.id)));
  assert.ok(ext(layoutGraph(small.nodes, small.edges, 'force')) < ext(layoutGraph(v.nodes, v.edges, 'force')));
});

test('live simulation on the course graph: ticks only reach setNodes (view), a drag pins the node and its knowledge points follow', () => {
  const v = visibleGraph(g);
  const homes = layoutGraph(v.nodes, v.edges, 'force');
  let view = v.nodes.map((n) => ({ id: n.id, position: homes.get(n.id) }));
  const before = JSON.stringify(st);
  const boxes = new Map(v.nodes.map((n) => [n.id, nodeBox(n)]));
  const boxOf = (id) => boxes.get(id);
  const sim = createLiveForceSimulation(view, v.edges, (u) => { view = u(view); }, { nodeSize: NODE_SIZE.concept.w, linkDistance: 110, boxOf, homeLinks: true,
    startPositions: new Map(v.nodes.map((n) => [n.id, { x: homes.get(n.id).x + boxOf(n.id).w / 2, y: homes.get(n.id).y + boxOf(n.id).h / 2 }])) });
  sim.stop(); sim.step(300);
  const at = (id) => view.find((n) => n.id === id).position;
  const topic = v.nodes.find((n) => n.kind === 'topic');
  const kid = v.edges.find((e) => e.kind === 'contains' && e.source === topic.id).target;
  const t0 = { ...at(topic.id) }, k0 = { ...at(kid) };
  const to = { x: t0.x + 300, y: t0.y + 200 };
  sim.onDragStart(topic.id, t0); sim.onDrag(topic.id, to); sim.stop(); sim.step(120);
  assert.ok(Math.hypot(at(topic.id).x - to.x, at(topic.id).y - to.y) < 1, 'pinned under the pointer (fx/fy)');
  // rest lengths are the packed card distances (homeLinks), so a knowledge point only follows until it is back at that
  // distance from its topic: it moves less than with upstream's short 110 px links (was > 80 px)
  assert.ok(Math.hypot(at(kid).x - k0.x, at(kid).y - k0.y) > 40, 'a contained knowledge point follows');
  sim.onDragStop(topic.id); sim.stop(); sim.step(300);
  assert.ok(Math.hypot(at(topic.id).x - to.x, at(topic.id).y - to.y) < 60, 'the dragged node adopted its new home');
  assert.equal(JSON.stringify(st), before, 'no application data touched');
});

const extent = (pos, nodes) => {
  const bx = circles(pos, nodes);
  const x0 = Math.min(...bx.map((b) => b.x)), y0 = Math.min(...bx.map((b) => b.y));
  return { w: Math.max(...bx.map((b) => b.x + b.width)) - x0, h: Math.max(...bx.map((b) => b.y + b.height)) - y0 };
};
const fitZoom = (e, c) => Math.min((c.w - 64) / e.w, (c.h - 64) / e.h);

test('whole-course layout: topic cards packed to the canvas aspect, no overlaps, 包含 lines never cross a card member', () => {
  const v = visibleGraph(g);
  // 放大 with the side panel beside the graph (canvas ≈ 885 × 650, packed into the height above the key strip)
  const wide = { w: 885, h: 540 };
  const pos = layoutGraph(v.nodes, v.edges, 'force', { canvas: wide });
  const bx = circles(pos, v.nodes);
  assert.equal(bx.flatMap((p, i) => bx.slice(i + 1).filter((q) => overlap(p, q))).length, 0, 'no overlaps');
  assert.ok(fitZoom(extent(pos, v.nodes), { w: 885, h: 650 }) >= 0.8, 'fits at a readable zoom (≥ 0.8)');
  // a tall narrow column gets a taller arrangement than a wide strip
  const tall = extent(layoutGraph(v.nodes, v.edges, 'force', { canvas: { w: 420, h: 900 } }), v.nodes);
  const flat = extent(layoutGraph(v.nodes, v.edges, 'force', { canvas: { w: 1600, h: 420 } }), v.nodes);
  assert.ok(tall.h / tall.w > flat.h / flat.w, `aspect follows the canvas (${(tall.h / tall.w).toFixed(2)} vs ${(flat.h / flat.w).toFixed(2)})`);
  // inside a card the members sit in columns left / right of the topic block, so the straight 包含 line to a member
  // never runs through another member
  for (const t of v.nodes.filter((n) => n.kind === 'topic')) {
    const tb = bx.find((b) => b.id === t.id);
    for (const m of v.nodes.filter((n) => n.kind !== 'topic' && n.topicId === t.topicId)) {
      const mb = bx.find((b) => b.id === m.id);
      assert.ok(mb.x + mb.width <= tb.x || mb.x >= tb.x + tb.width, `${m.id} beside its topic`);
    }
  }
});

test('shelfPack keeps order, wraps at the width and centres rows; clusters with no topic are packed too', () => {
  const { offsets, w, h } = shelfPack([{ w: 100, h: 50 }, { w: 100, h: 30 }, { w: 150, h: 40 }], 260, { x: 20, y: 10 });
  assert.deepEqual(offsets[0], { x: 0, y: 0 });
  assert.equal(offsets[1].x, 120);
  assert.equal(offsets[2].y, 60, 'third card wraps to the next row');
  assert.equal(offsets[2].x, (220 - 150) / 2, 'rows are centred');
  assert.equal(w, 220); assert.equal(h, 100);
  const loose = layoutTopicClusters([{ id: 'a', kind: 'extension', label: '无主题' }, { id: 'b', kind: 'concept', label: '另一个' }]);
  assert.equal(loose.size, 2);
});

test('rect collision pushes overlapping rectangles apart along the smaller overlap', () => {
  const box = () => ({ w: 140, h: 36 });
  const nodes = [{ id: 'a', x: 0, y: 0, vx: 0, vy: 0 }, { id: 'b', x: 30, y: 4, vx: 0, vy: 0 }];
  const f = forceRectCollide(box, 10, 1); f.initialize(nodes); f();
  assert.ok(nodes[0].vy < 0 && nodes[1].vy > 0, 'separated vertically (overlap there is smaller)');
  assert.equal(nodes[0].vx, 0);
  const apart = [{ id: 'a', x: 0, y: 0, vx: 0, vy: 0 }, { id: 'b', x: 0, y: 60, vx: 0, vy: 0 }];
  f.initialize(apart); f();
  assert.equal(apart[1].vy, 0, 'no push when the gap is kept');
  const pinned = [{ id: 'a', x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0 }, { id: 'b', x: 30, y: 4, vx: 0, vy: 0 }];
  f.initialize(pinned); f();
  assert.equal(pinned[0].vy, 0, 'a pinned (dragged / dropped) node does not give way');
  assert.ok(pinned[1].vy > 0, 'the other one takes the push');
});

test('whole-course layout on a small canvas: when nothing fits at the readable zoom, the width still fits at it', () => {
  const v = visibleGraph(g);
  const small = { w: 500, h: 380 };
  const e = extent(layoutGraph(v.nodes, v.edges, 'force', { canvas: small, readableZoom: 0.8 }), v.nodes);
  assert.ok(fitZoom(e, small) < 0.8, 'this course cannot fit whole at 0.8 here');
  assert.ok(e.w * 0.8 <= small.w - 64, `width fits at 0.8 (${Math.round(e.w)} px) — only vertical overflow`);
});
