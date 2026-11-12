// SQLite store: one-time JSON migration, CAS, cross-connection safety, to-dos, data-panel link queries, read-only SQL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteTutorStore, DB_VERSION } from '../src/sqlite-store.mjs';
import { JsonTutorStore } from '../src/store.mjs';
import { dispatch } from '../src/rpc.mjs';
import { toolSpecs } from '../src/tools.mjs';

const FIXTURE = new URL('./fixtures/spaced-repetition.state.json', import.meta.url);
async function tmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omt-sqlite-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function migrated(dir) {
  const json = join(dir, 'state.json');
  await copyFile(FIXTURE, json);
  const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: json });
  store.open();
  return store;
}

test('empty database: fresh schema, revision 0, versioned, owner-only file, marker says nothing imported', () => tmp(async (dir) => {
  const store = new SqliteTutorStore(join(dir, 'nested', 'tutor.db'), { legacyJsonPath: join(dir, 'nested', 'state.json') });
  const s = await store.read();
  assert.equal(s.revision, 0);
  assert.deepEqual(Object.keys(s.courses), []);
  assert.equal(store.migration.imported, false);
  assert.equal(store.migration.marker.from, null);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, DB_VERSION);
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal((await stat(join(dir, 'nested', 'tutor.db'))).mode & 0o777, 0o600);
  const r = await store.mutate('goal.create', { title: 'G', expectedOutcome: 'O' }, 0, { actor: 'learner' });
  assert.equal(r.revision, 1);
  assert.deepEqual(await store.head(), { revision: 1 });
  store.close();
}));

test('legacy JSON is imported once: identical state, counts match, old file renamed and kept', () => tmp(async (dir) => {
  const original = JSON.parse(await readFile(FIXTURE, 'utf8'));
  const store = await migrated(dir);
  assert.equal(store.migration.imported, true);
  const m = store.migration.marker;
  assert.equal(m.revision, original.revision);
  for (const k of ['goals', 'courses', 'concepts', 'lessons', 'relations', 'notes', 'assessments', 'sources'])
    assert.equal(m.counts[k], Object.keys(original[k]).length, k);
  assert.equal(m.counts.events, original.events.length);
  assert.deepEqual(await store.read(), { ...original, boards: {} }, 'the imported state reads back exactly');
  // the old file is kept, renamed
  assert.equal(existsSync(join(dir, 'state.json')), false);
  const kept = (await readdir(dir)).filter((f) => f.startsWith('state.json.migrated-'));
  assert.equal(kept.length, 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, kept[0]), 'utf8')), original, 'kept file is untouched');
  store.close();
}));

test('restart does not import again, even if a state.json shows up later; marker comes from the db, not the file', () => tmp(async (dir) => {
  const first = await migrated(dir);
  await first.mutate('note.add', { lessonId: Object.keys((await first.read()).lessons)[0], title: 'n', content: 'after migration' }, undefined, { actor: 'learner' });
  const rev = (await first.head()).revision;
  first.close();
  await copyFile(FIXTURE, join(dir, 'state.json')); // stale copy reappears (e.g. restored backup)
  const again = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: join(dir, 'state.json') });
  assert.equal((await again.head()).revision, rev, 'no re-import, no rollback to the JSON revision');
  assert.equal(again.migration.imported, false);
  assert.ok(existsSync(join(dir, 'state.json')), 'the reappeared file is left alone');
  again.close();
}));

test('corrupt legacy JSON: open fails, nothing is marked, the file stays', () => tmp(async (dir) => {
  await writeFile(join(dir, 'state.json'), '{"schemaVersion":1,"revision":');
  const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: join(dir, 'state.json') });
  assert.throws(() => store.open());
  assert.ok(existsSync(join(dir, 'state.json')));
  const probe = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: null });
  probe.open();
  assert.ok(probe.db.prepare("SELECT value FROM meta WHERE key = 'jsonImport'").get(), 'with no legacy path configured the empty marker is written');
  probe.close();
}));

