import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from '../src/client/graph-model.mjs';
import { pickGraphNode, resolveGraphSelection, selectionActions, relationRows } from '../src/client/graph-select.mjs';
import { nodeBox, labelLines, labelWeight, NODE_W, NODE_SIZE, MAX_LINES } from '../src/client/coa/graphLayout.mjs';

// one topic, two knowledge points (graph nodes gn-a / gn-b) and one extension node (ext, not a knowledge point)
const topics = [{ id: 'T1', title: '底层机制', subtopics: [{ id: 's1', conceptIds: ['kp-a'] }, { id: 's2', conceptIds: ['kp-b'] }] }];
const view = {
  nodes: [
    { id: 'gn-a', label: '间隔效应', conceptId: 'kp-a', mastery: 'developing' },
    { id: 'gn-b', label: '定义', conceptId: 'kp-b', mastery: 'unverified' },
    { id: 'ext', label: '艾宾浩斯遗忘曲线示意图（演示扩展）', conceptId: null, topicId: 'T1', mastery: null },
  ],
  edges: [
    { id: 'r1', from: 'ext', to: 'gn-a', type: 'prerequisite', status: 'candidate' },
    { id: 'r2', from: 'gn-a', to: 'gn-b', type: 'prerequisite', status: 'candidate' },
  ],
};
const g = buildGraph(view, topics);

test('selecting an extension node sticks and does not move the shared knowledge-point selection', () => {
  // before the fix the workbench fed concepts[0] back and the extension selection snapped to the first knowledge point
  const kp = 'kp-a'; // the knowledge point the other tabs have selected
  const { pick, syncKp } = pickGraphNode(g, 'ext', kp);
  assert.equal(syncKp, null, 'an extension is not a knowledge point: nothing to sync');
  assert.deepEqual(pick, { id: 'ext', kp });
  const n = resolveGraphSelection(g, pick, kp);
  assert.equal(n.id, 'ext');
  assert.equal(n.kind, 'extension');
  assert.deepEqual(selectionActions(n), { quiz: false, mastery: false, focus: true, path: true });
});

test('selecting a knowledge-point node syncs the shared selection; topics stay graph-only', () => {
  const { pick, syncKp } = pickGraphNode(g, 'gn-b', 'kp-a');
  assert.equal(syncKp, 'kp-b');
  assert.equal(resolveGraphSelection(g, pick, 'kp-b').id, 'gn-b', 'after the sync the pick is still valid');
  assert.deepEqual(selectionActions(resolveGraphSelection(g, pick, 'kp-b')), { quiz: true, mastery: true, focus: true, path: true });
  const t = pickGraphNode(g, 'topic:T1', 'kp-a');
  assert.equal(t.syncKp, null);
  const tn = resolveGraphSelection(g, t.pick, 'kp-a');
  assert.equal(tn.kind, 'topic');
  assert.deepEqual(selectionActions(tn), { quiz: false, mastery: false, focus: false, path: false });
  assert.equal(pickGraphNode(g, 'fold:x', 'kp-a').pick, null, 'unknown / fold nodes are not selectable');
});

test('another tab changing the knowledge-point selection wins over an older graph pick', () => {
  const { pick } = pickGraphNode(g, 'ext', 'kp-a');
  assert.equal(resolveGraphSelection(g, pick, 'kp-b').id, 'gn-b');
  assert.equal(resolveGraphSelection(g, null, 'kp-a').id, 'gn-a');
  assert.equal(resolveGraphSelection(g, null, null), null);
});

test('relation rows: one compact row per relation with direction and the other end', () => {
  const rows = relationRows(g, [...view.edges, { id: 'r2', from: 'kp-a', to: 'kp-b', type: 'prerequisite' }], 'gn-a', 'kp-a');
  assert.deepEqual(rows.map((r) => [r.id, r.dir, r.otherId, r.otherLabel]), [['r1', 'in', 'ext', view.nodes[2].label], ['r2', 'out', 'gn-b', '定义']]);
  assert.deepEqual(relationRows(g, view.edges, 'ext').map((r) => [r.dir, r.otherId]), [['out', 'gn-a']]);
});

test('rect nodes: width clamps to NODE_W, long labels wrap (≤ 4 lines) and grow the height, short ones keep the base box', () => {
  assert.deepEqual(nodeBox({ kind: 'concept', label: '定义' }), NODE_SIZE.concept);
  const long = nodeBox({ kind: 'concept', label: '遗忘曲线与「恰到好处的难度」' });
  assert.equal(long.w, NODE_W.concept[1], 'a long label takes the widest box');
  assert.ok(long.h > NODE_SIZE.concept.h, 'and wraps to more lines');
  const huge = nodeBox({ kind: 'concept', label: '很长'.repeat(40) });
  assert.equal(labelLines({ kind: 'concept', label: '很长'.repeat(40) }, huge.w), MAX_LINES, 'never more than 4 lines');
  assert.ok(huge.w <= NODE_W.concept[1] && huge.h < 100);
  for (const k of ['topic', 'concept', 'extension']) {
    const b = nodeBox({ kind: k, label: '间隔效应间隔效应' });
    assert.ok(b.w >= NODE_W[k][0] && b.w <= NODE_W[k][1] && b.w > b.h, `${k}: landscape, clamped`);
  }
  assert.ok(nodeBox({ kind: 'extension', label: view.nodes[2].label }).w >= nodeBox({ kind: 'extension', label: '遗忘曲线' }).w);
  assert.ok(labelWeight('spacing') < labelWeight('间隔效应间隔'), 'ASCII counts about half');
  assert.equal(nodeBox({ kind: 'fold', title: '主题' }).w, NODE_W.fold[1]);
});
