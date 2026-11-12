// FSRS review cards: algorithm, learner rating, attempt-driven rescheduling, v1 → v2 migration, CAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createEmptyCard, Rating, State } from 'ts-fsrs';
import { SqliteTutorStore, DB_VERSION, SCHEMA_V1 } from '../src/sqlite-store.mjs';
import { review, preview, replay, spreadOverdue, ratingFromAttempt, cardFromRow, rowFromCard } from '../src/review.mjs';
import { toolSpecs } from '../src/tools.mjs';
import { dispatch } from '../src/rpc.mjs';

const FIXTURE = new URL('./fixtures/spaced-repetition.state.json', import.meta.url);
async function tmp(fn) { const dir = await mkdtemp(join(tmpdir(), 'omt-review-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
let clock = '2026-11-12T16:00:00.000Z';
const now = () => clock;
async function migrated(dir) {
  const json = join(dir, 'state.json');
  await copyFile(FIXTURE, json);
  const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: json, now });
  store.open();
  return store;
}
const DAY = 86400000;
async function buildV1(path) {
  const st = JSON.parse(await readFile(FIXTURE, 'utf8'));
  // build a real version-1 file (what 8f72f86 wrote): SCHEMA_V1 + rows + markers
  const db = new DatabaseSync(path);
  db.exec(SCHEMA_V1);
  db.prepare("INSERT INTO meta (key, value) VALUES ('revision', ?), ('stateSchemaVersion', '1'), ('jsonImport', '{\"from\":null}')").run(String(st.revision));
  for (const c of Object.values(st.courses)) db.prepare('INSERT INTO courses (id, goal_id, title, status, syllabus_revision, doc) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, c.goalId, c.title, c.status, c.syllabus.revision, JSON.stringify(c));
  for (const k of Object.values(st.concepts)) db.prepare('INSERT INTO concepts (id, course_id, topic_id, subtopic_id, title, status, mastery, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(k.id, k.courseId, k.topicId, k.subtopicId ?? null, k.title, k.status, k.mastery, JSON.stringify(k));
  for (const a of Object.values(st.assessments)) db.prepare('INSERT INTO assessments (id, lesson_id, concept_id, score, recorded_at, doc) VALUES (?, ?, ?, ?, ?, ?)').run(a.id, a.lessonId, a.conceptId, a.score, a.recordedAt, JSON.stringify(a));
  db.prepare("INSERT INTO todos (id, course_id, title, created_at, updated_at) VALUES ('todo-1', ?, '旧待办', 'x', 'x')").run(Object.keys(st.courses)[0]);
  db.exec('PRAGMA application_id = 1330467924; PRAGMA user_version = 1');
  db.close();
  return st;
}

test('algorithm: ts-fsrs day-level schedule; better recall → later due; preview matches next()', () => {
  const at = new Date('2026-11-01T12:00:00Z');
  const c = createEmptyCard(at);
  const dues = [1, 2, 3, 4].map((r) => review(c, r, at).card.due.getTime());
  for (let i = 1; i < 4; i++) assert.ok(dues[i] > dues[i - 1], 'Again < Hard < Good < Easy');
  assert.ok(dues[0] - at.getTime() >= DAY, 'no minute-level learning steps');
  const p = preview(c, at);
  assert.equal(p[3].due, new Date(dues[2]).toISOString());
  const good = review(c, Rating.Good, at).card;
  assert.equal(good.state, State.Review);
  const again = review(good, Rating.Again, new Date(good.due)).card;
  assert.equal(again.lapses, 1);
  // DB row round trip keeps the schedule
  const row = rowFromCard(good);
  assert.equal(cardFromRow({ ...row, created_at: at.toISOString() }).due.toISOString(), good.due.toISOString());
  assert.equal(ratingFromAttempt({ score: 0.2 }), Rating.Again);
  assert.equal(ratingFromAttempt({ score: 0.95 }), Rating.Easy);
  assert.equal(ratingFromAttempt({ score: 0.95, hintCount: 1 }), Rating.Good, 'a hint lowers one grade');
});

test('replay + spread: evidence replays in time order; old overdue cards are spread (<= 3 per day), not all today', () => {
  const t0 = new Date('2026-01-01T12:00:00Z');
  const r = replay([{ score: 0.8, recorded_at: '2026-01-05T12:00:00Z' }, { score: 0.3, recorded_at: '2026-01-02T12:00:00Z' }], {});
  assert.equal(r.logs.length, 2); assert.equal(r.logs[0].rating, Rating.Again, 'sorted by time');
  assert.equal(replay([], { mastery: 'unverified' }), null);
  assert.equal(replay([], { mastery: 'developing', createdAt: t0 }).source, 'mastery');
  const now = new Date('2026-06-01T12:00:00Z');
  const cards = Array.from({ length: 7 }, (_, i) => ({ card: { due: new Date(t0.getTime() + i * DAY) } }));
  spreadOverdue(cards, now, 3);
  const perDay = {}; for (const c of cards) { const d = Math.round((c.card.due - now) / DAY); perDay[d] = (perDay[d] ?? 0) + 1; }
  assert.deepEqual(perDay, { 0: 3, 1: 3, 2: 1 });
});

test('store: every knowledge point gets one card; evidence-based cards are scheduled, the rest are new', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const course = Object.values((await store.read()).courses)[0];
  const cards = await store.data('reviews', { courseId: course.id });
  const kps = await store.data('knowledgePoints', { courseId: course.id });
  assert.equal(cards.length, kps.length);
  assert.equal(new Set(cards.map((c) => c.concept_id)).size, cards.length, 'one card per knowledge point');
  const st = await store.read();
  const withAttempts = new Set(Object.values(st.assessments).map((a) => a.conceptId));
  const withMastery = new Set(Object.values(st.concepts).filter((c) => c.mastery !== 'unverified').map((c) => c.id));
  for (const c of cards) {
    if (withAttempts.has(c.concept_id)) { assert.equal(c.source, 'attempts'); assert.ok(c.due_at); }
    else if (withMastery.has(c.concept_id)) assert.equal(c.source, 'mastery');
    else { assert.equal(c.state, 'new'); assert.equal(c.due_at, null); }
  }
  const kp = kps.find((k) => withAttempts.has(k.concept_id));
  assert.ok(kp.next_review_at, 'the knowledge point table shows the next review');
  store.close();
}));

test('learner rating: due moves per FSRS, card revision +1, review.rate event with actor learner, log row', () => tmp(async (dir) => {
  clock = '2026-11-12T16:00:00.000Z';
  const store = await migrated(dir);
  const course = Object.values((await store.read()).courses)[0];
  const card = (await store.data('reviews', { courseId: course.id })).find((c) => c.source === 'attempts');
  const rev0 = (await store.head()).revision;
  const out = await dispatch(store, { method: 'review', payload: { input: { conceptId: card.concept_id, rating: 3, baseRevision: card.revision } } });
  assert.equal(out.card.revision, card.revision + 1);
  assert.notEqual(out.card.due_at, card.due_at);
  assert.ok(Date.parse(out.card.due_at) > Date.parse(clock));
  assert.equal(out.revision, rev0 + 1);
  const ev = (await store.read()).events.at(-1);
  assert.equal(ev.action, 'review.rate'); assert.equal(ev.actor, 'learner'); assert.match(ev.summary, /想起来了/);
  const detail = await store.data('concept', { courseId: course.id, conceptId: card.concept_id });
  assert.equal(detail.review.logs[0].actor, 'learner'); assert.equal(detail.review.logs[0].rating, 3);
  assert.equal(detail.review.card.due_at, out.card.due_at);
  // Again on the same card schedules earlier than Easy would have
  assert.ok(Date.parse(detail.review.preview[1].due) < Date.parse(detail.review.preview[4].due));
  store.close();
}));

test('CAS: a stale rating is a conflict and does not overwrite the schedule; RPC reports reviewRevision', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const course = Object.values((await store.read()).courses)[0];
  const card = (await store.data('reviews', { courseId: course.id })).find((c) => c.source === 'attempts');
  const other = new SqliteTutorStore(store.path, { legacyJsonPath: null, now });
  await other.review({ conceptId: card.concept_id, rating: 4, baseRevision: card.revision }, { actor: 'ai' });
  const after = (await store.data('reviews', { courseId: course.id })).find((c) => c.id === card.id);
  await assert.rejects(store.review({ conceptId: card.concept_id, rating: 1, baseRevision: card.revision }), (e) => e.code === 'conflict' && e.reviewRevision === after.revision);
  const still = (await store.data('reviews', { courseId: course.id })).find((c) => c.id === card.id);
  assert.equal(still.due_at, after.due_at); assert.equal(still.revision, after.revision);
  await assert.rejects(store.review({ conceptId: card.concept_id, rating: 3 }), /baseRevision/);
  await assert.rejects(store.review({ conceptId: card.concept_id, rating: 7, baseRevision: after.revision }), /rating/);
  other.close(); store.close();
}));

