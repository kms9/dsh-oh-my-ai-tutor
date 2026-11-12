// SQLite tutor store (node:sqlite, built into Node >= 22.13 / 24). One database file per DSH home:
// $DSH_HOME/oh-my-ai-tutor/tutor.db. It is the ONLY source of truth once opened; a legacy state.json is imported
// once (guarded by a dedicated meta marker, not by "does the db file exist"), then renamed and kept.
//
// Layout: every domain entity is one row = indexed columns for queries + the full entity as a JSON `doc`
// (so core.mjs keeps its pure state-object transitions and nothing is lost in mapping). Writes are one
// BEGIN IMMEDIATE transaction: read → revision CAS → transition → write only the rows that changed.
import { DatabaseSync, constants as sqliteConstants } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { newState, validateState, transition, SCHEMA_VERSION, MAX_EVENTS, ACTORS } from './core.mjs';

/** Physical layout version of this database (PRAGMA user_version). Bump only with a migration step below. */
export const DB_VERSION = 1;
const APPLICATION_ID = 0x4f4d5454; // "OMTT": never adopt or reset an unrelated SQLite file
export const TODO_STATUS = Object.freeze(['open', 'done', 'dropped']);

export function defaultDbPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'oh-my-ai-tutor', 'tutor.db');
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE goals (id TEXT PRIMARY KEY, doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE TABLE courses (id TEXT PRIMARY KEY, goal_id TEXT, title TEXT, status TEXT, syllabus_revision INTEGER, updated_at TEXT,
  doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE TABLE concepts (id TEXT PRIMARY KEY, course_id TEXT, topic_id TEXT, subtopic_id TEXT, title TEXT, status TEXT, mastery TEXT,
  doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE INDEX concepts_course ON concepts(course_id, status);
CREATE TABLE relations (id TEXT PRIMARY KEY, course_id TEXT, from_id TEXT, to_id TEXT, type TEXT, status TEXT,
  doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE INDEX relations_course ON relations(course_id);
CREATE INDEX relations_from ON relations(from_id);
CREATE INDEX relations_to ON relations(to_id);
CREATE TABLE lessons (id TEXT PRIMARY KEY, course_id TEXT, title TEXT, status TEXT, phase TEXT, created_at TEXT,
  doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE INDEX lessons_course ON lessons(course_id);
CREATE TABLE notes (id TEXT PRIMARY KEY, course_id TEXT, lesson_id TEXT, author TEXT, created_at TEXT,
  doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE TABLE assessments (id TEXT PRIMARY KEY, lesson_id TEXT, concept_id TEXT, score REAL, recorded_at TEXT,
  doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE INDEX assessments_concept ON assessments(concept_id);
CREATE INDEX assessments_lesson ON assessments(lesson_id);
CREATE TABLE sources (id TEXT PRIMARY KEY, kind TEXT, title TEXT, doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE TABLE boards (course_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT, doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE TABLE board_elements (course_id TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, type TEXT, concept_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, doc TEXT NOT NULL CHECK (json_valid(doc)), PRIMARY KEY (course_id, id));
CREATE INDEX board_elements_concept ON board_elements(concept_id, deleted);
CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, at TEXT, actor TEXT, action TEXT,
  entity_id TEXT, summary TEXT, doc TEXT NOT NULL CHECK (json_valid(doc)));
CREATE INDEX events_revision ON events(revision);
-- learner / AI to-dos with due dates (new in the SQLite store; not part of the legacy JSON state)
CREATE TABLE todos (id TEXT PRIMARY KEY, course_id TEXT, concept_id TEXT, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  due_at TEXT, remind_at TEXT, note TEXT, created_by TEXT CHECK (created_by IN ('learner','ai')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
CREATE INDEX todos_due ON todos(status, due_at);
CREATE INDEX todos_course ON todos(course_id);
-- reserved for spaced repetition (FSRS); not written yet
CREATE TABLE review_cards (id TEXT PRIMARY KEY, course_id TEXT, concept_id TEXT, due_at TEXT NOT NULL, stability REAL, difficulty REAL,
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new', last_review_at TEXT);
CREATE INDEX review_cards_due ON review_cards(due_at);
CREATE TABLE review_logs (id TEXT PRIMARY KEY, card_id TEXT REFERENCES review_cards(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating BETWEEN 1 AND 4), reviewed_at TEXT, assessment_id TEXT);

-- read-only views: the data panel and tutor_table_query only ever read these
CREATE VIEW v_outline AS
  SELECT c.id AS course_id, CAST(t.key AS INTEGER) AS topic_index, json_extract(t.value, '$.id') AS topic_id,
    json_extract(t.value, '$.title') AS topic_title, CAST(s.key AS INTEGER) AS sub_index, json_extract(s.value, '$.id') AS subtopic_id,
    json_extract(s.value, '$.title') AS title, json_extract(s.value, '$.description') AS description,
    json_extract(s.value, '$.conceptId') AS concept_id
  FROM courses c, json_each(c.doc, '$.syllabus.topics') t, json_each(t.value, '$.subtopics') s;
CREATE VIEW v_board_cards AS
  SELECT course_id, id AS element_id, concept_id, ord, json_extract(doc, '$.x') AS x, json_extract(doc, '$.y') AS y,
    json_extract(doc, '$.createdBy') AS created_by
  FROM board_elements WHERE type = 'concept' AND deleted = 0;
CREATE VIEW v_knowledge_points AS
  SELECT o.course_id, o.concept_id, o.title, o.topic_id, o.topic_title, o.topic_index, o.sub_index, o.subtopic_id, o.description,
    k.mastery,
    (SELECT count(*) FROM assessments a WHERE a.concept_id = o.concept_id) AS attempts,
    (SELECT round(avg(a.score), 2) FROM assessments a WHERE a.concept_id = o.concept_id) AS avg_score,
    (SELECT max(a.recorded_at) FROM assessments a WHERE a.concept_id = o.concept_id) AS last_attempt_at,
    (SELECT count(*) FROM relations r WHERE r.from_id = o.concept_id OR r.to_id = o.concept_id) AS relations,
    (SELECT json_group_array(element_id) FROM (SELECT element_id FROM v_board_cards b WHERE b.concept_id = o.concept_id AND b.course_id = o.course_id ORDER BY b.ord)) AS board_cards,
    (SELECT count(*) FROM todos t WHERE t.concept_id = o.concept_id AND t.status = 'open') AS open_todos
  FROM v_outline o LEFT JOIN concepts k ON k.id = o.concept_id;
CREATE VIEW v_attempts AS
  SELECT l.course_id, a.id AS assessment_id, a.concept_id, k.title AS concept_title, a.lesson_id, l.title AS lesson_title,
    json_extract(a.doc, '$.question') AS question, json_extract(a.doc, '$.studentAnswer') AS student_answer,
    json_extract(a.doc, '$.feedback') AS feedback, a.score, json_extract(a.doc, '$.hintCount') AS hint_count,
    json_extract(a.doc, '$.transfer') AS transfer, json_extract(a.doc, '$.judgedBy') AS judged_by, a.recorded_at
  FROM assessments a LEFT JOIN lessons l ON l.id = a.lesson_id LEFT JOIN concepts k ON k.id = a.concept_id;
CREATE VIEW v_questions AS
  SELECT course_id, question, concept_id, concept_title, lesson_id, lesson_title, count(*) AS attempts, round(avg(score), 2) AS avg_score,
    min(recorded_at) AS first_at, max(recorded_at) AS last_at, min(assessment_id) AS assessment_id
  FROM v_attempts GROUP BY course_id, question, concept_id, lesson_id;
CREATE VIEW v_todos AS
  SELECT t.id, t.course_id, t.concept_id, k.title AS concept_title, t.title, t.status, t.due_at, t.remind_at, t.note, t.created_by,
    t.created_at, t.updated_at, t.revision
  FROM todos t LEFT JOIN concepts k ON k.id = t.concept_id;
CREATE VIEW v_events AS SELECT seq, revision, at, actor, action, entity_id, summary FROM events;
`;

// collection → table, column extractors (doc is always the full entity)
const ENTITY = {
  goals: { table: 'goals', cols: () => ({}) },
  courses: { table: 'courses', cols: (c) => ({ goal_id: c.goalId ?? null, title: c.title ?? null, status: c.status ?? null, syllabus_revision: c.syllabus?.revision ?? 0, updated_at: c.updatedAt ?? null }) },
  concepts: { table: 'concepts', cols: (c) => ({ course_id: c.courseId ?? null, topic_id: c.topicId ?? null, subtopic_id: c.subtopicId ?? null, title: c.title ?? null, status: c.status ?? null, mastery: c.mastery ?? null }) },
  relations: { table: 'relations', cols: (r) => ({ course_id: r.courseId ?? null, from_id: r.from ?? null, to_id: r.to ?? null, type: r.type ?? null, status: r.status ?? null }) },
  lessons: { table: 'lessons', cols: (l) => ({ course_id: l.courseId ?? null, title: l.title ?? null, status: l.status ?? null, phase: l.phase ?? null, created_at: l.createdAt ?? null }) },
  notes: { table: 'notes', cols: (n) => ({ course_id: n.courseId ?? null, lesson_id: n.lessonId ?? null, author: n.author ?? null, created_at: n.createdAt ?? null }) },
  assessments: { table: 'assessments', cols: (a) => ({ lesson_id: a.lessonId ?? null, concept_id: a.conceptId ?? null, score: Number.isFinite(a.score) ? a.score : null, recorded_at: a.recordedAt ?? null }) },
  sources: { table: 'sources', cols: (s) => ({ kind: s.kind ?? null, title: s.title ?? null }) },
};
const STATE_KEYS = Object.keys(ENTITY);

function conflict(message, extra = {}) { return Object.assign(new Error(message), { code: 'conflict', ...extra }); }

export class SqliteTutorStore {
  /**
   * @param {string} path database file (or ':memory:')
   * @param {{ legacyJsonPath?: string|null, now?: () => string }} [opts] legacyJsonPath: a JSON state file to import once
   */
  constructor(path = defaultDbPath(), opts = {}) {
    this.path = path;
    this.legacyJsonPath = opts.legacyJsonPath === undefined ? (path === ':memory:' ? null : join(dirname(path), 'state.json')) : opts.legacyJsonPath;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.db = null;
    this.migration = null; // what happened at open: { imported: bool, from?, counts? }
  }

  // ---------- open / schema / migration ----------
  open() {
    if (this.db) return this.db;
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (!existsSync(this.path)) closeSync(openSync(this.path, 'wx', 0o600)); // owner-only file
    }
    const db = new DatabaseSync(this.path);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const appId = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (appId !== 0 && appId !== APPLICATION_ID) throw new Error(`${this.path} is not an oh-my-ai-tutor database (application_id ${appId})`);
      if (this.path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('BEGIN IMMEDIATE');
      try {
        const v = db.prepare('PRAGMA user_version').get().user_version;
        if (v === 0) {
          const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
          if (tables) throw new Error(`${this.path}: unversioned database with tables; refusing to adopt it`);
          db.exec(SCHEMA);
          db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('revision', '0');
          db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('stateSchemaVersion', String(SCHEMA_VERSION));
          db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
          db.exec(`PRAGMA user_version = ${DB_VERSION}`);
        } else if (v > DB_VERSION) {
          throw new Error(`${this.path} has database version ${v}, newer than this plugin understands (${DB_VERSION}); update the plugin`);
        }
        // (future: `else if (v < DB_VERSION)` runs ordered migrations here, inside this transaction — never drops data)
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      void version;
    } catch (e) { db.close(); throw e; }
    this.db = db;
    this.#importLegacyOnce();
    return db;
  }
  close() { this.db?.close(); this.db = null; }

  /**
   * One-time JSON → SQLite import. The marker `meta.jsonImport` is written in the SAME transaction as the imported
   * rows, so a crash either imports everything or nothing; a second start never imports again. The old file is
   * renamed (kept) only after the commit.
   */
  #importLegacyOnce() {
    const db = this.db;
    const marker = db.prepare("SELECT value FROM meta WHERE key = 'jsonImport'").get();
    if (marker) { this.migration = { imported: false, marker: JSON.parse(marker.value) }; return; }
    const src = this.legacyJsonPath && existsSync(this.legacyJsonPath) ? this.legacyJsonPath : null;
    let json = null;
    if (src) {
      const raw = readFileSync(src, 'utf8');
      json = validateState(JSON.parse(raw)); // corrupt JSON: throw, mark nothing, keep the file untouched
      if (!json.boards) json.boards = {};
    }
    let info;
    this.#tx(() => {
      if (db.prepare("SELECT value FROM meta WHERE key = 'jsonImport'").get()) { info = null; return; } // another process won
      const rev = Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value);
      if (json && rev > 0) throw new Error(`${this.path} already holds tutor data (revision ${rev}) but has no import marker; not importing ${src}`);
      const counts = {};
      if (json) {
        this.#writeDiff(newState(), json, 0);
        db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(json.revision));
        for (const k of [...STATE_KEYS, 'boards']) counts[k] = Object.keys(json[k] ?? {}).length;
        counts.boardElements = Object.values(json.boards).reduce((n, b) => n + (b.elements?.length ?? 0), 0);
        counts.events = json.events.length;
      }
      info = json ? { from: src, at: this.now(), revision: json.revision, counts } : { from: null, at: this.now() };
      db.prepare("INSERT INTO meta (key, value) VALUES ('jsonImport', ?)").run(JSON.stringify(info));
    });
    if (info?.from) {
      const kept = `${src}.migrated-${info.at.replace(/[:.]/g, '-')}`;
      try { renameSync(src, kept); info.keptAs = kept; } catch (e) { info.renameError = e.message; } // data is safe in the db either way
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'jsonImport'").run(JSON.stringify(info));
    }
    this.migration = { imported: Boolean(info?.from), marker: info };
  }

  #tx(fn) {
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
  }

  // ---------- state document <-> rows ----------
  #readState() {
    const db = this.db;
    const s = newState();
    s.revision = Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value);
    for (const key of STATE_KEYS) {
      for (const row of db.prepare(`SELECT id, doc FROM ${ENTITY[key].table} ORDER BY rowid`).all()) s[key][row.id] = JSON.parse(row.doc);
    }
    for (const row of db.prepare('SELECT course_id, doc FROM boards ORDER BY rowid').all()) s.boards[row.course_id] = { ...JSON.parse(row.doc), elements: [] };
    for (const row of db.prepare('SELECT course_id, doc FROM board_elements ORDER BY course_id, ord').all()) s.boards[row.course_id]?.elements.push(JSON.parse(row.doc));
    s.events = db.prepare('SELECT doc FROM (SELECT seq, doc FROM events ORDER BY seq DESC LIMIT ?) ORDER BY seq').all(MAX_EVENTS).map((r) => JSON.parse(r.doc));
    return s;
  }
  /** Write only what differs between two state documents (rows compared by their JSON). */
  #writeDiff(prev, next, prevRevision) {
    const db = this.db;
    for (const key of STATE_KEYS) {
      const { table, cols } = ENTITY[key];
      const a = prev[key] ?? {}, b = next[key] ?? {};
      let upsert = null;
      for (const [id, doc] of Object.entries(b)) {
        const text = JSON.stringify(doc);
        if (a[id] !== undefined && JSON.stringify(a[id]) === text) continue;
        const c = cols(doc);
        const names = Object.keys(c);
        upsert ??= db.prepare(`INSERT INTO ${table} (id, ${[...names, 'doc'].join(', ')}) VALUES (?, ${[...names, 'doc'].map(() => '?').join(', ')})
          ON CONFLICT(id) DO UPDATE SET ${[...names, 'doc'].map((n) => `${n} = excluded.${n}`).join(', ')}`);
        upsert.run(id, ...names.map((n) => c[n]), text);
      }
      for (const id of Object.keys(a)) if (b[id] === undefined) db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    }
    const pb = prev.boards ?? {}, nb = next.boards ?? {};
    for (const [courseId, board] of Object.entries(nb)) {
      const { elements = [], ...rest } = board;
      const old = pb[courseId];
      const restText = JSON.stringify(rest);
      if (!old || JSON.stringify({ ...old, elements: undefined }) !== JSON.stringify({ ...rest, elements: undefined })) {
        db.prepare(`INSERT INTO boards (course_id, revision, updated_at, doc) VALUES (?, ?, ?, ?)
          ON CONFLICT(course_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, doc = excluded.doc`)
          .run(courseId, board.revision ?? 0, board.updatedAt ?? null, restText);
      }
      const oldEls = new Map((old?.elements ?? []).map((e, i) => [e.id, { text: JSON.stringify(e), i }]));
      const up = db.prepare(`INSERT INTO board_elements (course_id, id, ord, type, concept_id, deleted, doc) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(course_id, id) DO UPDATE SET ord = excluded.ord, type = excluded.type, concept_id = excluded.concept_id, deleted = excluded.deleted, doc = excluded.doc`);
      elements.forEach((e, i) => {
        const text = JSON.stringify(e);
        const o = oldEls.get(e.id);
        if (o && o.text === text && o.i === i) return;
        up.run(courseId, e.id, i, e.type ?? null, e.conceptId ?? null, e.deleted ? 1 : 0, text);
      });
      const keep = new Set(elements.map((e) => e.id));
      for (const id of oldEls.keys()) if (!keep.has(id)) db.prepare('DELETE FROM board_elements WHERE course_id = ? AND id = ?').run(courseId, id);
    }
    const ins = db.prepare('INSERT INTO events (revision, at, actor, action, entity_id, summary, doc) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const e of next.events ?? []) {
      if (!(e.revision > prevRevision)) continue;
      ins.run(e.revision, e.at ?? null, e.actor ?? null, e.action ?? null, e.entityId ?? null, e.summary ?? null, JSON.stringify(e));
    }
  }

  // ---------- JsonTutorStore-compatible API ----------
  async read() { this.open(); return validateState(this.#readState()); }
  async head() { this.open(); return { revision: Number(this.db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value) }; }
  async mutate(action, payload, expectedRevision, opts = {}) {
    this.open();
    return this.#tx(() => {
      const state = this.#readState();
      if (expectedRevision !== undefined && expectedRevision !== state.revision) throw conflict(`Tutor revision conflict: current=${state.revision}`);
      const next = transition(state, action, payload, { actor: opts.actor, summary: opts.summary });
      this.#writeDiff(state, next.state, state.revision);
      this.db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(next.state.revision));
      return { revision: next.state.revision, result: next.result };
    });
  }

  // ---------- to-dos (row revision CAS; every write bumps the global revision and logs an event with its actor) ----------
  #bump(action, actor, entityId, summary) {
    const db = this.db;
    const revision = Number(db.prepare("SELECT value FROM meta WHERE key = 'revision'").get().value) + 1;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'revision'").run(String(revision));
    const e = { revision, at: this.now(), action, actor, entityId, ...(summary ? { summary: String(summary).slice(0, 200) } : {}) };
    db.prepare('INSERT INTO events (revision, at, actor, action, entity_id, summary, doc) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(revision, e.at, actor, action, entityId, e.summary ?? null, JSON.stringify(e));
    return revision;
  }
  /**
   * op 'create': { courseId, title, dueAt?, remindAt?, conceptId?, note? }
   * op 'update': { id, baseRevision (the to-do's own revision), title?, dueAt? (null clears), remindAt?, status?, conceptId?, note? }
   */
  async todo(op, input = {}, { actor = 'ai' } = {}) {
    this.open();
    if (!ACTORS.includes(actor)) throw new Error('actor must be learner or ai');
    const db = this.db;
    const text = (v, field, max) => { if (typeof v !== 'string' || !v.trim() || v.length > max) throw new Error(`${field} must be a non-empty string (max ${max})`); return v.trim(); };
    const when = (v, field) => {
      if (v === null || v === undefined || v === '') return null;
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) throw new Error(`${field} must be an ISO date-time with an offset or Z, e.g. 2026-11-12T19:00:00-07:00`);
      const t = Date.parse(v); if (!Number.isFinite(t)) throw new Error(`${field} is not a valid date-time`);
      if (!/(Z|[+-]\d{2}:?\d{2})$/.test(v)) throw new Error(`${field} needs an explicit offset or Z (time zone), e.g. 2026-11-12T19:00:00-07:00`);
      return new Date(t).toISOString();
    };
    const conceptOf = (conceptId, courseId) => {
      if (conceptId === null || conceptId === undefined || conceptId === '') return null;
      const k = db.prepare('SELECT course_id FROM concepts WHERE id = ?').get(conceptId);
      if (!k) throw new Error(`Unknown knowledge point id: ${conceptId}`);
      if (courseId && k.course_id !== courseId) throw new Error('Knowledge point belongs to another course');
      return conceptId;
    };
    return this.#tx(() => {
      const now = this.now();
      if (op === 'create') {
        const courseId = text(input.courseId, 'courseId', 200);
        if (!db.prepare('SELECT 1 FROM courses WHERE id = ?').get(courseId)) throw new Error(`Unknown courses id: ${courseId}`);
        const row = { id: `todo-${randomUUID()}`, course_id: courseId, concept_id: conceptOf(input.conceptId, courseId), title: text(input.title, 'title', 200),
          status: 'open', due_at: when(input.dueAt, 'dueAt'), remind_at: when(input.remindAt, 'remindAt'),
          note: typeof input.note === 'string' ? input.note.slice(0, 2000) : null, created_by: actor, created_at: now, updated_at: now, revision: 1 };
        db.prepare(`INSERT INTO todos (id, course_id, concept_id, title, status, due_at, remind_at, note, created_by, created_at, updated_at, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(row));
        const revision = this.#bump('todo.create', actor, row.id, `${actor === 'learner' ? '你' : 'AI'}新建待办「${row.title}」`);
        return { revision, todo: this.#todoRow(row.id) };
      }
      if (op === 'update') {
        const id = text(input.id, 'id', 200);
        const cur = db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
        if (!cur) throw new Error(`Unknown to-do id: ${id}`);
        if (!Number.isInteger(input.baseRevision)) throw new Error('baseRevision (the to-do revision you read) is required');
        if (input.baseRevision !== cur.revision) throw conflict(`To-do changed (revision ${cur.revision}); read it again`, { todoRevision: cur.revision });
        const set = {};
        if (input.title !== undefined) set.title = text(input.title, 'title', 200);
        if (input.dueAt !== undefined) set.due_at = when(input.dueAt, 'dueAt');
        if (input.remindAt !== undefined) set.remind_at = when(input.remindAt, 'remindAt');
        if (input.note !== undefined) set.note = input.note === null ? null : String(input.note).slice(0, 2000);
        if (input.conceptId !== undefined) set.concept_id = conceptOf(input.conceptId, cur.course_id);
        if (input.status !== undefined) { if (!TODO_STATUS.includes(input.status)) throw new Error(`status must be one of ${TODO_STATUS.join(', ')}`); set.status = input.status; }
        if (!Object.keys(set).length) throw new Error('Nothing to update');
        set.updated_at = now; set.revision = cur.revision + 1;
        db.prepare(`UPDATE todos SET ${Object.keys(set).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND revision = ?`).run(...Object.values(set), id, cur.revision);
        const what = set.status === 'done' ? '完成' : set.status === 'dropped' ? '放弃' : set.status === 'open' ? '重新打开' : '修改';
        const revision = this.#bump('todo.update', actor, id, `${actor === 'learner' ? '你' : 'AI'}${what}待办「${set.title ?? cur.title}」`);
        return { revision, todo: this.#todoRow(id) };
      }
      throw new Error('op must be create | update');
    });
  }
  #todoRow(id) { return { ...this.db.prepare('SELECT * FROM v_todos WHERE id = ?').get(id) }; }

  // ---------- read-only queries for the data panel ----------
  /** Named, parameterised queries only (the UI never sends SQL). */
  async data(name, params = {}) {
    this.open();
    const db = this.db;
    const plain = (rows) => rows.map((r) => ({ ...r }));
    const courseId = typeof params.courseId === 'string' ? params.courseId : null;
    if (!courseId && name !== 'courses') throw new Error('courseId is required');
    switch (name) {
      case 'knowledgePoints':
        return plain(db.prepare('SELECT * FROM v_knowledge_points WHERE course_id = ? ORDER BY topic_index, sub_index').all(courseId))
          .map((r) => ({ ...r, board_cards: JSON.parse(r.board_cards ?? '[]') }));
      case 'questions': return plain(db.prepare('SELECT * FROM v_questions WHERE course_id = ? ORDER BY last_at DESC').all(courseId));
      case 'attempts': return plain(db.prepare('SELECT * FROM v_attempts WHERE course_id = ? ORDER BY recorded_at DESC').all(courseId));
      case 'todos': return plain(db.prepare("SELECT * FROM v_todos WHERE course_id = ? ORDER BY status = 'open' DESC, due_at IS NULL, due_at, created_at").all(courseId));
      case 'concept': {
        const id = String(params.conceptId ?? '');
        const kp = db.prepare('SELECT * FROM v_knowledge_points WHERE course_id = ? AND concept_id = ?').get(courseId, id);
        if (!kp) throw new Error(`Knowledge point not in this course outline: ${id}`);
        const concept = JSON.parse(db.prepare('SELECT doc FROM concepts WHERE id = ?').get(id)?.doc ?? 'null');
        const relations = plain(db.prepare(`SELECT r.id, r.type, r.status, r.from_id, r.to_id, f.title AS from_title, t.title AS to_title, json_extract(r.doc, '$.note') AS note
          FROM relations r LEFT JOIN concepts f ON f.id = r.from_id LEFT JOIN concepts t ON t.id = r.to_id WHERE r.from_id = ? OR r.to_id = ? ORDER BY r.rowid`).all(id, id));
        const attempts = plain(db.prepare('SELECT * FROM v_attempts WHERE concept_id = ? ORDER BY recorded_at DESC').all(id));
        const todos = plain(db.prepare("SELECT * FROM v_todos WHERE concept_id = ? ORDER BY status = 'open' DESC, due_at").all(id));
        return { ...kp, board_cards: JSON.parse(kp.board_cards ?? '[]'), concept, relations, attempts, todos };
      }
      default: throw new Error(`Unknown data query: ${name}`);
    }
  }

  // ---------- model-facing read-only SQL (tutor_table_query) ----------
  static QUERYABLE = Object.freeze(['v_knowledge_points', 'v_outline', 'v_board_cards', 'v_attempts', 'v_questions', 'v_todos', 'v_events']);
  /**
   * One SELECT/WITH statement on a separate read-only connection. No RECURSIVE (cannot be interrupted once running),
   * no ATTACH/PRAGMA, only the documented views; at most `limit` (<= 200) rows, truncation reported.
   */
  async readOnlyQuery(sql, { limit = 50 } = {}) {
    this.open();
    const max = Math.max(1, Math.min(200, Number.isInteger(limit) ? limit : 50));
    if (typeof sql !== 'string' || !sql.trim() || sql.length > 4000) throw new Error('sql must be a non-empty string (max 4000 chars)');
    const stmt = sql.trim().replace(/;\s*$/, '');
    if (stmt.includes(';')) throw new Error('Only one statement is allowed');
    if (!/^(select|with)\b/i.test(stmt)) throw new Error('Only SELECT / WITH queries are allowed (read-only)');
    if (/\b(recursive|attach|detach|pragma|vacuum|insert|update|delete|create|drop|alter|reindex|analyze)\b/i.test(stmt.replace(/'(?:[^']|'')*'/g, "''")))
      throw new Error('Statement contains a forbidden keyword (read-only views only; no RECURSIVE)');
    const ro = this.path === ':memory:' ? this.db : new DatabaseSync(this.path, { readOnly: true });
    // SQLite authorizer: plain SELECT reads of the whitelisted views (and what those views read internally) only.
    const allowed = new Set(SqliteTutorStore.QUERYABLE);
    const denied = [];
    ro.setAuthorizer((action, a1, _a2, _db, view) => {
      if (action === sqliteConstants.SQLITE_SELECT || action === sqliteConstants.SQLITE_FUNCTION) return sqliteConstants.SQLITE_OK;
      if (action === sqliteConstants.SQLITE_READ && (view || allowed.has(String(a1).toLowerCase()))) return sqliteConstants.SQLITE_OK;
      denied.push(action === sqliteConstants.SQLITE_READ ? a1 : `action ${action}`);
      return sqliteConstants.SQLITE_DENY;
    });
    try {
      let q;
      try { q = ro.prepare(`SELECT * FROM (${stmt}) LIMIT ${max + 1}`); } catch (e) {
        if (denied.length) throw new Error(`Only these views can be queried: ${SqliteTutorStore.QUERYABLE.join(', ')} (denied: ${[...new Set(denied)].join(', ')})`);
        throw e;
      }
      const rows = q.all().map((r) => ({ ...r }));
      return { columns: rows[0] ? Object.keys(rows[0]) : q.columns().map((c) => c.name), rows: rows.slice(0, max), truncated: rows.length > max, limit: max };
    } finally { ro.setAuthorizer(null); if (ro !== this.db) ro.close(); }
  }
}
