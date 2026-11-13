import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, NODE_KINDS } from '../src/client/graph-model.mjs';
import { focusGraph, learningPath, learningPathTo, weakIds, isWeak, prereqEdges, FOLD_AT, PREREQ } from '../src/client/graph-focus.mjs';
import { layoutGraph } from '../src/client/coa/graphLayout.mjs';

// Synthetic course: topics T1..T3; "A —前置→ B" means learn A before B.
function course({ nodes, edges, topics = ['T1', 'T2', 'T3'] }) {
  const ts = topics.map((id) => ({ id, title: `主题${id}`, subtopics: [] }));
  const view = {
    nodes: nodes.map(([id, topicId, mastery = 'unverified', ext = false]) => ({ id, label: id.toUpperCase(), conceptId: ext ? null : `c_${id}`, topicId, mastery: ext ? null : mastery })),
    edges: edges.map(([from, to, type = PREREQ], i) => ({ id: `r${i}_${from}_${to}`, from, to, type, status: 'candidate' })),
  };
  for (const t of ts) t.subtopics = view.nodes.filter((n) => n.topicId === t.id && n.conceptId).map((n) => ({ id: `s_${n.id}`, conceptIds: [n.conceptId] }));
  return buildGraph(view, ts);
}

// chain a ← b ← c ← d (d is the focus): a→b→c→d, plus x→d (prereq), d→e, e→f (dependents), and non-prereq relations
const g = course({
  nodes: [['a', 'T1', 'demonstrated'], ['b', 'T1', 'developing'], ['c', 'T2', 'unverified'], ['d', 'T2', 'developing'], ['x', 'T3', 'demonstrated'],
    ['e', 'T3'], ['f', 'T3'], ['ext', 'T2', null, true], ['y', 'T1'], ['z', 'T1']],
  edges: [['a', 'b'], ['b', 'c'], ['c', 'd'], ['x', 'd'], ['d', 'e'], ['e', 'f'], ['ext', 'c'],
    ['y', 'd', 'relatedTo'], ['d', 'z', 'explains'], ['z', 'a', 'contrasts']],
});
const ids = (fg) => fg.graph.nodes.map((n) => n.id).sort();

test('focus: follows only 前置, N levels up (1 / 2 / 3 / all) and 1 level down', () => {
  assert.deepEqual(ids(focusGraph(g, 'd', { up: 1 })), ['c', 'd', 'e', 'x']);
  assert.deepEqual(ids(focusGraph(g, 'd', { up: 2 })), ['b', 'c', 'd', 'e', 'ext', 'x']);
  assert.deepEqual(ids(focusGraph(g, 'd', { up: 3 })), ['a', 'b', 'c', 'd', 'e', 'ext', 'x']);
  const all = focusGraph(g, 'd', { up: 'all' });
  assert.deepEqual(ids(all), ['a', 'b', 'c', 'd', 'e', 'ext', 'x']);
  assert.ok(!ids(all).includes('f'), 'only one level down');
  assert.ok(!ids(all).includes('y') && !ids(all).includes('z'), 'relatedTo / explains / contrasts never pull nodes in');
  assert.ok(all.graph.edges.every((e) => e.label === PREREQ && e.status === 'candidate'), 'only candidate 前置 edges are drawn');
  assert.ok(all.graph.nodes.every((n) => n.kind !== 'topic'), 'no topic nodes / containment edges in the local view');
  const lv = Object.fromEntries(all.graph.nodes.map((n) => [n.id, n.level]));
  assert.deepEqual([lv.c, lv.b, lv.a, lv.d, lv.e], [-1, -2, -3, 0, 1]);
  assert.equal(all.ancestorCount, 5); assert.equal(all.dependentCount, 1); assert.equal(all.foldedCount, 0);
  assert.deepEqual(ids(focusGraph(g, 'a', { up: 2 })), ['a', 'b'], 'a root: nothing above, its dependent below');
  assert.equal(focusGraph(g, 'topic:T1'), null, 'topics are not focus targets');
  assert.equal(focusGraph(g, 'missing'), null);
});

test('focus layout: dagre top → bottom puts prerequisites above the focused node', () => {
  const fg = focusGraph(g, 'd', { up: 'all' });
  const pos = layoutGraph(fg.graph.nodes, fg.graph.edges, 'tb');
  assert.ok(pos.get('a').y < pos.get('b').y && pos.get('b').y < pos.get('c').y && pos.get('c').y < pos.get('d').y && pos.get('d').y < pos.get('e').y);
});