test('a newly recorded attempt reschedules its card in the same transaction; a new knowledge point gets a new card', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const st = await store.read();
  const course = Object.values(st.courses)[0];
  const card = (await store.data('reviews', { courseId: course.id })).find((c) => c.state === 'new');
  // a fresh one-part lesson so assessment.record is allowed (phase review_pending)
  const m = (action, input, actor = 'ai') => store.mutate(action, input, undefined, { actor });
  const lesson = (await m('lesson.create', { courseId: course.id, title: '复习测试课', parts: [{ title: '回顾', objective: '复述' }] })).result;
  await m('lesson.approve', { lessonId: lesson.id }, 'learner');
  await m('lesson.partWrite', { lessonId: lesson.id, partIndex: 0, body: '回顾内容' });
  await m('lesson.cover', { lessonId: lesson.id, partIndex: 0 });
  await m('assessment.record', { lessonId: lesson.id, conceptId: card.concept_id, question: '复述一下', studentAnswer: '真实回答', feedback: '好', score: 0.85, transfer: false, hintCount: 0 });
  const after = (await store.data('reviews', { courseId: course.id })).find((c) => c.id === card.id);
  assert.equal(after.state, 'review'); assert.ok(after.due_at); assert.equal(after.revision, card.revision + 1);
  const logs = (await store.data('concept', { courseId: course.id, conceptId: card.concept_id })).review.logs;
  assert.equal(logs.length, 1, 'rated exactly once'); assert.equal(logs[0].actor, 'ai'); assert.ok(logs[0].assessment_id);
  const st2 = await store.read();
  const course2 = Object.values(st2.courses)[0];
  const out = await store.mutate('course.editOutline', { courseId: course.id, syllabusRevision: course2.syllabus.revision,
    operations: [{ op: 'addSubtopic', topicId: course2.syllabus.topics[0].id, title: '新知识点（复习测试）' }] }, undefined, { actor: 'learner' });
  assert.ok(out.revision > st2.revision);
  const kp = (await store.data('knowledgePoints', { courseId: course.id })).find((k) => k.title === '新知识点（复习测试）');
  assert.equal(kp.review_state, 'new'); assert.equal(kp.next_review_at, null);
  store.close();
}));

