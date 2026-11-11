// Regression tests for the cloud review (Grok 4.7, 2026-11-11) items 1–14 that are testable without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateArgs } from '@deepseek-ai/dsh-tools';
import { newState, transition } from '../src/core.mjs';
import { JsonTutorStore } from '../src/store.mjs';
import { toolSpecs, WRITE_ACTIONS, VIEWS } from '../src/tools.mjs';
import { dispatch, LEARNER_ACTIONS } from '../src/rpc.mjs';
import { markdownToHtml, safeColor } from '../src/client/layout.mjs';

function seed() {
  let state = newState();
  const run = (action, payload, actor = 'ai') => { const r = transition(state, action, payload, { actor }); state = r.state; return r.result; };
  const goal = run('goal.create', { title: 'G', expectedOutcome: 'O' });
  const course = run('course.create', { goalId: goal.id, title: 'C' });
  run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: [
    { title: 'T1', subtopics: [{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }] },
    { title: 'T2', subtopics: [{ title: 'e' }] },
    { title: 'T3', subtopics: [{ title: 'f' }] },
  ] });
  return { get state() { return state; }, run, course, cid: course.id };
}
const course = (ctx) => ctx.state.courses[ctx.cid];
const topics = (ctx) => course(ctx).syllabus.topics;
const rev = (ctx) => course(ctx).syllabus.revision;

test('#1 approval is learner-only and must match the outline revision on screen', () => {
  const ctx = seed();
  assert.throws(() => ctx.run('course.approve', { courseId: ctx.cid, syllabusRevision: rev(ctx) }, 'ai'), (e) => e.code === 'forbidden' && /Only the learner/.test(e.message));
  assert.throws(() => ctx.run('course.approve', { courseId: ctx.cid }, 'learner'), /syllabusRevision is required/);
  const seen = rev(ctx);
  ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: seen, operations: [{ op: 'renameTopic', topicId: topics(ctx)[0].id, title: 'unseen' }] }, 'ai');
  assert.throws(() => ctx.run('course.approve', { courseId: ctx.cid, syllabusRevision: seen }, 'learner'), (e) => e.code === 'conflict' && e.syllabusRevision === seen + 1);
  assert.equal(course(ctx).status, 'draft');
  ctx.run('course.approve', { courseId: ctx.cid, syllabusRevision: seen + 1 }, 'learner');
  assert.equal(course(ctx).status, 'active');
  assert.equal(course(ctx).syllabus.approvedBy, 'learner');
  const lesson = ctx.run('lesson.create', { courseId: ctx.cid, title: 'L', parts: [{ title: 'p', objective: 'o' }] });
  assert.throws(() => ctx.run('lesson.approve', { lessonId: lesson.id }, 'ai'), (e) => e.code === 'forbidden');
  ctx.run('lesson.approve', { lessonId: lesson.id }, 'learner');
  assert.ok(!WRITE_ACTIONS.includes('course.approve') && !WRITE_ACTIONS.includes('lesson.approve'), 'AI tool cannot even name the approve actions');
  assert.ok(LEARNER_ACTIONS.includes('course.approve'));
});