test('fold: above the threshold, farther ancestors fold into one node per topic (「主题 · N个」); unfold shows all', () => {
  // focus F with 10 direct prerequisites (T1) each having 5 own prerequisites (T2 / T3 alternating) → 60 ancestors
  const nodes = [['f', 'T1']], edges = [];
  for (let i = 0; i < 10; i++) {
    nodes.push([`p${i}`, 'T1']); edges.push([`p${i}`, 'f']);
    for (let j = 0; j < 5; j++) { nodes.push([`q${i}_${j}`, j % 2 ? 'T3' : 'T2']); edges.push([`q${i}_${j}`, `p${i}`]); }
  }
  const big = course({ nodes, edges });
  const fg = focusGraph(big, 'f', { up: 'all' });
  assert.equal(fg.ancestorCount, 60);
  assert.ok(fg.ancestorCount > FOLD_AT);
  assert.equal(fg.foldedCount, 50);
  const folds = fg.graph.nodes.filter((n) => n.kind === 'fold');
  assert.deepEqual(folds.map((n) => n.label).sort(), ['主题T2 · 30个', '主题T3 · 20个']);
  assert.equal(fg.graph.nodes.filter((n) => n.id.startsWith('p')).length, 10, 'nearest level stays whole');
  // one arrow per fold card: its 30 / 20 member relations feed all ten p*, so they become one bus edge (×n, via p*)
  const fromFolds = fg.graph.edges.filter((e) => e.source.startsWith('fold:'));
  assert.equal(fromFolds.length, 2, 'a single edge per fold node');
  const agg = fromFolds.find((e) => e.source === 'fold:T2');
  assert.ok(agg.aggregated && agg.bus && agg.members.length === 30, 'member relations are aggregated onto the fold (×n)');
  assert.equal(agg.via.length, 10, 'one tick down to each of the ten direct prerequisites');
  assert.equal(agg.status, 'candidate', 'still a candidate 前置');
  assert.equal(agg.label, 'prerequisite');
  assert.equal(focusGraph(big, 'f', { up: 'all', unfold: true }).graph.nodes.length, 61, 'expand all');
  assert.equal(focusGraph(big, 'f', { up: 1 }).foldedCount, 0, 'small views never fold');
  assert.ok(NODE_KINDS.includes('fold'));
});

test('directed 前置 learning path: follows arrow direction, tries both pick orders, no undirected fallback', () => {
  const p = learningPath(g, 'a', 'd');
  assert.deepEqual(p.nodes, ['a', 'b', 'c', 'd']); assert.equal(p.edges.length, 3); assert.equal(p.directed, true); assert.equal(p.reversed, false);
  const r = learningPath(g, 'd', 'a');
  assert.deepEqual(r.nodes, ['a', 'b', 'c', 'd'], 'target picked first: still in learning order'); assert.equal(r.reversed, true);
  // x and a are both prerequisites of d — connected without direction (x→d←c←b←a) but no directed path
  assert.equal(learningPath(g, 'x', 'a'), null);
  // y —相关→ d exists, but only 前置 counts
  assert.equal(learningPath(g, 'y', 'd'), null);
  assert.equal(learningPath(g, 'a', 'a'), null);
});

test('learning path to one target: every prerequisite in learning order; weak points from mastery', () => {
  const p = learningPathTo(g, 'd');
  assert.equal(p.nodes.at(-1), 'd');
  const at = (id) => p.nodes.indexOf(id);
  assert.ok(at('a') < at('b') && at('b') < at('c') && at('ext') < at('c') && at('c') < at('d') && at('x') < at('d'));
  assert.deepEqual([...p.weak].sort(), ['b', 'c', 'd'], 'developing / unverified are weak; demonstrated (a, x) and the extension are not');
  assert.equal(p.omitted, 0);
  assert.equal(learningPathTo(g, 'a').nodes.length, 1);
});

test('weak points: knowledge points not demonstrated; extensions and topics never weak', () => {
  const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.equal(isWeak(by.a), false, 'demonstrated');
  assert.equal(isWeak(by.b), true, 'developing');
  assert.equal(isWeak(by.c), true, 'unverified');
  assert.equal(by.ext.kind, 'extension'); assert.equal(isWeak(by.ext), false, 'extension has no mastery');
  assert.equal(isWeak(by['topic:T1']), false);
  assert.deepEqual([...weakIds(g.nodes, ['a', 'b', 'ext', 'topic:T1'])], ['b']);
});

