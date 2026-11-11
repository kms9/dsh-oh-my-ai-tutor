import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, transition, snapshot } from '../src/core.mjs';
import { projectCourse } from '../src/projections.mjs';
import { JsonTutorStore } from '../src/store.mjs';
import { toolSpecs } from '../src/tools.mjs';
import { dispatch } from '../src/rpc.mjs';

function seed() {
  let state = newState();
  const run = (action, payload, actor) => { const r = transition(state, action, payload, { actor }); state = r.state; return r.result; };
  const goal = run('goal.create', { title: 'G', expectedOutcome: 'O' });
  const course = run('course.create', { goalId: goal.id, title: 'C' });
  run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: [
    { title: 'T1', subtopics: [{ title: 'a' }, { title: 'b' }] },
    { title: 'T2', subtopics: [{ title: 'c' }] },
  ] });
  run('course.approve', { courseId: course.id, syllabusRevision: 1 }, 'learner');
  return { get state() { return state; }, run, course };
}
const topicsOf = (s, cid) => s.courses[cid].syllabus.topics;

test('outline edit ops keep ids/concepts stable and reset approval', () => {
  const ctx = seed();
  const [t1, t2] = topicsOf(ctx.state, ctx.course.id);
  const bConcept = t1.subtopics[1].conceptId;
  ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 1, operations: [
    { op: 'moveSubtopic', subtopicId: t1.subtopics[1].id, toTopicId: t2.id, toIndex: 0 },
    { op: 'renameTopic', topicId: t2.id, title: 'T2 renamed' },
    { op: 'addSubtopic', topicId: t1.id, title: 'new', index: 0 },
    { op: 'moveTopic', topicId: t2.id, toIndex: 0 },
  ] }, 'learner');
  const after = topicsOf(ctx.state, ctx.course.id);
  assert.deepEqual(after.map((t) => t.title), ['T2 renamed', 'T1']);
  assert.deepEqual(after[0].subtopics.map((x) => x.title), ['b', 'c']);
  assert.equal(after[0].subtopics[0].conceptId, bConcept);
  assert.equal(ctx.state.concepts[bConcept].topicId, t2.id);
  assert.deepEqual(after[1].subtopics.map((x) => x.title), ['new', 'a']);
  assert.equal(ctx.state.courses[ctx.course.id].syllabus.approvedAt, null);
  assert.equal(ctx.state.courses[ctx.course.id].status, 'draft');
  assert.equal(ctx.state.events.at(-1).actor, 'learner');
  // remove retires concept, gate on empty topic and self-made ids
  ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 2, operations: [{ op: 'removeSubtopic', subtopicId: after[1].subtopics[0].id }] });
  assert.equal(Object.values(ctx.state.concepts).filter((c) => c.status === 'retired').length, 1);
  assert.throws(() => ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 3, operations: [{ op: 'removeSubtopic', subtopicId: topicsOf(ctx.state, ctx.course.id)[1].subtopics[0].id }] }), /no knowledge points/);
  assert.throws(() => ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 3, operations: [{ op: 'addTopic', id: 't9', title: 'x', subtopics: [{ title: 'y' }] }] }), /must not carry an id/);
  assert.throws(() => ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 1, operations: [{ op: 'moveTopic', topicId: after[0].id, toIndex: 1 }] }), /Outline changed/);
});