test('#1 tutor_write cannot approve; the workbench RPC approves only the shown revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-review-'));
  try {
    const store = new JsonTutorStore(join(dir, 'state.json'));
    const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
    const w = (action, payload) => tools.tutor_write.execute({ action, payload_json: JSON.stringify(payload) });
    const goal = (await w('goal.create', { title: 'g', expectedOutcome: 'o' })).result;
    const c = (await w('course.create', { goalId: goal.id, title: 'c' })).result;
    await w('course.plan', { courseId: c.id, syllabusRevision: 0, topics: [{ title: 'T', subtopics: [{ title: 'x' }] }] });
    // even bypassing the enum (the host validates it), the core refuses an AI approval
    await assert.rejects(w('course.approve', { courseId: c.id, syllabusRevision: 1 }), /Only the learner/);
    const rpc = (action, input) => dispatch(store, { method: 'mutate', payload: { action, input } });
    await assert.rejects(rpc('course.approve', { courseId: c.id, syllabusRevision: 0 }), (e) => e.code === 'conflict');
    const ok = await rpc('course.approve', { courseId: c.id, syllabusRevision: 1 });
    assert.equal(ok.result.status, 'active');
    const errors = validateArgs(tools.tutor_write.parameters, { action: 'course.approve', payload_json: '{}' });
    assert.ok(errors.length > 0, 'host schema rejects course.approve as a tutor_write action');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#3 editOutline requires syllabusRevision; course.plan needs it and keeps unmentioned topics', () => {
  const ctx = seed();
  assert.throws(() => ctx.run('course.editOutline', { courseId: ctx.cid, operations: [{ op: 'renameTopic', topicId: topics(ctx)[0].id, title: 'x' }] }), /syllabusRevision is required/);
  const r0 = rev(ctx);
  ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: r0, operations: [{ op: 'renameTopic', topicId: topics(ctx)[0].id, title: '学习者改名' }] }, 'learner');
  // AI replays an old tree with the old revision → conflict instead of overwriting the learner
  const stale = [{ id: topics(ctx)[0].id, title: 'T1', subtopics: topics(ctx)[0].subtopics.map((s) => ({ id: s.id, title: s.title })) }];
  assert.throws(() => ctx.run('course.plan', { courseId: ctx.cid, syllabusRevision: r0, topics: stale }), (e) => e.code === 'conflict');
  assert.throws(() => ctx.run('course.plan', { courseId: ctx.cid, topics: stale }), /syllabusRevision is required/);
  assert.equal(topics(ctx)[0].title, '学习者改名');
  // a fresh plan mentioning only T1 keeps T2/T3 (no silent deletion)
  const out = ctx.run('course.plan', { courseId: ctx.cid, syllabusRevision: rev(ctx), topics: [{ id: topics(ctx)[0].id, title: 'T1 新', subtopics: [{ title: 'new' }] }] });
  assert.deepEqual(topics(ctx).map((t) => t.title), ['T1 新', 'T2', 'T3']);
  assert.deepEqual(topics(ctx)[0].subtopics.map((s) => s.title), ['new', 'a', 'b', 'c', 'd']);
  assert.equal(out.keptUnmentioned.length, 6);
});

test('#4 moving down inside one list: beforeId lands right before the target; toIndex keeps its documented meaning', () => {
  const ctx = seed();
  const [a, b, c, d] = topics(ctx)[0].subtopics;
  ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: rev(ctx), operations: [{ op: 'moveSubtopic', subtopicId: a.id, beforeId: d.id }] }, 'learner');
  assert.deepEqual(topics(ctx)[0].subtopics.map((s) => s.title), ['b', 'c', 'a', 'd']);
  ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: rev(ctx), operations: [{ op: 'moveSubtopic', subtopicId: b.id, beforeId: null }] }, 'learner');
  assert.deepEqual(topics(ctx)[0].subtopics.map((s) => s.title), ['c', 'a', 'd', 'b']);
  const t2 = topics(ctx)[1];
  ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: rev(ctx), operations: [{ op: 'moveSubtopic', subtopicId: c.id, beforeId: t2.subtopics[0].id }] }, 'learner');
  assert.deepEqual(topics(ctx)[1].subtopics.map((s) => s.title), ['c', 'e']);
  const [T1, T2, T3] = topics(ctx);
  ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: rev(ctx), operations: [{ op: 'moveTopic', topicId: T1.id, beforeId: T3.id }] }, 'learner');
  assert.deepEqual(topics(ctx).map((t) => t.id), [T2.id, T1.id, T3.id]);
  assert.throws(() => ctx.run('course.editOutline', { courseId: ctx.cid, syllabusRevision: rev(ctx), operations: [{ op: 'moveSubtopic', subtopicId: a.id, toTopicId: T3.id, beforeId: d.id }] }), /inside toTopicId/);
});