test('long learning path is condensed: target, direct prerequisites, weak points; dotted skip edges for omitted steps', () => {
  // chain n0 → n1 → … → n29 → t, all demonstrated except n3 and n10
  const nodes = [['t', 'T1']], edges = [];
  for (let i = 0; i < 30; i++) nodes.push([`n${i}`, 'T1', i === 3 || i === 10 ? 'developing' : 'demonstrated']);
  for (let i = 0; i < 29; i++) edges.push([`n${i}`, `n${i + 1}`]);
  edges.push(['n29', 't']);
  const p = learningPathTo(course({ nodes, edges }), 't', { maxNodes: 24 });
  assert.deepEqual(p.nodes, ['n3', 'n10', 'n29', 't']);
  assert.equal(p.omitted, 27);
  const skips = p.graph.edges.filter((e) => e.kind === 'skip').map((e) => `${e.source}>${e.target}`).sort();
  assert.deepEqual(skips, ['n10>n29', 'n3>n10']);
  assert.ok(p.graph.edges.some((e) => e.kind === 'relation' && e.source === 'n29' && e.target === 't'));
});

test('prereqEdges ignores containment and other relation types', () => {
  assert.ok(prereqEdges(g).every((e) => e.kind === 'relation' && e.label === PREREQ));
  assert.equal(prereqEdges(g).length, 7);
});

test('fold edges: one bus arrow per fold card; dagre keeps the fold above the row it feeds', () => {
  const nodes = [['f', 'T1'], ['m', 'T1'], ['p0', 'T1'], ['p1', 'T1']], edges = [['m', 'f'], ['p0', 'm'], ['p1', 'm']];
  for (let i = 0; i < 45; i++) { nodes.push([`q${i}`, 'T2']); edges.push([`q${i}`, i % 2 ? 'p1' : 'p0']); }
  const fg = focusGraph(course({ nodes, edges }), 'f', { up: 'all', foldAt: 3 });
  const fe = fg.graph.edges.filter((e) => e.source === 'fold:T2');
  assert.equal(fe.length, 1);
  assert.ok(fe[0].bus);
  assert.deepEqual([...fe[0].via].sort(), ['p0', 'p1']);
  assert.equal(fe[0].members.length, 45);
  const pos = layoutGraph(fg.graph.nodes, fg.graph.edges, 'tb');
  assert.ok(pos.get('fold:T2').y < pos.get('p0').y && pos.get('fold:T2').y < pos.get('p1').y, 'the fold card sits above every node it feeds');
  // a fold feeding only one node keeps that direct (×n) edge
  const one = focusGraph(course({ nodes: [['f', 'T1'], ['p', 'T1'], ...Array.from({ length: 6 }, (_, i) => [`q${i}`, 'T2'])], edges: [['p', 'f'], ...Array.from({ length: 6 }, (_, i) => [`q${i}`, 'p'])] }), 'f', { up: 'all', foldAt: 3 });
  const e1 = one.graph.edges.find((e) => e.source === 'fold:T2');
  assert.equal(e1.target, 'p'); assert.equal(e1.members.length, 6); assert.ok(!e1.bus);
});

test('fold edges: relations between two fold cards are not drawn but count on the source fold', () => {
  const nodes = [['f', 'T1'], ['p0', 'T1'], ['p1', 'T1']], edges = [['p0', 'f'], ['p1', 'f']];
  for (let i = 0; i < 6; i++) { nodes.push([`a${i}`, 'T2'], [`b${i}`, 'T3']); edges.push([`a${i}`, i % 2 ? 'p1' : 'p0'], [`b${i}`, i % 2 ? 'p1' : 'p0']); }
  edges.push(['a0', 'b1']);
  const fg = focusGraph(course({ nodes, edges }), 'f', { up: 'all', foldAt: 3 });
  const from2 = fg.graph.edges.filter((e) => e.source === 'fold:T2');
  assert.equal(from2.length, 1, 'one arrow from the T2 fold');
  assert.ok(from2[0].bus);
  assert.equal(from2[0].members.length, 7, 'including the relation into the other fold');
  assert.equal(fg.graph.edges.filter((e) => e.target.startsWith('fold:')).length, 0, 'no fold → fold arrow');
  assert.equal(fg.graph.edges.filter((e) => e.source === 'fold:T3').length, 1);
});