test('board seed, patch with CAS, cascade delete, stale concept cards', () => {
  const ctx = seed();
  const [t1] = topicsOf(ctx.state, ctx.course.id);
  const [a, b] = t1.subtopics.map((x) => x.conceptId);
  ctx.run('relation.propose', { from: a, to: b, type: 'prerequisite' });
  const seeded = ctx.run('board.seed', { courseId: ctx.course.id, baseRevision: 0 });
  assert.equal(seeded.added, 4);
  assert.equal(ctx.run('board.seed', { courseId: ctx.course.id, baseRevision: 1 }).added, 0);
  let board = snapshot(ctx.state, ctx.course.id).board;
  assert.equal(board.elements.filter((e) => e.type === 'arrow').length, 1);
  const cardA = board.elements.find((e) => e.conceptId === a);
  assert.throws(() => ctx.run('board.patch', { courseId: ctx.course.id, baseRevision: 0, operations: [{ op: 'delete', id: cardA.id }] }), /Board changed/);
  ctx.run('board.patch', { courseId: ctx.course.id, baseRevision: board.revision, operations: [
    { op: 'update', id: cardA.id, x: 500, y: 300 }, { op: 'add', type: 'note', ref: 'n1', text: '复习计划' },
    { op: 'add', type: 'arrow', from: '$n1', to: cardA.id, label: '用于' },
  ] }, 'learner');
  board = snapshot(ctx.state, ctx.course.id).board;
  assert.equal(board.elements.find((e) => e.id === cardA.id).x, 500);
  ctx.run('board.patch', { courseId: ctx.course.id, baseRevision: board.revision, operations: [{ op: 'delete', id: cardA.id }] });
  board = snapshot(ctx.state, ctx.course.id).board;
  assert.equal(board.elements.filter((e) => e.type === 'arrow').length, 0);
  assert.throws(() => ctx.run('board.patch', { courseId: ctx.course.id, baseRevision: board.revision, operations: [{ op: 'add', type: 'note', id: cardA.id, text: 'x' }] }), /must not carry an id/);
  // renaming the subtopic renames the card (card text follows syllabus)
  ctx.run('course.editOutline', { courseId: ctx.course.id, syllabusRevision: 1, operations: [{ op: 'renameSubtopic', subtopicId: t1.subtopics[1].id, title: 'b2' }] });
  assert.equal(projectCourse(ctx.state, ctx.course.id, 'board').elements.find((e) => e.conceptId === b).text, 'b2');
});

test('store + tools + rpc share one file; learner and AI edits are both visible and survive reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-edit-'));
  const path = join(dir, 'state.json');
  const store = new JsonTutorStore(path);
  const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
  const goal = (await tools.tutor_write.execute({ action: 'goal.create', payload_json: JSON.stringify({ title: 'g', expectedOutcome: 'o' }) })).result;
  const course = (await tools.tutor_write.execute({ action: 'course.create', payload_json: JSON.stringify({ goalId: goal.id, title: 'c' }) })).result;
  await tools.tutor_write.execute({ action: 'course.plan', payload_json: JSON.stringify({ courseId: course.id, syllabusRevision: 0, topics: [{ title: 'T', subtopics: [{ title: 'x' }, { title: 'y' }] }] }) });
  const outline = await tools.tutor_visualize.execute({ courseId: course.id, view: 'outline' });
  const ai = await tools.tutor_outline_edit.execute({ courseId: course.id, syllabusRevision: outline.syllabusRevision, operations: [{ op: 'renameTopic', topicId: outline.topics[0].id, title: 'T (AI)' }] });
  assert.equal(ai.outline.topics[0].title, 'T (AI)');
  await dispatch(store, { method: 'mutate', payload: { action: 'course.editOutline', input: { courseId: course.id, syllabusRevision: ai.outline.syllabusRevision, operations: [{ op: 'moveSubtopic', subtopicId: outline.topics[0].subtopics[1].id, toIndex: 0 }] } } });
  await assert.rejects(dispatch(store, { method: 'mutate', payload: { action: 'assessment.record', input: {} } }), /not allowed/);
  const model = await dispatch(store, { method: 'workbench', payload: {} });
  assert.deepEqual(model.views.outline.topics[0].subtopics.map((x) => x.title), ['y', 'x']);
  assert.deepEqual(model.events.slice(0, 2).map((e) => e.actor), ['learner', 'ai']);
  const b0 = await tools.tutor_board_read.execute({ courseId: course.id });
  const seeded = await tools.tutor_board_patch.execute({ courseId: course.id, baseRevision: b0.revision, seed: true });
  assert.equal(seeded.board.elements.length, 2);
  const reloaded = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(reloaded.boards[course.id].elements.length, 2);
  assert.equal((await new JsonTutorStore(path).head()).revision, reloaded.revision);
});