test('#6 re-seeding after deleting a card restores the card and its relation arrow; same-batch repeat delete succeeds', () => {
  const ctx = seed();
  const [a, b] = topics(ctx)[0].subtopics.map((s) => s.conceptId);
  ctx.run('relation.propose', { from: a, to: b, type: 'prerequisite' });
  ctx.run('board.seed', { courseId: ctx.cid, baseRevision: 0 });
  let board = ctx.state.boards[ctx.cid];
  const cardA = board.elements.find((e) => e.conceptId === a);
  const arrow = board.elements.find((e) => e.type === 'arrow');
  // card + its cascaded arrow in one batch: the second delete is a harmless no-op, the batch commits
  ctx.run('board.patch', { courseId: ctx.cid, baseRevision: board.revision, operations: [{ op: 'delete', id: cardA.id }, { op: 'delete', id: arrow.id }] }, 'learner');
  board = ctx.state.boards[ctx.cid];
  assert.ok(board.elements.find((e) => e.id === cardA.id).deleted);
  assert.equal(board.elements.find((e) => e.id === arrow.id).deletedBy, 'cascade');
  const reseed = ctx.run('board.seed', { courseId: ctx.cid, baseRevision: board.revision });
  assert.equal(reseed.added, 2, 'card and relation arrow come back');
  board = ctx.state.boards[ctx.cid];
  const liveArrows = board.elements.filter((e) => e.type === 'arrow' && !e.deleted);
  assert.equal(liveArrows.length, 1);
  // an arrow deleted on purpose stays deleted
  ctx.run('board.patch', { courseId: ctx.cid, baseRevision: board.revision, operations: [{ op: 'delete', id: liveArrows[0].id }] }, 'learner');
  assert.equal(ctx.run('board.seed', { courseId: ctx.cid, baseRevision: ctx.state.boards[ctx.cid].revision }).added, 0);
  assert.throws(() => ctx.run('board.patch', { courseId: ctx.cid, baseRevision: ctx.state.boards[ctx.cid].revision, operations: [{ op: 'delete', id: 'kp-kp-made-up' }] }), /only come from tutor_board_read/);
});

test('#7 board.seed requires baseRevision', () => {
  const ctx = seed();
  assert.throws(() => ctx.run('board.seed', { courseId: ctx.cid }), /baseRevision/);
});

test('#8 strict tool schemas: op shapes, no ids on new notes, refs inside one batch, no whiteboard-seed view', () => {
  const tools = Object.fromEntries(toolSpecs({}).map((t) => [t.name, t]));
  const P = tools.tutor_board_patch.parameters, O = tools.tutor_outline_edit.parameters;
  assert.deepEqual(validateArgs(P, { courseId: 'c', baseRevision: 1, operations: [{ op: 'add', type: 'note', text: 'x', ref: 'n1' }, { op: 'add', type: 'arrow', from: '$n1', to: 'card-1' }] }), []);
  assert.ok(validateArgs(P, { courseId: 'c', baseRevision: 1, operations: [{ op: 'add', type: 'note', id: 'note-1', text: 'x' }] }).length, 'model-chosen ids are rejected by the host');
  assert.ok(validateArgs(P, { courseId: 'c', baseRevision: 1, operations: [{ op: 'add', type: 'rectangle', text: 'x' }] }).length);
  assert.ok(validateArgs(P, { courseId: 'c', operations: [{ op: 'delete', id: 'x' }] }).length, 'baseRevision required');
  assert.deepEqual(validateArgs(O, { courseId: 'c', syllabusRevision: 2, operations: [{ op: 'moveSubtopic', subtopicId: 's', beforeId: 't' }] }), []);
  assert.ok(validateArgs(O, { courseId: 'c', operations: [{ op: 'renameTopic', topicId: 't', title: 'x' }] }).length, 'syllabusRevision required');
  assert.ok(validateArgs(O, { courseId: 'c', syllabusRevision: 1, operations: [{ op: 'addTopic', id: 'x', title: 'x', subtopics: [{ title: 'y' }] }] }).length);
  assert.ok(validateArgs(O, { courseId: 'c', syllabusRevision: 1, operations: [{ op: 'frobnicate' }] }).length);
  assert.ok(!VIEWS.includes('whiteboard-seed'));
  // core side: the same rule holds for tutor_write board.patch (free JSON)
  const ctx = seed();
  ctx.run('board.seed', { courseId: ctx.cid, baseRevision: 0 });
  const card = ctx.state.boards[ctx.cid].elements[0];
  assert.throws(() => ctx.run('board.patch', { courseId: ctx.cid, baseRevision: 1, operations: [{ op: 'add', type: 'note', id: 'note-1', text: 'x' }] }), /must not carry an id/);
  const r = ctx.run('board.patch', { courseId: ctx.cid, baseRevision: 1, operations: [{ op: 'add', type: 'note', ref: 'n', text: 'x' }, { op: 'add', type: 'arrow', from: '$n', to: card.id }] });
  assert.match(r.refs.n, /^note-/);
});

