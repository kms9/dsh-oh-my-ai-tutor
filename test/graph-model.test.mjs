import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateState } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';
import { buildGraph, visibleGraph, neighbours, shortestPath, searchNodes } from '../src/client/graph-model.mjs';
import { layoutGraph, NODE_SIZE } from '../src/client/coa/graphLayout.mjs';
import { createLiveForceSimulation } from '../src/client/coa/liveForceSimulation.mjs';

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

const circles = (pos, nodes) => nodes.map((n) => { const d = NODE_SIZE[n.kind]; const p = pos.get(n.id); return { id: n.id, x: p.x, y: p.y, width: d, height: d }; });

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
  const sizeOf = (id) => (id.startsWith('topic:') ? NODE_SIZE.topic : NODE_SIZE.concept);
  const sim = createLiveForceSimulation(view, v.edges, (u) => { view = u(view); }, { nodeSize: NODE_SIZE.concept, linkDistance: 110, nodeSizeOf: sizeOf,
    startPositions: new Map(v.nodes.map((n) => [n.id, { x: homes.get(n.id).x + sizeOf(n.id) / 2, y: homes.get(n.id).y + sizeOf(n.id) / 2 }])) });
  sim.stop(); sim.step(300);
  const at = (id) => view.find((n) => n.id === id).position;
  const topic = v.nodes.find((n) => n.kind === 'topic');
  const kid = v.edges.find((e) => e.kind === 'contains' && e.source === topic.id).target;
  const t0 = { ...at(topic.id) }, k0 = { ...at(kid) };
  const to = { x: t0.x + 300, y: t0.y + 200 };
  sim.onDragStart(topic.id, t0); sim.onDrag(topic.id, to); sim.stop(); sim.step(120);
  assert.ok(Math.hypot(at(topic.id).x - to.x, at(topic.id).y - to.y) < 1, 'pinned under the pointer (fx/fy)');
  assert.ok(Math.hypot(at(kid).x - k0.x, at(kid).y - k0.y) > 80, 'a contained knowledge point follows');
  sim.onDragStop(topic.id); sim.stop(); sim.step(300);
  assert.ok(Math.hypot(at(topic.id).x - to.x, at(topic.id).y - to.y) < 60, 'the dragged node adopted its new home');
  assert.equal(JSON.stringify(st), before, 'no application data touched');
});
