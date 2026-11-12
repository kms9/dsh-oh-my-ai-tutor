// Mind-map gestures (mind-elixir) → mindmap.edit ops, replayed against the real core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, transition } from '../src/core.mjs';
import { toMindData, indexHierarchy, gestureToOps } from '../src/client/mindmap-ops.mjs';
import { mindmapHierarchy, skeletonMindNodeId } from '../src/resources.mjs';

function seed() {
  let state = newState();
  const run = (action, payload, actor = 'ai') => { const r = transition(state, action, payload, { actor }); state = r.state; return r.result; };
  const goal = run('goal.create', { title: 'G', expectedOutcome: 'O' });
  const course = run('course.create', { goalId: goal.id, title: 'C' });
  run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: [
    { title: 'T1', subtopics: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] },
    { title: 'T2', subtopics: [{ title: 'e' }] },
    { title: 'T3', subtopics: [{ title: 'f' }] },
  ] });
  const c = () => state.courses[course.id];
  const mm = () => state.mindmaps[course.id];
  const h = () => mindmapHierarchy(mm(), c());
  const gesture = (name, args) => {
    const res = gestureToOps(indexHierarchy(h()), name, args);
    if (res.refuse !== undefined) return res;
    run('mindmap.edit', { courseId: c().id, mindmapRevision: mm().revision, operations: res.ops }, 'learner');
    return res;
  };
  const titles = () => {
    const tree = h();
    return tree.children.map((t) => `${t.title}:${t.children.map((s) => s.title).join('')}`).join(' ');
  };
  return { c, h, mm, gesture, titles, state: () => state, run, courseId: course.id };
}

test('toMindData uses mind-map ids and can nest deeper than two levels', () => {
  const ctx = seed();
  const d = toMindData(ctx.h());
  assert.equal(d.nodeData.id, ctx.mm().rootId);
  assert.equal(d.nodeData.children.length, 3);
  const t1 = ctx.c().syllabus.topics[0];
  assert.equal(d.nodeData.children[0].id, skeletonMindNodeId(t1.id));
  assert.equal(d.nodeData.children[0].children[1].id, skeletonMindNodeId(t1.subtopics[1].id));
  ctx.gesture('addChild', { parentId: skeletonMindNodeId(t1.subtopics[0].id), title: '扩展' });
  const d2 = toMindData(ctx.h());
  const a = d2.nodeData.children[0].children[0];
  assert.equal(a.children[0].topic, '扩展');
});

test('move, step, rename, add and remove edit the mind map and leave the outline alone', () => {
  const ctx = seed();
  const outlineBefore = JSON.stringify(ctx.c().syllabus.topics);
  const [t1, t2, t3] = ctx.c().syllabus.topics;
  const [a, b, c] = t1.subtopics.map((s) => skeletonMindNodeId(s.id));
  const t1n = skeletonMindNodeId(t1.id), t2n = skeletonMindNodeId(t2.id), t3n = skeletonMindNodeId(t3.id);
  ctx.gesture('move', { where: 'after', ids: [a], target: b });
  assert.equal(ctx.titles(), 'T1:bac T2:e T3:f');
  ctx.gesture('move', { where: 'before', ids: [c], target: skeletonMindNodeId(t2.subtopics[0].id) });
  assert.equal(ctx.titles(), 'T1:ba T2:ce T3:f');
  ctx.gesture('move', { where: 'in', ids: [b], target: t3n });
  assert.equal(ctx.titles(), 'T1:a T2:ce T3:fb');
  ctx.gesture('move', { where: 'before', ids: [t3n], target: t1n });
  assert.equal(ctx.titles(), 'T3:fb T1:a T2:ce');
  ctx.gesture('step', { id: t3n, dir: 1 });
  assert.equal(ctx.titles(), 'T1:a T3:fb T2:ce');
  ctx.gesture('rename', { id: a, title: 'A' });
  ctx.gesture('addChild', { parentId: t1n });
  assert.equal(ctx.titles(), 'T1:A新节点 T3:fb T2:ce');
  ctx.gesture('insertSibling', { id: t3n, position: 'before' });
  assert.match(ctx.titles(), /T1:A新节点 新节点: T3:fb T2:ce/);
  ctx.gesture('remove', { ids: [t2n] });
  assert.match(ctx.titles(), /T1:A新节点 新节点: T3:fb$/);
  assert.equal(JSON.stringify(ctx.c().syllabus.topics), outlineBefore, 'outline unchanged');
  assert.ok(ctx.state().events.filter((e) => e.action === 'mindmap.edit').every((e) => e.actor === 'learner'));
});

test('a third level under a knowledge-point node is allowed; root cannot be deleted', () => {
  const ctx = seed();
  const [t1] = ctx.c().syllabus.topics;
  const a = skeletonMindNodeId(t1.subtopics[0].id);
  const outlineBefore = JSON.stringify(ctx.c().syllabus.topics);
  const res = ctx.gesture('addChild', { parentId: a, title: '极限定义法' });
  assert.equal(res.refuse, undefined);
  const child = ctx.h().children[0].children[0].children[0];
  assert.equal(child.title, '极限定义法');
  assert.equal(JSON.stringify(ctx.c().syllabus.topics), outlineBefore);
  assert.ok(ctx.gesture('remove', { ids: [ctx.mm().rootId] }).refuse);
});