test('#9 note author is the caller, never a payload field', () => {
  const ctx = seed();
  ctx.run('course.approve', { courseId: ctx.cid, syllabusRevision: rev(ctx) }, 'learner');
  const l = ctx.run('lesson.create', { courseId: ctx.cid, title: 'L', parts: [{ title: 'p', objective: 'o' }] });
  const n = ctx.run('note.add', { lessonId: l.id, title: 't', content: 'c', author: 'learner' }, 'ai');
  assert.equal(n.author, 'ai');
  assert.equal(ctx.state.events.at(-1).actor, 'ai');
});

test('#10 head returns only the revision and does not parse the whole file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tutor-head-'));
  try {
    const path = join(dir, 'state.json');
    const store = new JsonTutorStore(path);
    assert.deepEqual(await store.head(), { revision: 0 });
    await store.mutate('goal.create', { title: 'g', expectedOutcome: 'o' });
    assert.deepEqual(await store.head(), { revision: 1 });
    // corrupt the tail: a full parse would throw; the header read still answers
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.slice(0, -5));
    assert.deepEqual(await new JsonTutorStore(path).head(), { revision: 1 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('#13/#14 colours are whitelisted, separator-only tables do not crash, coordinates are clamped', () => {
  const ctx = seed();
  ctx.run('board.seed', { courseId: ctx.cid, baseRevision: 0 });
  const card = ctx.state.boards[ctx.cid].elements[0];
  assert.throws(() => ctx.run('board.patch', { courseId: ctx.cid, baseRevision: 1, operations: [{ op: 'update', id: card.id, color: 'url(//a.co/x)' }] }), /color must be/);
  ctx.run('board.patch', { courseId: ctx.cid, baseRevision: 1, operations: [{ op: 'update', id: card.id, color: '#eef', x: -500, y: -1 }] });
  const moved = ctx.state.boards[ctx.cid].elements[0];
  assert.deepEqual([moved.x, moved.y, moved.color], [0, 0, '#eef']);
  assert.equal(safeColor('url(x)'), undefined);
  assert.equal(safeColor('#a1b2c3'), '#a1b2c3');
  assert.doesNotThrow(() => markdownToHtml('| --- |\n| :-: |'));
  assert.equal(markdownToHtml('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('event ledger is bounded', () => {
  let state = newState();
  state.revision = 2099;
  state.events = Array.from({ length: 2099 }, (_, i) => ({ revision: i + 1, at: 'x', action: 'goal.create', actor: 'ai', entityId: null }));
  state = transition(state, 'goal.create', { title: 'g', expectedOutcome: 'o' }).state;
  assert.equal(state.events.length, 2000);
  assert.equal(state.events.at(-1).revision, 2100);
});
