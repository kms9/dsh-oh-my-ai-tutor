// Learning flow absorbed from the Heptabase-style tutors (G1–G5) + AI approval + clickable resources.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTutorStore, DB_VERSION, SCHEMA_V1, MIGRATIONS } from '../src/sqlite-store.mjs';
import { JsonTutorStore } from '../src/store.mjs';
import { toolSpecs } from '../src/tools.mjs';
import { dispatch } from '../src/rpc.mjs';
import { newState, transition, snapshot, liveBoard, sinceApproved } from '../src/core.mjs';
import { parseTutorHref, sourceHref, parseLocator, refView, internalHref } from '../src/links.mjs';
import { diffOutline, diffLines } from '../src/outline-diff.mjs';

const FIXTURE = new URL('./fixtures/spaced-repetition.state.json', import.meta.url);
async function tmp(fn) { const dir = await mkdtemp(join(tmpdir(), 'omt-flow-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

/** A fresh SQLite store with an approved two-topic course, via the model-facing tools. */
async function course(dir) {
  const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: null });
  store.open();
  const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
  const w = async (action, payload) => tools.tutor_write.execute({ action, payload_json: JSON.stringify(payload) });
  const goal = (await w('goal.create', { title: '二次函数', expectedOutcome: '会画图并求最值' })).result;
  const c = (await w('course.create', { goalId: goal.id, title: '二次函数入门' })).result;
  const plan = (await w('course.plan', { courseId: c.id, syllabusRevision: 0, topics: [
    { title: '图像', subtopics: [{ title: '开口方向' }, { title: '顶点式' }] },
    { title: '最值', subtopics: [{ title: '配方法' }] },
  ] })).result;
  const rpc = (action, input) => dispatch(store, { method: 'mutate', payload: { action, input } });
  await rpc('course.approve', { courseId: c.id, syllabusRevision: plan.syllabus.revision });
  const topics = (await store.read()).courses[c.id].syllabus.topics;
  return { store, tools, w, rpc, cid: c.id, topics, kp: topics.flatMap((t) => t.subtopics.map((s) => s.conceptId)) };
}

test('links: internal hrefs round-trip; locators fold into source URLs; legacy refs stay readable text', () => {
  const h = internalHref('concept', 'kp-1', 'course-1');
  assert.equal(h, 'https://tutor.invalid/concept/kp-1?course=course-1');
  assert.deepEqual(parseTutorHref(h), { kind: 'concept', id: 'kp-1', courseId: 'course-1' });
  assert.equal(parseTutorHref('https://example.org/concept/kp-1'), null);
  assert.equal(parseTutorHref('https://tutor.invalid/evil/x'), null);
  assert.deepEqual(parseLocator('第12页'), { locator: '第12页', page: 12 });
  assert.deepEqual(parseLocator('01:30'), { locator: '01:30', seconds: 90 });
  assert.equal(sourceHref({ uri: 'https://x.org/book.pdf', kind: 'file' }, { page: 12 }), 'https://x.org/book.pdf#page=12');
  assert.equal(sourceHref({ uri: 'https://www.youtube.com/watch?v=abc', kind: 'video' }, { seconds: 90 }), 'https://www.youtube.com/watch?v=abc&t=90s');
  assert.equal(sourceHref({ uri: 'https://www.bilibili.com/video/BV1', kind: 'video' }, { seconds: 75 }), 'https://www.bilibili.com/video/BV1?t=75');
  assert.equal(sourceHref({ uri: 'notes/ch1.md', kind: 'file' }), 'notes/ch1.md');
  assert.equal(sourceHref({ uri: 'javascript:alert(1)', kind: 'web' }), null, 'never a script URL');
  const legacy = refView(newState(), '间隔重复.txt:L5-L6');
  assert.equal(legacy.legacy, true); assert.equal(legacy.href, null); assert.equal(legacy.label, '间隔重复.txt:L5-L6');
});

test('outline diff: minimal moves, renames, adds, retired points; lines are Chinese', () => {
  const A = [{ id: 't1', title: 'A', subtopics: [{ id: 's1', title: 'a1' }, { id: 's2', title: 'a2' }] }, { id: 't2', title: 'B', subtopics: [{ id: 's3', title: 'b1' }] }];
  const B = [{ id: 't2', title: 'B', subtopics: [{ id: 's3', title: 'b1' }, { id: 's1', title: 'a1' }] }, { id: 't1', title: 'A2', subtopics: [{ id: 's4', title: 'new' }] }];
  const lines = diffLines(diffOutline(A, B));
  assert.ok(lines.includes('✎ 主题「A」改名为「A2」'));
  assert.ok(lines.includes('↕ 知识点「a1」从「A」移到「B」'));
  assert.ok(lines.includes('＋ 在「A2」新增知识点「new」'));
  assert.ok(lines.includes('－ 删除知识点「a2」（退役，作答记录保留）'));
  assert.equal(lines.filter((l) => l.startsWith('↕ 主题')).length, 1, 'swapping two topics is one move, not two');
});

test('3a lessons carry topicId / conceptIds; the knowledge point detail lists the lessons that teach it', () => tmp(async (dir) => {
  const { store, w, rpc, cid, topics, kp } = await course(dir);
  await assert.rejects(w('lesson.create', { courseId: cid, title: 'x', topicId: 'topic-nope', parts: [{ title: 'p', objective: 'o' }] }), /unknown topic id/);
  await assert.rejects(w('lesson.create', { courseId: cid, title: 'x', conceptIds: ['kp-nope'], parts: [{ title: 'p', objective: 'o' }] }), /unknown knowledge point/);
  const l1 = (await w('lesson.create', { courseId: cid, title: '看懂图像', topicId: topics[0].id, parts: [{ title: '开口', objective: '判断开口', conceptIds: [kp[0]] }] })).result;
  assert.equal(l1.topicId, topics[0].id);
  assert.deepEqual(l1.conceptIds, [kp[0]], 'part concepts win over the whole topic');
  const l2 = (await w('lesson.create', { courseId: cid, title: '整个图像主题', topicId: topics[0].id, parts: [{ title: 'p', objective: 'o' }] })).result;
  assert.deepEqual(l2.conceptIds, [kp[0], kp[1]], 'a topic alone means its live knowledge points');
  const d = await store.data('concept', { courseId: cid, conceptId: kp[0] });
  assert.deepEqual(d.lessons.map((l) => [l.title, l.via]), [['看懂图像', 'plan'], ['整个图像主题', 'plan']]);
  const rows = await store.data('knowledgePoints', { courseId: cid });
  assert.equal(rows.find((r) => r.concept_id === kp[0]).lessons, 2);
  assert.equal(rows.find((r) => r.concept_id === kp[2]).lessons, 0);
  // an older lesson without links: still listed through its attempts; lesson.link backfills
  await rpc('lesson.approve', { lessonId: l2.id, planRevision: 1 });
  const q = await store.readOnlyQuery(`SELECT lesson_id, topic_id, concept_ids FROM v_lessons WHERE lesson_id = '${l2.id}'`);
  assert.equal(JSON.parse(q.rows[0].concept_ids).length, 2);
  await w('lesson.link', { lessonId: l1.id, conceptIds: [kp[0], kp[2]] });
  assert.equal((await store.data('concept', { courseId: cid, conceptId: kp[2] })).lessons[0].title, '看懂图像');
  // retiring a taught knowledge point keeps the lesson's reference (evidence kept)
  const o = await store.read();
  await rpc('course.editOutline', { courseId: cid, syllabusRevision: o.courses[cid].syllabus.revision, operations: [{ op: 'removeSubtopic', subtopicId: topics[0].subtopics[1].id }] });
  assert.ok((await store.read()).lessons[l2.id].conceptIds.includes(kp[1]));
  assert.equal((await store.read()).concepts[kp[1]].status, 'retired');
  store.close();
}));

test('3b resume pointer: current lesson, part, open question with attempts and hints survive a new session', () => tmp(async (dir) => {
  const { store, tools, w, cid, kp } = await course(dir);
  const l = (await w('lesson.create', { courseId: cid, title: '顶点式', conceptIds: [kp[1]], parts: [{ title: '形式', objective: '写出顶点式' }, { title: '应用', objective: '读出顶点' }] })).result;
  await w('lesson.approve', { lessonId: l.id, planRevision: 1, consent: '学习者：计划没问题，你批吧' });
  await w('lesson.partWrite', { lessonId: l.id, partIndex: 0, body: 'y=a(x-h)^2+k' });
  const asked = (await w('lesson.ask', { lessonId: l.id, question: 'y=2(x-1)^2+3 的顶点是？', conceptId: kp[1] })).result.pendingQuestion;
  await assert.rejects(w('lesson.ask', { lessonId: l.id, question: '另一题' }), /still waiting/);
  // a wrong answer keeps the question open; a hint is counted
  const r1 = (await w('assessment.record', { lessonId: l.id, conceptId: kp[1], questionId: asked.id, question: asked.question, studentAnswer: '(-1,3)', feedback: '符号反了', score: 0.3, transfer: false })).result;
  assert.equal(r1.assessment.attemptNo, 1); assert.equal(r1.pendingQuestion.attempts, 1);
  await w('lesson.hint', { lessonId: l.id, hint: '看括号里是 x 减几' });
  await w('lesson.checkpoint', { lessonId: l.id, recap: '顶点式 y=a(x-h)^2+k，顶点是 (h,k)；学习者容易把 h 的符号弄反' });
  store.close();
  // "new DSH session": a new process opens the same file and reads
  const again = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: null }); again.open();
  const t2 = Object.fromEntries(toolSpecs(again).map((t) => [t.name, t]));
  const top = await t2.tutor_read.execute({});
  const r = top.resume.find((x) => x.courseId === cid);
  assert.equal(r.lessonId, l.id); assert.equal(r.partIndex, 0); assert.equal(r.phase, 'teaching');
  assert.equal(r.pendingQuestion.question, 'y=2(x-1)^2+3 的顶点是？');
  assert.equal(r.pendingQuestion.attempts, 1); assert.equal(r.pendingQuestion.hintCount, 1); assert.equal(r.pendingQuestion.hintGiven, true);
  assert.match(r.recap.text, /符号弄反/);
  assert.ok(r.links.some((x) => x.kind === 'lesson' && x.href.includes(l.id)));
  // the second answer closes it (same question, hint count carried over)
  const r2 = (await t2.tutor_write.execute({ action: 'assessment.record', payload_json: JSON.stringify({ lessonId: l.id, conceptId: kp[1], question: asked.question, studentAnswer: '(1,3)', feedback: '对', score: 1, transfer: false }) })).result;
  assert.equal(r2.assessment.attemptNo, 2); assert.equal(r2.assessment.hintCount, 1); assert.equal(r2.pendingQuestion, null);
  const v = await again.readOnlyQuery(`SELECT pending_question FROM v_lessons WHERE lesson_id = '${l.id}'`);
  assert.equal(v.rows[0].pending_question, null);
  again.close();
}));

