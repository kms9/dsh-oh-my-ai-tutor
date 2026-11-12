import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, transition } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';
import { skeletonMindNodeId } from '../src/resources.mjs';
import { mindmapLayout } from '../src/client/layout.mjs';

function seed() {
  let state = newState();
  const run = (action, payload, actor = 'ai') => { const r = transition(state, action, payload, { actor, now: '2026-11-12T10:00:00.000Z' }); state = r.state; return r.result; };
  const goal = run('goal.create', { title: '学会极限', expectedOutcome: '能用定义判断极限' });
  const course = run('course.create', { goalId: goal.id, title: '微积分入门' });
  const plan = run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: [
    { title: '极限', subtopics: [{ title: '极限的定义' }, { title: '夹逼定理' }] },
  ] });
  run('course.approve', { courseId: course.id, syllabusRevision: 1 }, 'learner');
  return { get state() { return state; }, run, course, plan, c: () => state.courses[course.id] };
}

test('mindmap.generate enriches a skeleton without copying the outline 1:1, and skips existing titles', () => {
  const ctx = seed();
  const view = projectCourse(ctx.state, ctx.course.id, 'mindmap');
  assert.equal(view.skeleton, true);
  const def = skeletonMindNodeId(ctx.c().syllabus.topics[0].subtopics[0].id);
  const before = JSON.stringify(ctx.c().syllabus);
  const rev = ctx.state.mindmaps[ctx.course.id].revision;
  const out = ctx.run('mindmap.generate', { courseId: ctx.course.id, mindmapRevision: rev, nodes: [
    { parentId: def, title: '极限定义法', belongsTo: { type: 'concept', id: ctx.c().syllabus.topics[0].subtopics[0].conceptId } },
    { parentId: def, title: '常见错误：用数列代替任意路径' },
  ] });
  assert.equal(out.added, 2);
  assert.equal(out.skeleton, false);
  assert.equal(JSON.stringify(ctx.c().syllabus), before, 'syllabus unchanged');
  const generated = ctx.run('mindmap.generate', { courseId: ctx.course.id, mindmapRevision: out.mindmapRevision, nodes: [
    { parentId: def, title: '极限定义法' },
    { parentId: def, title: 'ε-δ 语言' },
  ] });
  assert.equal(generated.added, 1);
  assert.equal(generated.skipped.length, 1);
  assert.equal(generated.skipped[0].reason, 'duplicate');
  const h = projectCourse(ctx.state, ctx.course.id, 'mindmap').hierarchy;
  const ext = h.children[0].children[0].children.map((n) => n.title);
  assert.deepEqual(ext, ['极限定义法', '常见错误：用数列代替任意路径', 'ε-δ 语言']);
  const layout = mindmapLayout(h);
  assert.ok(layout.nodes.some((n) => n.title === 'ε-δ 语言' && n.depth >= 3));
});

test('mindmap.generate CAS rejects a stale revision and does not overwrite a learner rename', () => {
  const ctx = seed();
  const def = skeletonMindNodeId(ctx.c().syllabus.topics[0].subtopics[0].id);
  const edited = ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: 1, operations: [
    { op: 'addChild', parentId: def, title: '学习者自己写的展开' },
  ] }, 'learner');
  const nodeId = edited.touched[0];
  ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: edited.mindmapRevision, operations: [
    { op: 'rename', id: nodeId, title: '我改过的标题' },
  ] }, 'learner');
  const rev = ctx.state.mindmaps[ctx.course.id].revision;
  assert.throws(() => ctx.run('mindmap.generate', { courseId: ctx.course.id, mindmapRevision: 1, nodes: [{ parentId: def, title: 'x' }] }), /Mind map changed/);
  const out = ctx.run('mindmap.generate', { courseId: ctx.course.id, mindmapRevision: rev, nodes: [
    { parentId: def, title: '我改过的标题' },
    { parentId: def, title: '补充例子' },
  ] });
  assert.equal(out.added, 1);
  assert.equal(ctx.state.mindmaps[ctx.course.id].nodes[nodeId].title, '我改过的标题');
});

test('graph.generate adds extension nodes and only candidate relations, skipping duplicates', () => {
  const ctx = seed();
  const [a, b] = ctx.c().syllabus.topics[0].subtopics.map((s) => s.conceptId);
  const first = ctx.run('graph.generate', { courseId: ctx.course.id, nodes: [
    { title: '极限定义法', belongsTo: { type: 'concept', id: a }, ref: 'n1' },
  ], relations: [
    { from: a, to: b, type: 'prerequisite', note: '先掌握定义再看夹逼' },
    { from: '$n1', to: a, type: 'explains', note: '定义法用来展开极限定义' },
  ] });
  assert.equal(first.addedNodes.length, 1);
  assert.equal(first.addedRelations.length, 2);
  for (const id of first.addedRelations) assert.equal(ctx.state.relations[id].status, 'candidate');
  const again = ctx.run('graph.generate', { courseId: ctx.course.id, nodes: [
    { title: '极限定义法' }, { title: '极限的定义', refersTo: a },
  ], relations: [
    { from: a, to: b, type: 'prerequisite' },
  ] });
  assert.equal(again.addedNodes.length, 0);
  assert.equal(again.addedRelations.length, 0);
  assert.ok(again.skippedNodes.some((n) => n.reason === 'duplicate'));
  assert.ok(again.skippedNodes.some((n) => n.reason === 'exists'));
  assert.equal(again.skippedRelations.length, 1);
  const view = projectCourse(ctx.state, ctx.course.id, 'graph');
  assert.ok(view.nodes.some((n) => n.label === '极限定义法' && n.kind === 'extension'));
});