test('CAS: stale expectedRevision and stale board/syllabus revisions are rejected, across two connections too', () => tmp(async (dir) => {
  const a = await migrated(dir);
  const b = new SqliteTutorStore(join(dir, 'tutor.db'));
  const s = await a.read();
  const course = Object.values(s.courses)[0];
  const sub = course.syllabus.topics[0].subtopics[0];
  await a.mutate('course.editOutline', { courseId: course.id, syllabusRevision: course.syllabus.revision, operations: [{ op: 'renameSubtopic', subtopicId: sub.id, title: '学习者改的名字' }] }, undefined, { actor: 'learner' });
  await assert.rejects(() => b.mutate('course.editOutline', { courseId: course.id, syllabusRevision: course.syllabus.revision, operations: [{ op: 'renameSubtopic', subtopicId: sub.id, title: 'AI 的旧版本' }] }, undefined, { actor: 'ai' }), (e) => e.code === 'conflict');
  await assert.rejects(() => b.mutate('goal.create', { title: 'x', expectedOutcome: 'y' }, s.revision), (e) => e.code === 'conflict');
  const seeded = await b.mutate('board.seed', { courseId: course.id, baseRevision: 0 }, undefined, { actor: 'ai' });
  assert.equal(seeded.result.revision, 1);
  await assert.rejects(() => a.mutate('board.patch', { courseId: course.id, baseRevision: 0, operations: [{ op: 'add', type: 'note', text: 'stale' }] }, undefined, { actor: 'learner' }), (e) => e.code === 'conflict');
  const now = await a.read();
  assert.equal(now.concepts[sub.conceptId].title, '学习者改的名字', 'learner edit survived');
  assert.equal(now.boards[course.id].elements.filter((e) => e.type === 'concept').length, 15);
  assert.equal(now.events.at(-1).actor, 'ai');
  // approval gate unchanged: the model cannot approve
  await assert.rejects(() => b.mutate('course.approve', { courseId: course.id, syllabusRevision: now.courses[course.id].syllabus.revision }, undefined, { actor: 'ai' }));
  a.close(); b.close();
}));

test('many writes from one process are serialised (sync transactions)', () => tmp(async (dir) => {
  const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: null });
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.mutate('goal.create', { title: `T${i}`, expectedOutcome: 'O' })));
  const s = await store.read();
  assert.equal(s.revision, 8);
  assert.equal(Object.keys(s.goals).length, 8);
  assert.equal(store.db.prepare('SELECT count(*) n FROM events').get().n, 8);
  store.close();
}));

test('board diff writes: move, delete and cascade round-trip exactly like the JSON store', () => tmp(async (dir) => {
  const json = new JsonTutorStore(join(dir, 'state.json'));
  await copyFile(FIXTURE, join(dir, 'state.json'));
  const sq = await migrated(await mkdtemp(join(dir, 'sq-')));
  const run = async (store) => {
    const s = await store.read(); const c = Object.values(s.courses)[0];
    await store.mutate('board.seed', { courseId: c.id, baseRevision: 0 });
    let b = (await store.read()).boards[c.id];
    const [c1, c2] = b.elements.filter((e) => e.type === 'concept');
    await store.mutate('board.patch', { courseId: c.id, baseRevision: b.revision, operations: [{ op: 'update', id: c1.id, x: 900, y: 40 }, { op: 'add', type: 'arrow', from: c1.id, to: c2.id, label: 'L' }] });
    b = (await store.read()).boards[c.id];
    await store.mutate('board.patch', { courseId: c.id, baseRevision: b.revision, operations: [{ op: 'delete', id: c2.id }] });
    const out = (await store.read()).boards[c.id];
    return out.elements.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, deleted: Boolean(e.deleted), deletedBy: e.deletedBy ?? null }));
  };
  const a = await run(json);
  const b = await run(sq);
  const norm = (els) => els.map((e) => (e.type === 'arrow' || e.type === 'note' ? { ...e, id: e.type } : e));
  assert.deepEqual(norm(b), norm(a));
  sq.close();
}));