test('3c sourceRefs are {sourceId, locator} of registered sources; old free-text refs are read, not rewritten', () => tmp(async (dir) => {
  const { store, tools, w, cid } = await course(dir);
  const l = (await w('lesson.create', { courseId: cid, title: 'L', parts: [{ title: 'p', objective: 'o' }] })).result;
  await w('lesson.approve', { lessonId: l.id, planRevision: 1, consent: '交给你' });
  await assert.rejects(w('lesson.partWrite', { lessonId: l.id, partIndex: 0, body: 'b', sourceRefs: ['课本第3页'] }), /registered source/);
  await assert.rejects(w('lesson.partWrite', { lessonId: l.id, partIndex: 0, body: 'b', sourceRefs: [{ sourceId: 'source-made-up' }] }), /not a registered source/);
  const pdf = (await w('source.register', { title: '人教版必修一', uri: 'https://example.org/math.pdf', kind: 'file' })).result;
  const vid = (await w('source.register', { title: '讲解视频', uri: 'https://www.youtube.com/watch?v=q1', kind: 'video' })).result;
  const out = await w('lesson.partWrite', { lessonId: l.id, partIndex: 0, body: 'b', sourceRefs: [{ sourceId: pdf.id, locator: 'p.12' }, `${vid.id}@01:30`] });
  assert.deepEqual(out.result.sourceRefs, [{ sourceId: pdf.id, locator: 'p.12', page: 12 }, { sourceId: vid.id, locator: '01:30', seconds: 90 }]);
  assert.deepEqual(out.links.filter((x) => x.kind === 'source').map((x) => x.href), ['https://example.org/math.pdf#page=12', 'https://www.youtube.com/watch?v=q1&t=90s']);
  assert.ok((await store.read()).courses[cid].sourceIds.includes(pdf.id), 'a cited source is linked to the course');
  const refs = await store.readOnlyQuery(`SELECT source_id, page, seconds FROM v_source_refs WHERE lesson_id = '${l.id}' ORDER BY page`);
  assert.equal(refs.rows.length, 2);
  const read = await tools.tutor_read.execute({ courseId: cid });
  assert.equal(read.lessons.find((x) => x.id === l.id).parts[0].sourceRefs[0].markdown, '[人教版必修一 · 第 12 页](https://example.org/math.pdf#page=12)');
  store.close();
  // legacy fixture: free-text refs read fine
  const d2 = await mkdtemp(join(tmpdir(), 'omt-flow-legacy-'));
  try {
    await copyFile(FIXTURE, join(d2, 'state.json'));
    const s2 = new SqliteTutorStore(join(d2, 'tutor.db'), { legacyJsonPath: join(d2, 'state.json') }); s2.open();
    const t2 = Object.fromEntries(toolSpecs(s2).map((t) => [t.name, t]));
    const c = Object.keys((await s2.read()).courses)[0];
    const r = await t2.tutor_read.execute({ courseId: c });
    const legacy = r.notes[0].sourceRefs[0];
    assert.equal(legacy.legacy, true); assert.match(legacy.text, /间隔重复\.txt/);
    s2.close();
  } finally { await rm(d2, { recursive: true, force: true }); }
}));