test('board.seed includes a promoted, out-of-syllabus knowledge point and extension notes; existing layout is kept', () => {
  const ctx = seed();
  const sub = ctx.c().syllabus.topics[0].subtopics[0];
  const parent = skeletonMindNodeId(sub.id);
  const added = ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: 1, operations: [
    { op: 'addChild', parentId: parent, title: '极限定义法', belongsTo: { type: 'concept', id: sub.conceptId } },
  ] }, 'learner');
  const nodeId = added.touched[0];
  const promoted = ctx.run('concept.promote', { courseId: ctx.course.id, from: { type: 'mindmapNode', id: nodeId } }, 'learner');
  const taught = ctx.c().syllabus.topics.flatMap((t) => t.subtopics.flatMap((s) => s.conceptIds ?? [s.conceptId]));
  assert.ok(!taught.includes(promoted.conceptId));

  const first = ctx.run('board.seed', { courseId: ctx.course.id, baseRevision: 0 });
  assert.ok(first.added > 0);
  let board = ctx.state.boards[ctx.course.id];
  const promoCard = board.elements.find((e) => !e.deleted && e.type === 'concept' && e.conceptId === promoted.conceptId);
  assert.ok(promoCard, 'promoted knowledge point is on the board');
  const syllabusCard = board.elements.find((e) => !e.deleted && e.type === 'concept' && e.conceptId === sub.conceptId);
  assert.ok(syllabusCard);
  // The mind-map node now refersTo the concept, so it is no longer seeded as an extension note.
  // Add a fresh extension that is not a knowledge point and re-seed.
  const ext = ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: ctx.state.mindmaps[ctx.course.id].revision, operations: [
    { op: 'addChild', parentId: parent, title: '易错：把单侧极限当成双侧', belongsTo: { type: 'concept', id: sub.conceptId } },
  ] }, 'learner');
  const moved = ctx.run('board.patch', { courseId: ctx.course.id, baseRevision: board.revision, operations: [
    { op: 'update', id: syllabusCard.id, x: 800, y: 400 },
  ] }, 'learner');
  const second = ctx.run('board.seed', { courseId: ctx.course.id, baseRevision: moved.revision });
  assert.ok(second.added >= 1, 'extension note is filled in');
  board = ctx.state.boards[ctx.course.id];
  assert.equal(board.elements.find((e) => e.id === syllabusCard.id).x, 800, 'learner layout is not overwritten');
  assert.equal(board.elements.find((e) => e.id === syllabusCard.id).y, 400);
  const note = board.elements.find((e) => !e.deleted && e.type === 'note' && e.seedKey === `ext-mm-${ext.touched[0]}`);
  assert.ok(note, 'extension appears as an annotation, not a knowledge-point card');
  assert.ok(note.anchors.some((a) => a.type === 'mindmapNode' && a.id === ext.touched[0]));
  const third = ctx.run('board.seed', { courseId: ctx.course.id, baseRevision: board.revision });
  assert.equal(third.added, 0);
});

test('board.generate adds teaching notes without moving cards; board.seed does not reopen syllabus approval', () => {
  const ctx = seed();
  const approvedAt = ctx.c().syllabus.approvedAt;
  const status = ctx.c().status;
  const first = ctx.run('board.seed', { courseId: ctx.course.id, baseRevision: 0 });
  const card = ctx.state.boards[ctx.course.id].elements.find((e) => e.type === 'concept');
  const gen = ctx.run('board.generate', { courseId: ctx.course.id, baseRevision: first.revision || ctx.state.boards[ctx.course.id].revision, notes: [
    { text: '本课重点：先分清极限存在的条件', nearConceptId: card.conceptId },
  ] });
  assert.ok(gen.added >= 1);
  const board = ctx.state.boards[ctx.course.id];
  assert.ok(board.elements.some((e) => !e.deleted && e.type === 'note' && e.text.includes('本课重点')));
  assert.equal(board.elements.find((e) => e.id === card.id).x, card.x);
  assert.equal(ctx.c().syllabus.approvedAt, approvedAt);
  assert.equal(ctx.c().status, status);
});