test('to-dos: create / update with row revision CAS; each write bumps the shared revision and logs its actor', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const s = await store.read(); const course = Object.values(s.courses)[0];
  const kp = Object.values(s.concepts)[0];
  const created = await store.todo('create', { courseId: course.id, title: '复习：' + kp.title, dueAt: '2026-11-12T19:00:00-07:00', conceptId: kp.id }, { actor: 'learner' });
  assert.equal(created.revision, s.revision + 1);
  assert.equal(created.todo.due_at, '2026-11-13T02:00:00.000Z');
  assert.equal(created.todo.concept_title, kp.title);
  assert.equal(created.todo.revision, 1);
  await assert.rejects(() => store.todo('create', { courseId: course.id, title: 'x', dueAt: '2026-11-12 19:00' }), /ISO/);
  await assert.rejects(() => store.todo('create', { courseId: course.id, title: 'x', dueAt: '2026-11-12T19:00:00' }), /offset/);
  const done = await store.todo('update', { id: created.todo.id, baseRevision: 1, status: 'done' }, { actor: 'ai' });
  assert.equal(done.todo.status, 'done'); assert.equal(done.todo.revision, 2);
  await assert.rejects(() => store.todo('update', { id: created.todo.id, baseRevision: 1, title: 'stale' }, { actor: 'learner' }), (e) => e.code === 'conflict' && e.todoRevision === 2);
  const ev = (await store.read()).events.slice(-2);
  assert.deepEqual(ev.map((e) => [e.action, e.actor]), [['todo.create', 'learner'], ['todo.update', 'ai']]);
  // a domain write after to-do writes still passes the global CAS
  await store.mutate('goal.create', { title: 'g', expectedOutcome: 'o' }, done.revision);
  store.close();
}));

test('data panel: knowledge point rows link to the board cards bound by conceptId (not by title)', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const s = await store.read(); const course = Object.values(s.courses)[0];
  let rows = await store.data('knowledgePoints', { courseId: course.id });
  assert.equal(rows.length, 15);
  assert.ok(rows.every((r) => Array.isArray(r.board_cards) && r.board_cards.length === 0), 'no board yet → no cards');
  await store.mutate('board.seed', { courseId: course.id, baseRevision: 0 });
  // a note whose text equals a knowledge point title must NOT count as that point's card
  const b = (await store.read()).boards[course.id];
  await store.mutate('board.patch', { courseId: course.id, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', text: rows[0].title }] });
  rows = await store.data('knowledgePoints', { courseId: course.id });
  const board = (await store.read()).boards[course.id];
  for (const r of rows) {
    const expected = board.elements.filter((e) => e.type === 'concept' && !e.deleted && e.conceptId === r.concept_id).map((e) => e.id);
    assert.deepEqual(r.board_cards, expected, r.title);
    assert.equal(r.board_cards.length, 1);
  }
  const first = rows[0];
  assert.equal(first.topic_index, 0); assert.equal(first.sub_index, 0);
  // deleting the card removes the link
  await store.mutate('board.patch', { courseId: course.id, baseRevision: board.revision, operations: [{ op: 'delete', id: first.board_cards[0] }] });
  assert.deepEqual((await store.data('knowledgePoints', { courseId: course.id }))[0].board_cards, []);
  // detail query: relations / attempts / to-dos for one point
  const withAttempt = s.assessments[Object.keys(s.assessments)[0]];
  const d = await store.data('concept', { courseId: course.id, conceptId: withAttempt.conceptId });
  assert.equal(d.concept.id, withAttempt.conceptId);
  assert.ok(d.attempts.some((a) => a.assessment_id === withAttempt.id));
  assert.equal((await store.data('attempts', { courseId: course.id })).length, Object.keys(s.assessments).length);
  assert.ok((await store.data('questions', { courseId: course.id })).length >= 1);
  await assert.rejects(() => store.data('concept', { courseId: course.id, conceptId: 'kp-nope' }), /not in this course/);
  store.close();
}));

test('read-only SQL for the model: views only, one SELECT, no writes / RECURSIVE / ATTACH, row cap', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const ok = await store.readOnlyQuery("SELECT title, mastery FROM v_knowledge_points WHERE mastery != 'unverified'", { limit: 3 });
  assert.ok(ok.rows.length >= 1 && ok.rows.length <= 3);
  assert.deepEqual(ok.columns, ['title', 'mastery']);
  const capped = await store.readOnlyQuery('SELECT * FROM v_outline', { limit: 5 });
  assert.equal(capped.rows.length, 5); assert.equal(capped.truncated, true);
  const big = await store.readOnlyQuery('SELECT * FROM v_outline', { limit: 1000 });
  assert.equal(big.limit, 200);
  const cte = await store.readOnlyQuery('WITH k AS (SELECT topic_title, count(*) n FROM v_knowledge_points GROUP BY topic_title) SELECT * FROM k');
  assert.ok(cte.rows.length >= 2);
  for (const bad of ['SELECT * FROM todos', 'SELECT doc FROM concepts', 'SELECT * FROM v_todos, meta', 'SELECT * FROM sqlite_master',
    "UPDATE todos SET title = 'x'", 'DELETE FROM v_todos', 'SELECT 1; DROP TABLE todos', "ATTACH DATABASE '/tmp/x.db' AS x",
    'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n FROM r', 'PRAGMA user_version'])
    await assert.rejects(() => store.readOnlyQuery(bad), Error, bad);
  assert.equal((await store.head()).revision, 19, 'nothing changed');
  store.close();
}));