test('3d notes hang on knowledge points and sit on the board as cards (CAS, links back, arrows are visual only)', () => tmp(async (dir) => {
  const { store, tools, w, rpc, cid, kp } = await course(dir);
  const l = (await w('lesson.create', { courseId: cid, title: 'L', conceptIds: [kp[0]], parts: [{ title: 'p', objective: 'o' }] })).result;
  await rpc('lesson.approve', { lessonId: l.id });
  await assert.rejects(w('note.add', { lessonId: l.id, title: 'n', content: 'c', conceptIds: ['kp-x'] }), /unknown knowledge point/);
  const note = (await w('note.add', { lessonId: l.id, title: '开口方向口诀', content: 'a>0 开口向上', conceptIds: [kp[0]] })).result;
  const seeded = await tools.tutor_board_read.execute({ courseId: cid });
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: seeded.revision, seed: true });
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  await assert.rejects(tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision - 1, operations: [{ op: 'add', type: 'note', noteId: note.id }] }), (e) => e.code === 'conflict');
  const p = await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', noteId: note.id, arrows: true }] });
  const card = p.board.elements.find((e) => e.noteId === note.id);
  assert.equal(card.type, 'note'); assert.equal(card.text, '开口方向口诀'); assert.deepEqual(card.conceptIds, [kp[0]]);
  const conceptCard = p.board.elements.find((e) => e.type === 'concept' && e.conceptId === kp[0]);
  assert.ok(card.x > conceptCard.x, 'placed beside its knowledge point card');
  assert.ok(p.board.elements.some((e) => e.type === 'arrow' && e.from === card.id && e.to === conceptCard.id && e.noteLink));
  assert.ok(p.links.some((x) => x.kind === 'card' && x.id === card.id));
  // no semantic relation was created by the arrow
  assert.equal(Object.keys((await store.read()).relations).length, 0);
  await assert.rejects(tools.tutor_board_patch.execute({ courseId: cid, baseRevision: p.revision, operations: [{ op: 'update', id: card.id, text: '改字' }] }), /edit the note/);
  await assert.rejects(tools.tutor_board_patch.execute({ courseId: cid, baseRevision: p.revision, operations: [{ op: 'add', type: 'note', noteId: note.id }] }), /already on board/);
  // the knowledge point detail joins everything on one conceptId
  await store.todo('create', { courseId: cid, title: '复习开口方向', conceptId: kp[0] }, { actor: 'learner' });
  await w('relation.propose', { from: kp[0], to: kp[1], type: 'prerequisite' });
  const d = await store.data('concept', { courseId: cid, conceptId: kp[0] });
  assert.equal(d.notes[0].title, '开口方向口诀');
  assert.equal(d.note_cards[0].element_id, card.id);
  assert.equal(d.board_cards.length, 1); assert.equal(d.relations.length, 1); assert.equal(d.todos.length, 1);
  assert.equal(d.lessons[0].lesson_id, l.id); assert.ok(d.review);
  // learner links an existing note to another knowledge point from the workbench
  await rpc('note.link', { noteId: note.id, conceptIds: [kp[0], kp[1]] });
  assert.equal((await store.data('concept', { courseId: cid, conceptId: kp[1] })).notes.length, 1);
  store.close();
}));

