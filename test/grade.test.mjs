// Objective (choice / multi / fill) questions are graded by the store against a key frozen at lesson.ask;
// short answers stay model-graded and provisional. The key never reaches a learner-facing surface while open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteTutorStore } from '../src/sqlite-store.mjs';
import { toolSpecs } from '../src/tools.mjs';
import { dispatch } from '../src/rpc.mjs';
import { questionSpec, gradeAnswer, parseNumber, expectedAnswer } from '../src/grade.mjs';

async function tmp(fn) { const dir = await mkdtemp(join(tmpdir(), 'omt-grade-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }

/** An approved course with one teaching lesson, through the model-facing tools. */
async function lesson(dir) {
  const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: null });
  store.open();
  const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
  const w = async (action, payload) => tools.tutor_write.execute({ action, payload_json: JSON.stringify(payload) });
  const goal = (await w('goal.create', { title: '绝对值', expectedOutcome: '会用几何意义求绝对值' })).result;
  const c = (await w('course.create', { goalId: goal.id, title: '绝对值入门' })).result;
  const plan = (await w('course.plan', { courseId: c.id, syllabusRevision: 0, topics: [{ title: '定义', subtopics: [{ title: '几何意义' }] }] })).result;
  await dispatch(store, { method: 'mutate', payload: { action: 'course.approve', input: { courseId: c.id, syllabusRevision: plan.syllabus.revision } } });
  const kp = (await store.read()).courses[c.id].syllabus.topics[0].subtopics[0].conceptId;
  const l = (await w('lesson.create', { courseId: c.id, title: '绝对值', conceptIds: [kp], parts: [{ title: '定义', objective: '说出几何意义' }] })).result;
  await w('lesson.approve', { lessonId: l.id, planRevision: 1, consent: '学习者：你批吧' });
  await w('lesson.partWrite', { lessonId: l.id, partIndex: 0, body: '|a| 是数轴上 a 到原点的距离' });
  const ask = async (p) => (await w('lesson.ask', { lessonId: l.id, conceptId: kp, replace: true, ...p })).result.pendingQuestion;
  const record = async (q, studentAnswer, extra = {}) => (await w('assessment.record', { lessonId: l.id, conceptId: kp, questionId: q.id, question: q.question, studentAnswer, transfer: false, ...extra })).result;
  return { store, tools, w, ask, record, lessonId: l.id, courseId: c.id, kp };
}
const OPTS = [{ id: 'A', text: '到原点的距离' }, { id: 'B', text: '相反数' }, { id: 'C', text: '倒数' }];
const noKey = (v) => { const s = JSON.stringify(v); assert.ok(!/answerKey|"correct"|"accepted"/.test(s), `leaked a key: ${s.slice(0, 300)}`); };

test('lesson.ask: objective types need a valid key (and options); omitted type is short', () => tmp(async (dir) => {
  const { store, w, lessonId, ask } = await lesson(dir);
  const bad = (p, re) => assert.rejects(w('lesson.ask', { lessonId, question: '|−3| 等于多少？', replace: true, ...p }), re);
  await bad({ type: 'choice', options: OPTS }, /answerKey/);
  await bad({ type: 'choice', answerKey: { correct: 'A' } }, /options/);
  await bad({ type: 'choice', options: OPTS, answerKey: { correct: 'D' } }, /not one of the option ids/);
  await bad({ type: 'choice', options: [{ id: 'A', text: 'x' }, { id: 'A', text: 'y' }], answerKey: { correct: 'A' } }, /Duplicate option id/);
  await bad({ type: 'choice', options: [{ id: 'A', text: 'x', correct: true }, { id: 'B', text: 'y' }], answerKey: { correct: 'A' } }, /unknown field/);
  await bad({ type: 'multi', options: OPTS, answerKey: { correct: [] } }, /non-empty/);
  await bad({ type: 'multi', options: OPTS, answerKey: { correct: ['A', 'Z'] } }, /not one of the option ids/);
  await bad({ type: 'fill' }, /answerKey/);
  await bad({ type: 'fill', answerKey: { accepted: [] } }, /non-empty/);
  await bad({ type: 'fill', answerKey: { accepted: ['three'], match: 'numeric' } }, /not a number/);
  await bad({ type: 'fill', answerKey: { accepted: ['3'], match: 'fuzzy' } }, /match must be/);
  await bad({ type: 'short', answerKey: { accepted: ['3'] } }, /no answerKey/);
  await bad({ type: 'essay' }, /type must be one of/);
  const q = await ask({ question: '说说绝对值的几何意义' });
  assert.equal(q.type, 'short'); assert.equal(q.hasAnswerKey, undefined);
  assert.equal((await store.read()).lessons[lessonId].pendingQuestion.type, 'short');
  store.close();
}));

test('choice: the store grades id / option text / 选A against the frozen key and ignores the model score', () => tmp(async (dir) => {
  const { store, ask, record, lessonId } = await lesson(dir);
  for (const answer of ['A', '到原点的距离', '选A', 'a.']) {
    const q = await ask({ question: '|a| 的几何意义是？', type: 'choice', options: OPTS, answerKey: { correct: 'A' } });
    noKey(q); assert.equal(q.hasAnswerKey, true); assert.deepEqual(q.options, OPTS);
    const r = await record(q, answer, { score: 0, feedback: '模型以为错了' });
    assert.equal(r.assessment.score, 1, answer); assert.equal(r.assessment.judgedBy, 'answer-key'); assert.equal(r.assessment.type, 'choice');
    assert.equal(r.official.score, 1); assert.equal(r.official.expectedAnswer, 'A. 到原点的距离');
    assert.equal(r.assessment.grading.ignoredModelScore, 0);
    assert.equal(r.pendingQuestion, null, 'a right answer closes the question');
  }
  const q = await ask({ question: '|a| 的几何意义是？', type: 'choice', options: OPTS, answerKey: { correct: 'A' } });
  const wrong = await record(q, 'B', { score: 1, feedback: '模型以为对了' });
  assert.equal(wrong.assessment.score, 0); assert.equal(wrong.assessment.judgedBy, 'answer-key');
  // still open → key withheld from the result, the pending question, and the read model
  assert.equal(wrong.official.expectedAnswer, null); noKey(wrong);
  assert.equal(wrong.pendingQuestion.id, q.id);
  // the stored official score is what FSRS sees (rated "again", not the model's 1)
  const logs = await store.readOnlyQuery(`SELECT rating, assessment_id FROM v_review_logs WHERE assessment_id = '${wrong.assessment.id}'`);
  assert.equal(logs.rows[0]?.rating, 1);
  const s = (await store.read()).assessments[wrong.assessment.id];
  assert.equal(s.score, 0); assert.deepEqual(s.answerKey, { correct: 'A' }, 'the key is kept server-side for audit');
  // closing it reveals the expected answer
  const closed = await record(q, 'C', { close: true });
  assert.equal(closed.official.expectedAnswer, 'A. 到原点的距离'); assert.equal(closed.pendingQuestion, null);
  assert.equal((await store.read()).lessons[lessonId].pendingQuestion, null);
  store.close();
}));

test('multi: all-or-nothing, order-insensitive', () => tmp(async (dir) => {
  const { store, ask, record } = await lesson(dir);
  const opts = [{ id: 'A', text: '|3| = 3' }, { id: 'B', text: '|-3| = -3' }, { id: 'C', text: '|0| = 0' }, { id: 'D', text: '|a| < 0' }];
  const cases = [['A,C', 1], ['C A', 1], ['A和C', 1], ['ca', 1], ['A', 0], ['A,B,C', 0], ['B,D', 0]];
  for (const [answer, score] of cases) {
    const q = await ask({ question: '哪些是对的？', type: 'multi', options: opts, answerKey: { correct: ['C', 'A'] } });
    const r = await record(q, answer, { score: 1 - score, close: true });
    assert.equal(r.assessment.score, score, answer); assert.equal(r.assessment.judgedBy, 'answer-key');
    assert.deepEqual(r.assessment.answerKey, { correct: ['A', 'C'] });
  }
  store.close();
}));

test('fill: normalized (case, whitespace, several accepted), numeric (5 = 5.0), exact (case-sensitive)', () => tmp(async (dir) => {
  const { store, ask, record } = await lesson(dir);
  const fill = async (answerKey, answer) => { const q = await ask({ question: '填空', type: 'fill', answerKey }); noKey(q); return (await record(q, answer, { score: 0.5, close: true })).assessment; };
  assert.equal((await fill({ accepted: ['Distance'] }, '  distance ')).score, 1);
  assert.equal((await fill({ accepted: ['到 原点 的 距离'] }, '到   原点  的距离')).score, 0);
  assert.equal((await fill({ accepted: ['到 原点 的 距离'] }, '到   原点  的 距离')).score, 1);
  assert.equal((await fill({ accepted: ['5', '-5'] }, '-5')).score, 1);
  assert.equal((await fill({ accepted: ['5', '-5'] }, '6')).score, 0);
  const n = await fill({ accepted: ['5'], match: 'numeric' }, '5.0');
  assert.equal(n.score, 1); assert.equal(n.judgedBy, 'answer-key'); assert.equal(n.expectedAnswer, '5');
  assert.equal((await fill({ accepted: ['0.5'], match: 'numeric' }, '1/2')).score, 1);
  assert.equal((await fill({ accepted: ['5'], match: 'numeric' }, 'five')).score, 0);
  assert.equal((await fill({ accepted: ['Paris'], match: 'exact' }, ' Paris ')).score, 1);
  assert.equal((await fill({ accepted: ['Paris'], match: 'exact' }, 'paris')).score, 0);
  store.close();
}));

test('short: the model score is kept, judgedBy model-unverified', () => tmp(async (dir) => {
  const { store, ask, record } = await lesson(dir);
  const q = await ask({ question: '为什么 |a| ≥ 0？', type: 'short' });
  const r = await record(q, '因为距离不会是负的', { score: 0.85, feedback: '对，可再说说 a=0' });
  assert.equal(r.assessment.score, 0.85); assert.equal(r.assessment.judgedBy, 'model-unverified'); assert.equal(r.assessment.type, 'short');
  assert.equal(r.official.score, 0.85); assert.equal(r.official.expectedAnswer, undefined);
  const q2 = await ask({ question: '再说一个例子' });
  await assert.rejects(record(q2, '…', { feedback: 'x' }), /score must be between 0 and 1/);
  store.close();
}));

test('no key leaks while a question is open: tool results, tutor_read resume/lessons, workbench RPC, data views', () => tmp(async (dir) => {
  const { store, tools, w, ask, record, lessonId, courseId } = await lesson(dir);
  const q = await ask({ question: '|−3| = ?', type: 'fill', answerKey: { accepted: ['3'], match: 'numeric' } });
  noKey(q); assert.equal(q.hasAnswerKey, true); assert.equal(q.type, 'fill');
  noKey((await w('lesson.hint', { lessonId, hint: '想想距离' })).result);
  const wrong = await record(q, '-3', { score: 1 });
  assert.equal(wrong.assessment.score, 0); noKey(wrong);
  const read = await tools.tutor_read.execute({ courseId });
  noKey(read); assert.equal(read.resume.pendingQuestion.type, 'fill'); assert.equal(read.resume.pendingQuestion.hasAnswerKey, true);
  assert.equal(read.assessments[0].keyWithheld, true);
  noKey(await tools.tutor_read.execute({}));
  noKey(await dispatch(store, { method: 'workbench', payload: { courseId } }));
  const att = await store.data('attempts', { courseId });
  assert.equal(att[0].expected_answer, null); assert.equal(att[0].question_type, 'fill'); assert.equal(att[0].judged_by, 'answer-key');
  noKey(await store.data('lessons', { courseId }));
  // answered → the result, the workbench and the data panel may show the expected answer
  const right = await record(q, '3');
  assert.equal(right.official.score, 1); assert.equal(right.official.expectedAnswer, '3'); assert.equal(right.assessment.expectedAnswer, '3');
  const after = await store.data('attempts', { courseId });
  assert.ok(after.every((r) => r.expected_answer === '3'), 'both attempts show the key once the question is closed');
  const wb = await dispatch(store, { method: 'workbench', payload: { courseId } });
  assert.ok(wb.assessments.every((a) => a.answerKey?.accepted?.[0] === '3'));
  // dropping an open keyed question returns its expected answer to explain
  const q2 = await ask({ question: '选一个', type: 'choice', options: OPTS, answerKey: { correct: 'A' } });
  const dropped = (await w('lesson.dropQuestion', { lessonId })).result;
  assert.equal(dropped.droppedQuestion.id, q2.id); assert.equal(dropped.droppedQuestion.expectedAnswer, 'A. 到原点的距离');
  store.close();
}));

test('grade module: numbers, expected answers, choice parsing stays strict on ambiguity', () => {
  assert.equal(parseNumber('5.00'), 5); assert.equal(parseNumber('１/４'), 0.25); assert.equal(parseNumber('−2'), -2); assert.equal(parseNumber('1/0'), null); assert.equal(parseNumber('abc'), null);
  const c = questionSpec({ type: 'choice', options: OPTS, answerKey: { correct: 'b' } });
  assert.deepEqual(c.answerKey, { correct: 'B' }, 'option id is canonicalised');
  assert.equal(gradeAnswer(c, 'A和B').score, 0);
  assert.equal(gradeAnswer(c, 'B. 相反数').score, 1);
  assert.equal(gradeAnswer(c, 'B. 倒数').score, 0, 'id and text must agree');
  assert.deepEqual(expectedAnswer(questionSpec({ type: 'fill', answerKey: { accepted: ['3', '三'] } })), { accepted: ['3', '三'], match: 'normalized', text: '3 / 三' });
  assert.equal(questionSpec({}).type, 'short');
});