test('migration v1 → v2: an existing version-1 tutor.db keeps its data, gains review cards initialised from its attempts', () => tmp(async (dir) => {
  const path = join(dir, 'tutor.db');
  const st = await buildV1(path);
  clock = '2026-12-31T16:00:00.000Z'; // long after the fixture attempts: their cards come out overdue
  const store = new SqliteTutorStore(path, { legacyJsonPath: null, now });
  store.open();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, DB_VERSION);
  assert.equal(JSON.parse(store.db.prepare("SELECT value FROM meta WHERE key = 'dbMigrations'").get().value).from, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM todos').get().n, 1, 'existing rows kept');
  assert.equal((await store.read()).revision, st.revision);
  const cards = store.db.prepare('SELECT * FROM review_cards').all();
  assert.equal(cards.length, Object.values(st.concepts).filter((c) => c.status === 'active').length);
  const scheduled = cards.filter((c) => c.state !== 'new');
  assert.ok(scheduled.length >= 2);
  const today = scheduled.filter((c) => Date.parse(c.due_at) < Date.parse(clock) + DAY).length;
  assert.ok(today <= 3, `at most 3 initial reviews land on the first day (got ${today})`);
  assert.equal(store.reviewInit.created, cards.length);
  store.close();
  // opening again neither re-migrates nor re-creates cards
  const again = new SqliteTutorStore(path, { legacyJsonPath: null, now }); again.open();
  assert.equal(again.reviewInit.created, 0);
  assert.equal(again.db.prepare('SELECT count(*) AS n FROM review_cards').get().n, cards.length);
  again.close();
  clock = '2026-11-12T16:00:00.000Z';
}));

test('tool tutor_review_rate: needs evidence + baseRevision, logs actor ai; read-only query sees v_review_cards', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
  const q = await tools.tutor_table_query.execute({ sql: "SELECT concept_id, revision, due_at FROM v_review_cards WHERE state != 'new'" });
  const row = q.rows[0];
  await assert.rejects(() => tools.tutor_review_rate.execute({ conceptId: row.concept_id, rating: 3, baseRevision: row.revision, evidence: '' }), /evidence/);
  const out = await tools.tutor_review_rate.execute({ conceptId: row.concept_id, rating: 3, baseRevision: row.revision, evidence: '学习者正确复述了定义' });
  assert.equal(out.card.revision, row.revision + 1);
  const ev = (await store.read()).events.at(-1);
  assert.equal(ev.actor, 'ai'); assert.match(ev.summary, /依据：学习者正确复述了定义/);
  await assert.rejects(() => tools.tutor_review_rate.execute({ conceptId: row.concept_id, rating: 3, baseRevision: row.revision, evidence: '再评一次' }), (e) => e.code === 'conflict');
  await assert.rejects(() => tools.tutor_table_query.execute({ sql: 'SELECT * FROM review_cards' }));
  store.close();
}));

test('scripts/migrate-db.mjs: backs up a version-1 file (VACUUM INTO) and upgrades it; idempotent', () => tmp(async (dir) => {
  const { execFileSync } = await import('node:child_process');
  const path = join(dir, 'tutor.db');
  await buildV1(path);
  const run = () => JSON.parse(execFileSync(process.execPath, [new URL('../scripts/migrate-db.mjs', import.meta.url).pathname, '--db', path], { encoding: 'utf8' }));
  const out = run();
  assert.equal(out.from, 1); assert.equal(out.to, DB_VERSION); assert.ok(out.backup);
  const bak = new DatabaseSync(out.backup, { readOnly: true });
  assert.equal(bak.prepare('PRAGMA user_version').get().user_version, 1, 'backup is the untouched v1 file');
  assert.equal(bak.prepare('SELECT count(*) AS n FROM todos').get().n, 1);
  bak.close();
  assert.match(out.reviewCards, /new=\d+/); assert.ok(out.reviewInit.created > 0);
  const again = run();
  assert.equal(again.from, DB_VERSION); assert.equal(again.backup, null);
}));