test('3e outline changes keep a diff + reason; feedback → adjust → approve → continue (AI may approve when asked)', () => tmp(async (dir) => {
  const { store, tools, w, rpc, cid, topics, kp } = await course(dir);
  const l = (await w('lesson.create', { courseId: cid, title: '第一课', topicId: topics[0].id, parts: [{ title: 'p', objective: 'o' }] })).result;
  await w('lesson.approve', { lessonId: l.id, planRevision: 1, consent: '交给你' });
  await w('lesson.partWrite', { lessonId: l.id, partIndex: 0, body: 'b' });
  await w('lesson.cover', { lessonId: l.id, partIndex: 0 });
  await w('lesson.reviewEnd', { lessonId: l.id, skipped: true });
  await w('lesson.finish', { lessonId: l.id, skipNotes: true });
  assert.equal((await store.read()).lessons[l.id].phase, 'feedback_pending');
  await assert.rejects(w('lesson.feedback', { lessonId: l.id, adjustOutline: true, skipped: true }), /needs the learner/);
  await w('lesson.feedback', { lessonId: l.id, feedback: '配方法太难了，想先多练顶点式', adjustOutline: true });
  assert.equal((await store.read()).lessons[l.id].phase, 'plan_adjustment_pending');
  await assert.rejects(w('lesson.adjustDone', { lessonId: l.id }), /has not been changed/);
  const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  await assert.rejects(tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [{ op: 'addSubtopic', topicId: topics[0].id, title: '顶点式练习' }] }), /reason is required/);
  const edit = await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, reason: '学习者反馈配方法太难，先加顶点式练习',
    operations: [{ op: 'addSubtopic', topicId: topics[0].id, title: '顶点式练习' }, { op: 'renameSubtopic', subtopicId: topics[1].subtopics[0].id, title: '配方法（放慢）' }] });
  assert.deepEqual(edit.change.lines, ['✎ 知识点「配方法」改名为「配方法（放慢）」', '＋ 在「图像」新增知识点「顶点式练习」'].sort((a, b) => edit.change.lines.indexOf(a) - edit.change.lines.indexOf(b)));
  assert.equal(edit.change.reason, '学习者反馈配方法太难，先加顶点式练习');
  assert.equal(edit.change.forLessonId, l.id);
  assert.equal(edit.sinceApproved.approvedRevision, o.syllabusRevision);
  assert.equal(edit.sinceApproved.lines.length, 2);
  assert.ok(edit.links.some((x) => x.kind === 'outline'));
  // still a draft: adjustDone waits for the approval
  await assert.rejects(w('lesson.adjustDone', { lessonId: l.id }), (e) => e.code === 'conflict' && /needs approval/.test(e.message));
  await w('course.approve', { courseId: cid, syllabusRevision: edit.outline.syllabusRevision, consent: '学习者：改得好，你直接批' });
  const done = (await w('lesson.adjustDone', { lessonId: l.id, nextPreview: '下一课：顶点式练习 3 题' })).result;
  assert.equal(done.phase, 'complete'); assert.equal(done.nextPreview.text, '下一课：顶点式练习 3 题');
  const read = await tools.tutor_read.execute({ courseId: cid });
  assert.equal(read.resume.nextPreview.text, '下一课：顶点式练习 3 题');
  assert.deepEqual(read.outlineSinceApproved.lines, []);
  const ch = await store.readOnlyQuery(`SELECT from_revision, to_revision, actor, reason FROM v_syllabus_changes WHERE course_id = '${cid}' ORDER BY to_revision`);
  assert.equal(ch.rows.at(-1).reason, '学习者反馈配方法太难，先加顶点式练习');
  // mid-lesson feedback can also ask for an adjustment and returns to teaching; skipping the change is explicit
  const l2 = (await w('lesson.create', { courseId: cid, title: '第二课', conceptIds: [kp[1]], parts: [{ title: 'p', objective: 'o' }] })).result;
  await rpc('lesson.approve', { lessonId: l2.id, planRevision: 1 });
  await w('lesson.feedback', { lessonId: l2.id, feedback: '能不能换个顺序', adjustOutline: true });
  await assert.rejects(w('lesson.partWrite', { lessonId: l2.id, partIndex: 0, body: 'x' }), /current teaching part/);
  const back = (await w('lesson.adjustDone', { lessonId: l2.id, skipped: true })).result;
  assert.equal(back.phase, 'teaching');
  store.close();
}));

