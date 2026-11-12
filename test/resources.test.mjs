import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, transition } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';
import { SqliteTutorStore, DB_VERSION } from '../src/sqlite-store.mjs';
import { skeletonMindNodeId, conceptIdsFromAnchors } from '../src/resources.mjs';

function seed(topics) {
  let state = newState();
  const run = (action, payload, actor = 'ai') => { const r = transition(state, action, payload, { actor, now: '2026-11-12T10:00:00.000Z' }); state = r.state; return r.result; };
  const goal = run('goal.create', { title: 'G', expectedOutcome: 'O' });
  const course = run('course.create', { goalId: goal.id, title: '微积分' });
  run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: topics ?? [
    { title: '极限', subtopics: [{ title: '极限的定义' }, { title: '夹逼定理' }] },
  ] });
  run('course.approve', { courseId: course.id, syllabusRevision: 1 }, 'learner');
  return { get state() { return state; }, run, course, c: () => state.courses[course.id] };
}

test('editing the mind map does not change the syllabus; nodes can belongTo a concept', () => {
  const ctx = seed();
  const sub = ctx.c().syllabus.topics[0].subtopics[0];
  const parent = skeletonMindNodeId(sub.id);
  const before = JSON.stringify(ctx.c().syllabus);
  const edited = ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: ctx.state.mindmaps[ctx.course.id].revision, operations: [
    { op: 'addChild', parentId: parent, title: '极限定义法', belongsTo: { type: 'concept', id: sub.conceptId } },
  ] }, 'learner');
  assert.equal(JSON.stringify(ctx.c().syllabus), before);
  const node = ctx.state.mindmaps[ctx.course.id].nodes[edited.touched[0]];
  assert.equal(node.title, '极限定义法');
  assert.deepEqual(node.belongsTo, { type: 'concept', id: sub.conceptId });
  assert.equal(node.refersTo, null);
  const view = projectCourse(ctx.state, ctx.course.id, 'mindmap');
  assert.equal(view.hierarchy.children[0].children[0].children[0].title, '极限定义法');
  assert.notEqual(view.hierarchy.children[0].children[0].id, sub.id);
});

test('concept.promote writes refersTo back and only then creates a reviewable knowledge point', () => {
  const ctx = seed();
  const sub = ctx.c().syllabus.topics[0].subtopics[0];
  const parent = skeletonMindNodeId(sub.id);
  const added = ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: 1, operations: [
    { op: 'addChild', parentId: parent, title: '极限定义法' },
  ] }, 'learner');
  const nodeId = added.touched[0];
  const beforeIds = new Set(Object.keys(ctx.state.concepts));
  const promoted = ctx.run('concept.promote', { courseId: ctx.course.id, from: { type: 'mindmapNode', id: nodeId } }, 'learner');
  assert.ok(promoted.conceptId);
  assert.ok(!beforeIds.has(promoted.conceptId));
  assert.equal(ctx.state.mindmaps[ctx.course.id].nodes[nodeId].refersTo, promoted.conceptId);
  assert.equal(ctx.state.concepts[promoted.conceptId].title, '极限定义法');
  assert.equal(ctx.state.concepts[promoted.conceptId].status, 'active');
  // still not in the syllabus
  const taught = ctx.c().syllabus.topics.flatMap((t) => t.subtopics.flatMap((s) => s.conceptIds ?? [s.conceptId]));
  assert.ok(!taught.includes(promoted.conceptId));
  assert.equal(ctx.state.graphNodes[`gn-${promoted.conceptId}`].refersTo, promoted.conceptId);
});

test('notes and board cards accept wide anchors; assessments still only point at concepts', async () => {
  const ctx = seed();
  const sub = ctx.c().syllabus.topics[0].subtopics[0];
  const parent = skeletonMindNodeId(sub.id);
  const added = ctx.run('mindmap.edit', { courseId: ctx.course.id, mindmapRevision: 1, operations: [
    { op: 'addChild', parentId: parent, title: '极限定义法' },
  ] }, 'learner');
  const nodeId = added.touched[0];
  const lesson = ctx.run('lesson.create', { courseId: ctx.course.id, title: 'L', parts: [{ title: 'P', objective: 'O' }] });
  const note = ctx.run('note.add', { courseId: ctx.course.id, title: '关于定义法', content: '还要再看例子', anchors: [{ type: 'mindmapNode', id: nodeId }] }, 'learner');
  assert.deepEqual(note.anchors, [{ type: 'mindmapNode', id: nodeId }]);
  assert.deepEqual(note.conceptIds, []);
  assert.equal(note.lessonId, null);
  const topicNote = ctx.run('note.add', { lessonId: lesson.id, title: '整章感受', content: '这一章节奏偏快', anchors: [{ type: 'topic', id: ctx.c().syllabus.topics[0].id }] }, 'learner');
  assert.ok(topicNote.anchors.some((a) => a.type === 'topic'));
  assert.ok(topicNote.anchors.some((a) => a.type === 'lesson' && a.id === lesson.id));
  assert.throws(() => ctx.run('assessment.record', { lessonId: lesson.id, conceptId: nodeId, question: 'q', studentAnswer: 'a', feedback: 'f', score: 1, transfer: true, hintCount: 0 }), /Unknown concepts id/);
});