test('RPC + tools: data / todo methods (learner) and tutor_table_query / tutor_todo (ai) share the same store', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const s = await store.read(); const course = Object.values(s.courses)[0];
  const rows = await dispatch(store, { method: 'data', payload: { query: 'knowledgePoints', params: { courseId: course.id } } });
  assert.equal(rows.length, 15);
  const t = await dispatch(store, { method: 'todo', payload: { op: 'create', input: { courseId: course.id, title: '做 3 道题', dueAt: '2026-11-11T18:00:00-07:00' } } });
  assert.equal(t.todo.created_by, 'learner');
  const tools = Object.fromEntries(toolSpecs(store).map((x) => [x.name, x]));
  const q = await tools.tutor_table_query.execute({ sql: 'SELECT title, due_at, created_by FROM v_todos' });
  assert.deepEqual(q.rows.map((r) => r.created_by), ['learner']);
  const up = await tools.tutor_todo.execute({ op: 'update', id: t.todo.id, baseRevision: t.todo.revision, status: 'done' });
  assert.equal(up.todo.status, 'done');
  await assert.rejects(() => tools.tutor_todo.execute({ op: 'update', id: t.todo.id, baseRevision: t.todo.revision, status: 'open' }), (e) => e.code === 'conflict');
  await assert.rejects(() => tools.tutor_table_query.execute({ sql: "UPDATE todos SET status='open'" }));
  assert.equal((await store.data('todos', { courseId: course.id }))[0].status, 'done');
  store.close();
}));

test('tools: the model cannot lift read-only, reach base tables, stack statements or exceed the row cap; tutor_todo validates', () => tmp(async (dir) => {
  const store = await migrated(dir);
  const course = Object.values((await store.read()).courses)[0];
  const tools = Object.fromEntries(toolSpecs(store).map((x) => [x.name, x]));
  for (const sql of ['SELECT * FROM todos', 'SELECT doc FROM concepts', 'PRAGMA query_only=0', "ATTACH DATABASE '/tmp/x.db' AS x",
    'SELECT 1; DELETE FROM todos', 'DELETE FROM todos', "INSERT INTO todos(id) VALUES ('x')", 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c',
    'SELECT * FROM v_todos, sqlite_master']) {
    await assert.rejects(() => tools.tutor_table_query.execute({ sql }), undefined, sql);
  }
  const big = await tools.tutor_table_query.execute({ sql: 'SELECT a.concept_id FROM v_knowledge_points a, v_knowledge_points b', limit: 5000 });
  assert.equal(big.rows.length, 200); assert.equal(big.truncated, true);
  const ok = await tools.tutor_table_query.execute({ sql: 'SELECT title, avg_score FROM v_knowledge_points WHERE attempts > 0 ORDER BY avg_score', limit: 3 });
  assert.ok(ok.rows.length >= 1 && ok.rows.length <= 3);
  await assert.rejects(() => tools.tutor_todo.execute({ op: 'create', courseId: course.id, title: 'x', dueAt: '明天' }));
  await assert.rejects(() => tools.tutor_todo.execute({ op: 'create', courseId: course.id, title: 'x', conceptId: 'kp-not-in-course' }));
  await assert.rejects(() => tools.tutor_todo.execute({ op: 'delete', id: 'x' }));
  const t = await tools.tutor_todo.execute({ op: 'create', courseId: course.id, title: '复习', dueAt: '2026-11-12T19:00:00-07:00' });
  assert.equal(t.todo.created_by, 'ai');
  await assert.rejects(() => tools.tutor_todo.execute({ op: 'update', id: t.todo.id, status: 'done' }), 'baseRevision is required');
  const names = toolSpecs(store).map((x) => x.name);
  assert.ok(!names.some((n) => /approve/.test(n)), 'no approve tool');
  store.close();
}));

test('tools: the JSON store (storage=json) does not offer the SQLite-only tools', async () => {
  const names = toolSpecs(new JsonTutorStore('/tmp/never-written.json')).map((x) => x.name);
  assert.ok(!names.includes('tutor_table_query') && !names.includes('tutor_todo'));
});