test('3e the JSON fallback store runs the same flow (no FSRS / to-dos claimed there)', () => tmp(async (dir) => {
  const store = new JsonTutorStore(join(dir, 'state.json'));
  const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
  assert.ok(!tools.tutor_review_rate && !tools.tutor_todo && !tools.tutor_table_query);
  const w = async (action, payload) => tools.tutor_write.execute({ action, payload_json: JSON.stringify(payload) });
  const g = (await w('goal.create', { title: 'g', expectedOutcome: 'o' })).result;
  const c = (await w('course.create', { goalId: g.id, title: 'c' })).result;
  const plan = (await w('course.plan', { courseId: c.id, syllabusRevision: 0, topics: [{ title: 'T', subtopics: [{ title: 'x' }] }] })).result;
  await w('course.setApproval', { courseId: c.id, mode: 'delegated', consent: '交给你' });
  await w('course.approve', { courseId: c.id, syllabusRevision: plan.syllabus.revision });
  const kp = plan.syllabus.topics[0].subtopics[0].conceptId;
  const l = (await w('lesson.create', { courseId: c.id, title: 'L', conceptIds: [kp], parts: [{ title: 'p', objective: 'o' }] })).result;
  await w('lesson.approve', { lessonId: l.id, planRevision: 1 });
  await w('lesson.ask', { lessonId: l.id, question: 'Q?' });
  const r = await tools.tutor_read.execute({});
  assert.equal(r.resume[0].pendingQuestion.question, 'Q?');
  await assert.rejects(dispatch(store, { method: 'data', payload: { query: 'concept', params: { courseId: c.id, conceptId: kp } } }), /SQLite/);
}));