test('applySyllabus no longer retires unmentioned concepts; graph nodes stay when the outline drops a subtopic', () => {
  const ctx = seed();
  const [a, b] = ctx.c().syllabus.topics[0].subtopics;
  ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 1, operations: [{ op: 'removeSubtopic', subtopicId: b.id }] });
  assert.equal(ctx.state.concepts[b.conceptId].status, 'active');
  assert.ok(ctx.state.graphNodes[`gn-${b.conceptId}`]);
  assert.equal(ctx.state.concepts[a.conceptId].status, 'active');
});

test('sqlite v4 migration seeds an independent mind map and does not drop assessment or review rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-v4-'));
  const jsonPath = join(dir, 'state.json');
  const dbPath = join(dir, 'tutor.db');
  let state = newState();
  const run = (action, payload, actor = 'ai') => { const r = transition(state, action, payload, { actor, now: '2026-11-11T00:00:00.000Z' }); state = r.state; return r.result; };
  // Build a pre-v4 shaped document: no mindmaps/graphNodes, relations on concept ids, notes with conceptIds only.
  const goal = run('goal.create', { title: 'G', expectedOutcome: 'O' });
  const course = run('course.create', { goalId: goal.id, title: 'C' });
  const plan = run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: [
    { title: 'T', subtopics: [{ title: 'A' }, { title: 'B' }] },
  ] });
  run('course.approve', { courseId: course.id, syllabusRevision: 1 }, 'learner');
  const ids = plan.syllabus.topics[0].subtopics.map((s) => s.conceptId);
  run('relation.propose', { from: ids[0], to: ids[1], type: 'prerequisite' });
  const lesson = run('lesson.create', { courseId: course.id, title: 'L1', parts: [{ title: 'P', objective: 'O' }] });
  run('lesson.approve', { lessonId: lesson.id }, 'learner');
  run('lesson.partWrite', { lessonId: lesson.id, partIndex: 0, body: 'body' });
  run('lesson.cover', { lessonId: lesson.id, partIndex: 0 });
  const assess = run('assessment.record', { lessonId: lesson.id, conceptId: ids[0], question: 'What is A?', studentAnswer: 'A is A', feedback: 'ok', score: 0.9, transfer: true, hintCount: 0 });
  const assessId = assess.assessment?.id ?? assess.id;
  assert.equal(state.concepts[ids[0]].mastery, 'demonstrated');
  // strip upgraded collections to simulate a v3 JSON file
  const legacy = structuredClone(state);
  delete legacy.mindmaps;
  delete legacy.graphNodes;
  for (const r of Object.values(legacy.relations)) {
    r.from = r.fromConceptId ?? ids[0];
    r.to = r.toConceptId ?? ids[1];
    delete r.fromConceptId; delete r.toConceptId;
  }
  for (const n of Object.values(legacy.notes)) delete n.anchors;
  for (const t of legacy.courses[course.id].syllabus.topics) for (const s of t.subtopics) delete s.conceptIds;
  await writeFile(jsonPath, JSON.stringify(legacy));
  const store = new SqliteTutorStore(dbPath, { legacyJsonPath: jsonPath });
  const loaded = await store.read();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, DB_VERSION);
  assert.ok(loaded.mindmaps[course.id], 'mind map seeded');
  const mmNode = loaded.mindmaps[course.id].nodes[skeletonMindNodeId(plan.syllabus.topics[0].subtopics[0].id)];
  assert.equal(mmNode.belongsTo.type, 'concept');
  assert.equal(mmNode.belongsTo.id, ids[0]);
  assert.equal(loaded.concepts[ids[0]].mastery, 'demonstrated');
  assert.ok(loaded.assessments[assessId]);
  assert.equal(loaded.assessments[assessId].conceptId, ids[0]);
  assert.equal(loaded.graphNodes[`gn-${ids[0]}`].refersTo, ids[0]);
  const rel = Object.values(loaded.relations)[0];
  assert.equal(rel.from, `gn-${ids[0]}`);
  assert.equal(rel.to, `gn-${ids[1]}`);
  assert.equal(rel.fromConceptId, ids[0]);
  const card = store.db.prepare('SELECT * FROM review_cards WHERE concept_id = ?').get(ids[0]);
  assert.ok(card, 'review card still keyed by the original concept id');
  store.close();
});
