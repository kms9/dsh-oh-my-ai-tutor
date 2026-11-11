// Mind-map gestures (mind-elixir) → course.editOutline ops, replayed against the real core.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, transition } from '../src/core.mjs';
import { toMindData, indexHierarchy, gestureToOps, TWO_LEVELS } from '../src/client/mindmap-ops.mjs';

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
  const h = () => ({ id: c().id, title: c().title, children: c().syllabus.topics.map((t) => ({ id: t.id, title: t.title, children: t.subtopics.map((s) => ({ id: s.id, title: s.title })) })) });
  const gesture = (name, args) => {
    const res = gestureToOps(indexHierarchy(h()), name, args);
    if (res.refuse !== undefined) return res;
    run('course.editOutline', { courseId: c().id, syllabusRevision: c().syllabus.revision, operations: res.ops }, 'learner');
    return res;
  };
  const titles = () => c().syllabus.topics.map((t) => `${t.title}:${t.subtopics.map((s) => s.title).join('')}`).join(' ');
  return { c, h, gesture, titles, state: () => state };
}

test('toMindData keeps syllabus ids and two levels', () => {
  const ctx = seed();
  const d = toMindData(ctx.h());
  assert.equal(d.nodeData.id, ctx.c().id);
  assert.equal(d.nodeData.children.length, 3);
  assert.equal(d.nodeData.children[0].children[1].id, ctx.c().syllabus.topics[0].subtopics[1].id);
  assert.ok(d.nodeData.children.every((t) => t.children.every((s) => !s.children)));
});

test('move before / after / in, step, rename, add and remove become outline ops', () => {
  const ctx = seed();
  const [t1, t2, t3] = ctx.c().syllabus.topics; const [a, b, c] = t1.subtopics;
  ctx.gesture('move', { where: 'after', ids: [a.id], target: b.id });
  assert.equal(ctx.titles(), 'T1:bac T2:e T3:f');
  ctx.gesture('move', { where: 'before', ids: [c.id], target: t2.subtopics[0].id });
  assert.equal(ctx.titles(), 'T1:ba T2:ce T3:f');
  ctx.gesture('move', { where: 'in', ids: [b.id], target: t3.id });
  assert.equal(ctx.titles(), 'T1:a T2:ce T3:fb');
  ctx.gesture('move', { where: 'before', ids: [t3.id], target: t1.id });
  assert.equal(ctx.titles(), 'T3:fb T1:a T2:ce');
  ctx.gesture('step', { id: t3.id, dir: 1 });
  assert.equal(ctx.titles(), 'T1:a T3:fb T2:ce');
  ctx.gesture('rename', { id: a.id, title: 'A' });
  ctx.gesture('addChild', { parentId: t1.id });
  assert.equal(ctx.titles(), 'T1:A新知识点 T3:fb T2:ce');
  ctx.gesture('insertSibling', { id: t3.id, position: 'before' });
  assert.equal(ctx.titles(), 'T1:A新知识点 新主题:新知识点 T3:fb T2:ce');
  ctx.gesture('remove', { ids: [t2.id, t2.subtopics[0].id] }); // topic removal covers its points
  assert.equal(ctx.titles(), 'T1:A新知识点 新主题:新知识点 T3:fb');
  assert.ok(ctx.state().events.slice(-8).every((e) => e.actor === 'learner'));
});

test('a third level and root edits are refused', () => {
  const ctx = seed();
  const [t1, t2] = ctx.c().syllabus.topics; const a = t1.subtopics[0];
  assert.equal(ctx.gesture('addChild', { parentId: a.id }).refuse, TWO_LEVELS);
  assert.equal(ctx.gesture('move', { where: 'in', ids: [t1.id], target: t2.id }).refuse, TWO_LEVELS);
  assert.equal(ctx.gesture('move', { where: 'in', ids: [a.id], target: t1.subtopics[1].id }).refuse, TWO_LEVELS);
  assert.ok(ctx.gesture('move', { where: 'before', ids: [a.id], target: t2.id }).refuse);
  assert.ok(ctx.gesture('rename', { id: ctx.c().id, title: 'x' }).refuse);
  assert.ok(ctx.gesture('remove', { ids: [ctx.c().id] }).refuse);
  assert.equal(ctx.titles(), 'T1:abc T2:e T3:f');
});