test('migration v2 → v3: backup (0600) first, dedicated marker, data untouched, new views; fresh databases get the marker too', () => tmp(async (dir) => {
  const path = join(dir, 'tutor.db');
  const st = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_V1);
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', ?), ('stateSchemaVersion', '1'), ('jsonImport', '{\"from\":null}')").run(String(st.revision));
  for (const c of Object.values(st.courses)) db.prepare('INSERT INTO courses (id, goal_id, title, status, syllabus_revision, doc) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, c.goalId, c.title, c.status, c.syllabus.revision, JSON.stringify(c));
  for (const k of Object.values(st.concepts)) db.prepare('INSERT INTO concepts (id, course_id, topic_id, subtopic_id, title, status, mastery, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(k.id, k.courseId, k.topicId, k.subtopicId ?? null, k.title, k.status, k.mastery, JSON.stringify(k));
  for (const l of Object.values(st.lessons)) db.prepare('INSERT INTO lessons (id, course_id, title, status, phase, created_at, doc) VALUES (?, ?, ?, ?, ?, ?, ?)').run(l.id, l.courseId, l.title, l.status, l.phase, l.createdAt, JSON.stringify(l));
  for (const n of Object.values(st.notes)) db.prepare('INSERT INTO notes (id, course_id, lesson_id, author, created_at, doc) VALUES (?, ?, ?, ?, ?, ?)').run(n.id, n.courseId, n.lessonId, n.author, n.createdAt, JSON.stringify(n));
  for (const a of Object.values(st.assessments)) db.prepare('INSERT INTO assessments (id, lesson_id, concept_id, score, recorded_at, doc) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, a.lessonId, a.conceptId, a.score, a.recordedAt, JSON.stringify(a));
  for (const s of Object.values(st.sources)) db.prepare('INSERT INTO sources (id, kind, title, doc) VALUES (?, ?, ?, ?)').run(s.id, s.kind, s.title, JSON.stringify(s));
  db.exec(MIGRATIONS[2]);
  db.exec('PRAGMA application_id = 1330467924; PRAGMA user_version = 2');
  db.close();
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o600);
  const store = new SqliteTutorStore(path, { legacyJsonPath: null });
  store.open();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, DB_VERSION);
  assert.equal(DB_VERSION, 3);
  assert.ok(store.backup && store.backup.includes('.bak-v2-'));
  assert.equal((await stat(store.backup)).mode & 0o777, 0o600, 'backup is owner-only');
  const bak = new DatabaseSync(store.backup, { readOnly: true });
  assert.equal(bak.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(bak.prepare('SELECT count(*) AS n FROM lessons').get().n, Object.keys(st.lessons).length);
  bak.close();
  const marker = JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key = 'migration.v3.learningFlow'").get().value);
  assert.equal(marker.from, 2); assert.equal(marker.backup, store.backup);
  const state = await store.read();
  assert.equal(state.revision, st.revision);
  assert.deepEqual(Object.values(state.lessons)[0].parts.map((p) => p.sourceRefs), Object.values(st.lessons)[0].parts.map((p) => p.sourceRefs), 'old docs untouched');
  const kps = await store.data('knowledgePoints', { courseId: Object.keys(st.courses)[0] });
  assert.ok(kps.every((r) => r.lessons === 0), 'old lessons have no links (not guessed from attempts)');
  const lessonView = await store.readOnlyQuery('SELECT lesson_id, concept_ids, topic_id FROM v_lessons');
  assert.equal(lessonView.rows[0].concept_ids, '[]');
  const detail = await store.data('concept', { courseId: Object.keys(st.courses)[0], conceptId: Object.values(st.assessments)[0].conceptId });
  assert.equal(detail.lessons[0].via, 'attempt', 'an old lesson still shows up through its attempts');
  store.close();
  // reopening does not back up or migrate again
  const again = new SqliteTutorStore(path, { legacyJsonPath: null }); again.open();
  assert.equal(again.backup, null); again.close();
  // a fresh database: created at v1, walked to v3, marker says fresh, no backup
  const fresh = new SqliteTutorStore(join(dir, 'fresh.db'), { legacyJsonPath: null }); fresh.open();
  assert.equal(JSON.parse(fresh.db.prepare("SELECT value FROM meta WHERE key = 'migration.v3.learningFlow'").get().value).fresh, true);
  assert.equal(fresh.backup, null); fresh.close();
}));

test('RPC failures carry error.details (planRevision on a stale lesson approval)', () => tmp(async (dir) => {
  const { store, w, cid } = await course(dir);
  const { createRpcHandler, ENDPOINT } = await import('../src/rpc.mjs');
  const l = (await w('lesson.create', { courseId: cid, title: 'L', parts: [{ title: 'p', objective: 'o' }] })).result;
  await w('lesson.updatePlan', { lessonId: l.id, planRevision: 1, title: 'L2' });
  const handler = createRpcHandler(store);
  const res = await handler(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: ENDPOINT, payload: { method: 'mutate', payload: { action: 'lesson.approve', input: { lessonId: l.id, planRevision: 1 } } } }) }));
  const msg = await res.json();
  assert.equal(msg.result.ok, false); assert.equal(msg.result.error.code, 'tutor/conflict'); assert.equal(msg.result.error.details.planRevision, 2);
  const res2 = await handler(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: ENDPOINT, payload: { method: 'mutate', payload: { action: 'lesson.ask', input: {} } } }) }));
  const m2 = await res2.json();
  assert.equal(m2.result.ok, false); assert.deepEqual(m2.result.error.details, {}, 'even a refused action keeps a details object');
  store.close();
}));
