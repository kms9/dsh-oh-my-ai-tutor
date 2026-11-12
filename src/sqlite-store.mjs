// SQLite tutor store (node:sqlite, built into Node >= 22.13 / 24). One database file per DSH home:
// $DSH_HOME/oh-my-ai-tutor/tutor.db. It is the ONLY source of truth once opened; a legacy state.json is imported
// once (guarded by a dedicated meta marker, not by "does the db file exist"), then renamed and kept.
//
// Layout: every domain entity is one row = indexed columns for queries + the full entity as a JSON `doc`
// (so core.mjs keeps its pure state-object transitions and nothing is lost in mapping). Writes are one
// BEGIN IMMEDIATE transaction: read → revision CAS → transition → write only the rows that changed.
import { DatabaseSync, constants as sqliteConstants } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { newState, validateState, transition, SCHEMA_VERSION, MAX_EVENTS, ACTORS } from './core.mjs';
import { cardFromRow, rowFromCard, review as fsrsReview, preview as fsrsPreview, replay, spreadOverdue, ratingFromAttempt, RATING_LABEL, STATE_NAME } from './review.mjs';

/** Physical layout version of this database (PRAGMA user_version). Bump only with a migration step below. */
export const DB_VERSION = 3;
const APPLICATION_ID = 0x4f4d5454; // "OMTT": never adopt or reset an unrelated SQLite file
export const TODO_STATUS = Object.freeze(['open', 'done', 'dropped']);

export function defaultDbPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'oh-my-ai-tutor', 'tutor.db');
}

/** Version-1 layout; a new database is created from it and then migrated (see MIGRATIONS). Exported for migration tests. */
export const SCHEMA_V1 = `
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
-- spaced repetition (FSRS); version 1 only reserved these, version 2 (MIGRATIONS[2]) adds the columns it writes
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

/**
 * Ordered, additive migrations: MIGRATIONS[n] takes a database at user_version n-1 to n. Each runs inside the open()
 * transaction together with the user_version bump, so a failure leaves the file at the old version, untouched.
 * A fresh database is created with SCHEMA (= version 1) and then walks the same steps.
 */
export const MIGRATIONS = {
  // 2: FSRS review cards (ts-fsrs). Version 1 reserved review_cards / review_logs but never wrote them; only ADD COLUMN,
  // so even a file where someone did write rows keeps them.
  2: `
ALTER TABLE review_cards ADD COLUMN scheduled_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_cards ADD COLUMN learning_steps INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_cards ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE review_cards ADD COLUMN source TEXT;
ALTER TABLE review_cards ADD COLUMN created_at TEXT;
ALTER TABLE review_cards ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX review_cards_concept ON review_cards(concept_id);
ALTER TABLE review_logs ADD COLUMN concept_id TEXT;
ALTER TABLE review_logs ADD COLUMN actor TEXT;
ALTER TABLE review_logs ADD COLUMN state_before TEXT;
ALTER TABLE review_logs ADD COLUMN prev_due TEXT;
ALTER TABLE review_logs ADD COLUMN next_due TEXT;
ALTER TABLE review_logs ADD COLUMN scheduled_days INTEGER;
CREATE INDEX review_logs_card ON review_logs(card_id, reviewed_at);
DROP VIEW v_knowledge_points;
CREATE VIEW v_knowledge_points AS
  SELECT o.course_id, o.concept_id, o.title, o.topic_id, o.topic_title, o.topic_index, o.sub_index, o.subtopic_id, o.description,
    k.mastery,
    (SELECT count(*) FROM assessments a WHERE a.concept_id = o.concept_id) AS attempts,
    (SELECT round(avg(a.score), 2) FROM assessments a WHERE a.concept_id = o.concept_id) AS avg_score,
    (SELECT max(a.recorded_at) FROM assessments a WHERE a.concept_id = o.concept_id) AS last_attempt_at,
    (SELECT count(*) FROM relations r WHERE r.from_id = o.concept_id OR r.to_id = o.concept_id) AS relations,
    (SELECT json_group_array(element_id) FROM (SELECT element_id FROM v_board_cards b WHERE b.concept_id = o.concept_id AND b.course_id = o.course_id ORDER BY b.ord)) AS board_cards,
    (SELECT count(*) FROM todos t WHERE t.concept_id = o.concept_id AND t.status = 'open') AS open_todos,
    rc.id AS review_card_id, rc.state AS review_state, CASE WHEN rc.state = 'new' THEN NULL ELSE rc.due_at END AS next_review_at,
    rc.reps AS review_reps, rc.revision AS review_revision
  FROM v_outline o LEFT JOIN concepts k ON k.id = o.concept_id LEFT JOIN review_cards rc ON rc.concept_id = o.concept_id;
CREATE VIEW v_review_cards AS
  SELECT r.id, o.course_id, r.concept_id, o.title AS concept_title, o.topic_title, o.topic_index, o.sub_index, r.state,
    CASE WHEN r.state = 'new' THEN NULL ELSE r.due_at END AS due_at, r.last_review_at, r.reps, r.lapses, r.stability, r.difficulty,
    r.scheduled_days, r.source, r.revision, r.updated_at
  FROM review_cards r JOIN v_outline o ON o.concept_id = r.concept_id;
CREATE VIEW v_review_logs AS
  SELECT l.id, l.card_id, l.concept_id, k.title AS concept_title, l.rating, l.actor, l.reviewed_at, l.state_before, l.prev_due, l.next_due,
    l.scheduled_days, l.assessment_id
  FROM review_logs l LEFT JOIN concepts k ON k.id = l.concept_id;
`,
  // 3: the learning flow joins up by conceptId — lessons and notes carry topicId / conceptIds, parts and notes carry
  // structured source references, the outline keeps its change log. Those live in the entity docs (no table change,
  // no data rewrite: older docs simply have none); this step adds the read views over them and extends
  // v_knowledge_points with the lessons that teach a knowledge point and the notes attached to it.
  3: `
CREATE VIEW v_lessons AS
  SELECT l.course_id, l.id AS lesson_id, l.title, l.status, l.phase, json_extract(l.doc, '$.topicId') AS topic_id,
    COALESCE(json_extract(l.doc, '$.conceptIds'), '[]') AS concept_ids, json_extract(l.doc, '$.activePartIndex') AS active_part_index,
    json_array_length(l.doc, '$.parts') AS parts, json_extract(l.doc, '$.pendingQuestion.question') AS pending_question,
    json_extract(l.doc, '$.pendingQuestion.attempts') AS pending_attempts, json_extract(l.doc, '$.pendingQuestion.hintCount') AS pending_hints,
    json_extract(l.doc, '$.feedback.text') AS feedback, json_extract(l.doc, '$.nextPreview.text') AS next_preview,
    l.created_at, json_extract(l.doc, '$.updatedAt') AS updated_at
  FROM lessons l;
CREATE VIEW v_lesson_concepts AS
  SELECT l.course_id, l.id AS lesson_id, l.title AS lesson_title, l.phase, j.value AS concept_id, k.title AS concept_title
  FROM lessons l, json_each(l.doc, '$.conceptIds') j LEFT JOIN concepts k ON k.id = j.value;
CREATE VIEW v_notes AS
  SELECT n.course_id, n.id AS note_id, n.lesson_id, json_extract(n.doc, '$.title') AS title, n.author,
    COALESCE(json_extract(n.doc, '$.conceptIds'), '[]') AS concept_ids, substr(json_extract(n.doc, '$.content'), 1, 300) AS excerpt, n.created_at
  FROM notes n;
CREATE VIEW v_note_concepts AS
  SELECT n.course_id, n.id AS note_id, json_extract(n.doc, '$.title') AS title, j.value AS concept_id
  FROM notes n, json_each(n.doc, '$.conceptIds') j;
CREATE VIEW v_sources AS
  SELECT s.id AS source_id, s.kind, s.title, json_extract(s.doc, '$.uri') AS uri, json_extract(s.doc, '$.access') AS access FROM sources s;
CREATE VIEW v_source_refs AS
  SELECT l.course_id, 'part' AS owner_kind, l.id AS lesson_id, CAST(p.key AS INTEGER) AS part_index, NULL AS note_id,
    json_extract(r.value, '$.sourceId') AS source_id, json_extract(r.value, '$.locator') AS locator,
    json_extract(r.value, '$.page') AS page, json_extract(r.value, '$.seconds') AS seconds
  FROM lessons l, json_each(l.doc, '$.parts') p, json_each(p.value, '$.sourceRefs') r WHERE r.type = 'object'
  UNION ALL
  SELECT n.course_id, 'note', n.lesson_id, NULL, n.id, json_extract(r.value, '$.sourceId'), json_extract(r.value, '$.locator'),
    json_extract(r.value, '$.page'), json_extract(r.value, '$.seconds')
  FROM notes n, json_each(n.doc, '$.sourceRefs') r WHERE r.type = 'object';
CREATE VIEW v_syllabus_changes AS
  SELECT c.id AS course_id, json_extract(x.value, '$.fromRevision') AS from_revision, json_extract(x.value, '$.toRevision') AS to_revision,
    json_extract(x.value, '$.at') AS at, json_extract(x.value, '$.actor') AS actor, json_extract(x.value, '$.reason') AS reason,
    json_extract(x.value, '$.lines') AS lines, json_extract(x.value, '$.forLessonId') AS for_lesson_id
  FROM courses c, json_each(c.doc, '$.syllabusChanges') x;
DROP VIEW v_knowledge_points;
CREATE VIEW v_knowledge_points AS
  SELECT o.course_id, o.concept_id, o.title, o.topic_id, o.topic_title, o.topic_index, o.sub_index, o.subtopic_id, o.description,
    k.mastery,
    (SELECT count(*) FROM assessments a WHERE a.concept_id = o.concept_id) AS attempts,
    (SELECT round(avg(a.score), 2) FROM assessments a WHERE a.concept_id = o.concept_id) AS avg_score,
    (SELECT max(a.recorded_at) FROM assessments a WHERE a.concept_id = o.concept_id) AS last_attempt_at,
    (SELECT count(*) FROM relations r WHERE r.from_id = o.concept_id OR r.to_id = o.concept_id) AS relations,
    (SELECT json_group_array(element_id) FROM (SELECT element_id FROM v_board_cards b WHERE b.concept_id = o.concept_id AND b.course_id = o.course_id ORDER BY b.ord)) AS board_cards,
    (SELECT count(*) FROM todos t WHERE t.concept_id = o.concept_id AND t.status = 'open') AS open_todos,
    rc.id AS review_card_id, rc.state AS review_state, CASE WHEN rc.state = 'new' THEN NULL ELSE rc.due_at END AS next_review_at,
    rc.reps AS review_reps, rc.revision AS review_revision,
    (SELECT count(DISTINCT lc.lesson_id) FROM v_lesson_concepts lc WHERE lc.concept_id = o.concept_id) AS lessons,
    (SELECT count(*) FROM v_note_concepts nc WHERE nc.concept_id = o.concept_id) AS notes
  FROM v_outline o LEFT JOIN concepts k ON k.id = o.concept_id LEFT JOIN review_cards rc ON rc.concept_id = o.concept_id;
`,
};

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

/** Consistent copy of a database before a migration: `<db>.bak-v<from>-<time>`, mode 0600 (never wider than the db). */
export function backupDb(db, path, from, at = new Date().toISOString()) {
  const target = `${path}.bak-v${from}-${String(at).replace(/[:.]/g, '-')}`;
  if (existsSync(target)) return target;
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  chmodSync(target, 0o600);
  return target;
}
function conflict(message, extra = {}) { return Object.assign(new Error(message), { code: 'conflict', ...extra }); }

export class SqliteTutorStore {
  /**
   * @param {string} path database file (or ':memory:')
   * @param {{ legacyJsonPath?: string|null, now?: () => string, backupBeforeMigrate?: boolean }} [opts] legacyJsonPath: a JSON state file to import once; an existing db is copied before a migration unless backupBeforeMigrate is false
   */
  constructor(path = defaultDbPath(), opts = {}) {
    this.path = path;
    this.legacyJsonPath = opts.legacyJsonPath === undefined ? (path === ':memory:' ? null : join(dirname(path), 'state.json')) : opts.legacyJsonPath;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.backupBeforeMigrate = opts.backupBeforeMigrate !== false; // migrate-db.mjs takes its own copy first
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
    let backup = null;
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      const appId = db.prepare('PRAGMA application_id').get().application_id;
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (appId !== 0 && appId !== APPLICATION_ID) throw new Error(`${this.path} is not an oh-my-ai-tutor database (application_id ${appId})`);
      // An existing database about to be migrated is copied first (consistent VACUUM INTO, WAL included), owner-only.
      if (this.path !== ':memory:' && version >= 1 && version < DB_VERSION && this.backupBeforeMigrate !== false) backup = backupDb(db, this.path, version, this.now());
      if (this.path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('BEGIN IMMEDIATE');
      try {
        const v = db.prepare('PRAGMA user_version').get().user_version;
        if (v === 0) {
          const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;
          if (tables) throw new Error(`${this.path}: unversioned database with tables; refusing to adopt it`);
          db.exec(SCHEMA_V1);
          db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('revision', '0');
          db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('stateSchemaVersion', String(SCHEMA_VERSION));
          db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
          db.exec('PRAGMA user_version = 1');
        } else if (v > DB_VERSION) {
          throw new Error(`${this.path} has database version ${v}, newer than this plugin understands (${DB_VERSION}); update the plugin`);
        }
        const from = db.prepare('PRAGMA user_version').get().user_version;
        for (let n = from + 1; n <= DB_VERSION; n++) {
          db.exec(MIGRATIONS[n]);
          db.exec(`PRAGMA user_version = ${n}`);
        }
        if (from < DB_VERSION && v !== 0) {
          db.prepare("INSERT INTO meta (key, value) VALUES ('dbMigrations', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(JSON.stringify({ from, to: DB_VERSION, at: this.now(), ...(backup ? { backup } : {}) }));
        }
        // dedicated marker of the v3 step (written in the same transaction as the step itself)
        if (from < 3 && DB_VERSION >= 3) {
          db.prepare("INSERT INTO meta (key, value) VALUES ('migration.v3.learningFlow', ?) ON CONFLICT(key) DO NOTHING")
            .run(JSON.stringify({ from, at: this.now(), fresh: v === 0, ...(backup ? { backup } : {}), views: ['v_lessons', 'v_lesson_concepts', 'v_notes', 'v_note_concepts', 'v_sources', 'v_source_refs', 'v_syllabus_changes'] }));
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      void version;
    } catch (e) { db.close(); throw e; }
    this.db = db;
    this.backup = backup;
    this.#importLegacyOnce();
    this.reviewInit = this.#tx(() => this.#reconcileReviewCards({ spread: true }));
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
      // review cards follow the evidence: a newly recorded attempt is an FSRS review of its knowledge point; new
      // knowledge points get a card. Same transaction, so a rejected write changes no schedule either.
      this.#reconcileReviewCards({ spread: false });
      for (const [id, a] of Object.entries(next.state.assessments)) {
        if (state.assessments[id] || !a.conceptId) continue;
        const rating = ratingFromAttempt(a);
        if (this.db.prepare('SELECT 1 FROM review_logs WHERE assessment_id = ?').get(id)) continue; // already replayed into a new card
        if (rating) this.#applyReview(a.conceptId, rating, new Date(a.recordedAt ?? this.now()), opts.actor ?? 'ai', id);
      }
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

  // ---------- FSRS review cards ----------
  /**
   * Make sure every live knowledge point has exactly one review card. A knowledge point with evidence (scored attempts,
   * or a mastery label) gets a card replayed from that evidence; others start as 'new' (not scheduled until the first
   * attempt or rating). `spread`: cards that come out overdue from old evidence are spread over the next days
   * (at most 3 a day, most overdue first) instead of all landing on today. Caller holds the transaction.
   */
  #reconcileReviewCards({ spread }) {
    const db = this.db;
    const missing = db.prepare(`SELECT k.id, k.course_id, k.mastery, k.doc FROM concepts k
      WHERE k.status = 'active' AND NOT EXISTS (SELECT 1 FROM review_cards r WHERE r.concept_id = k.id)`).all();
    if (!missing.length) return { created: 0, fromEvidence: 0, spread: 0 };
    const now = new Date(this.now());
    const attemptsOf = db.prepare('SELECT a.id, a.score, a.recorded_at, json_extract(a.doc, \'$.hintCount\') AS hint_count FROM assessments a WHERE a.concept_id = ?');
    const made = missing.map((k) => {
      const doc = JSON.parse(k.doc);
      const r = replay(attemptsOf.all(k.id), { mastery: k.mastery, createdAt: doc.createdAt, masteryAt: doc.updatedAt });
      return { k, ...(r ?? { card: null, logs: [], source: 'new' }) };
    });
    const withEvidence = made.filter((m) => m.card);
    if (spread) spreadOverdue(withEvidence, now, 3);
    const insCard = db.prepare(`INSERT INTO review_cards (id, course_id, concept_id, due_at, stability, difficulty, reps, lapses, state, last_review_at,
      scheduled_days, learning_steps, revision, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`);
    const insLog = db.prepare(`INSERT INTO review_logs (id, card_id, concept_id, rating, reviewed_at, assessment_id, actor, state_before, prev_due, next_due, scheduled_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const at = now.toISOString();
    for (const m of made) {
      const id = `rc-${m.k.id}`;
      if (m.card) {
        const c = rowFromCard(m.card);
        insCard.run(id, m.k.course_id, m.k.id, c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.state, c.last_review_at, c.scheduled_days, c.learning_steps, m.source, at, at);
        m.logs.forEach((l, i) => insLog.run(`rl-${randomUUID()}`, id, m.k.id, l.rating, l.review.toISOString(), l.assessmentId ?? null, 'system',
          STATE_NAME[l.state] ?? null, null, i === m.logs.length - 1 ? c.due_at : null, l.scheduled_days ?? null));
      } else {
        insCard.run(id, m.k.course_id, m.k.id, at, null, null, 0, 0, 'new', null, 0, 0, 'new', at, at);
      }
    }
    return { created: made.length, fromEvidence: withEvidence.length, spread: withEvidence.filter((m) => m.spread > 0).length };
  }
  /** One FSRS review of a knowledge point's card (caller holds the transaction). Returns the updated row. */
  #applyReview(conceptId, rating, at, actor, assessmentId = null) {
    const db = this.db;
    const cur = db.prepare('SELECT * FROM review_cards WHERE concept_id = ?').get(conceptId);
    if (!cur) throw new Error(`No review card for knowledge point ${conceptId}`);
    const { card } = fsrsReview(cardFromRow(cur), rating, at);
    const c = rowFromCard(card);
    db.prepare(`UPDATE review_cards SET due_at = ?, stability = ?, difficulty = ?, reps = ?, lapses = ?, state = ?, last_review_at = ?, scheduled_days = ?,
      learning_steps = ?, revision = revision + 1, updated_at = ?, source = COALESCE(source, 'review') WHERE id = ? AND revision = ?`)
      .run(c.due_at, c.stability, c.difficulty, c.reps, c.lapses, c.state, c.last_review_at, c.scheduled_days, c.learning_steps, this.now(), cur.id, cur.revision);
    db.prepare(`INSERT INTO review_logs (id, card_id, concept_id, rating, reviewed_at, assessment_id, actor, state_before, prev_due, next_due, scheduled_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`rl-${randomUUID()}`, cur.id, conceptId, rating, at.toISOString(), assessmentId, actor, cur.state,
      cur.state === 'new' ? null : cur.due_at, c.due_at, c.scheduled_days);
    return db.prepare('SELECT * FROM v_review_cards WHERE id = ?').get(cur.id);
  }
  /**
   * Rate a review card (learner from the workbench, or the AI after a real learner answer).
   * input: { conceptId | cardId, rating 1..4, baseRevision (the card's own revision) }. A stale baseRevision is a
   * conflict (the schedule is never overwritten from an old screen). Bumps the global revision and logs review.rate.
   */
  async review(input = {}, { actor = 'learner' } = {}) {
    this.open();
    if (!ACTORS.includes(actor)) throw new Error('actor must be learner or ai');
    const db = this.db;
    return this.#tx(() => {
      const cur = input.cardId ? db.prepare('SELECT * FROM review_cards WHERE id = ?').get(String(input.cardId))
        : db.prepare('SELECT * FROM review_cards WHERE concept_id = ?').get(String(input.conceptId ?? ''));
      if (!cur) throw new Error(`Unknown review card for ${input.cardId ?? input.conceptId}`);
      const live = db.prepare('SELECT concept_title AS title FROM v_review_cards WHERE id = ?').get(cur.id);
      if (!live) throw new Error('This knowledge point is no longer in the outline');
      if (!Number.isInteger(input.baseRevision)) throw new Error('baseRevision (the review card revision you read) is required');
      if (input.baseRevision !== cur.revision) throw conflict(`Review card changed (revision ${cur.revision}); read it again`, { reviewRevision: cur.revision });
      const rating = Number(input.rating);
      if (![1, 2, 3, 4].includes(rating)) throw new Error('rating must be 1 (忘了) | 2 (吃力) | 3 (想起来了) | 4 (轻松)');
      const row = this.#applyReview(cur.concept_id, rating, new Date(this.now()), actor);
      const d = new Date(row.due_at);
      const revision = this.#bump('review.rate', actor, cur.id,
        `${actor === 'learner' ? '你' : 'AI'}复习「${live.title}」：${RATING_LABEL[rating]}（下次 ${d.getMonth() + 1}月${d.getDate()}日）${typeof input.note === 'string' && input.note.trim() ? ` · 依据：${input.note.trim().slice(0, 80)}` : ''}`);
      return { revision, card: { ...row } };
    });
  }

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
      case 'reviews': return plain(db.prepare("SELECT * FROM v_review_cards WHERE course_id = ? ORDER BY state = 'new', due_at, topic_index, sub_index").all(courseId));
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
        // lessons that teach it (lesson.conceptIds), then lessons that only show up through an attempt (older lessons)
        const taught = plain(db.prepare(`SELECT l.lesson_id, l.title, l.phase, l.status, l.created_at, 'plan' AS via FROM v_lessons l
          WHERE l.course_id = ? AND EXISTS (SELECT 1 FROM v_lesson_concepts lc WHERE lc.lesson_id = l.lesson_id AND lc.concept_id = ?) ORDER BY l.created_at`).all(courseId, id));
        const byAttempt = plain(db.prepare(`SELECT DISTINCT l.lesson_id, l.title, l.phase, l.status, l.created_at, 'attempt' AS via FROM v_lessons l
          JOIN assessments a ON a.lesson_id = l.lesson_id WHERE a.concept_id = ? ORDER BY l.created_at`).all(id)).filter((r) => !taught.some((t) => t.lesson_id === r.lesson_id));
        const notes = plain(db.prepare(`SELECT n.note_id, n.lesson_id, n.title, n.author, n.excerpt, n.created_at FROM v_notes n
          WHERE EXISTS (SELECT 1 FROM v_note_concepts nc WHERE nc.note_id = n.note_id AND nc.concept_id = ?) ORDER BY n.created_at DESC`).all(id));
        const noteCards = plain(db.prepare(`SELECT e.id AS element_id, json_extract(e.doc, '$.noteId') AS note_id FROM board_elements e
          WHERE e.course_id = ? AND e.deleted = 0 AND e.type = 'note' AND json_extract(e.doc, '$.noteId') IN (SELECT note_id FROM v_note_concepts WHERE concept_id = ?) ORDER BY e.ord`).all(courseId, id));
        return { ...kp, board_cards: JSON.parse(kp.board_cards ?? '[]'), concept, relations, attempts, todos, review: this.#reviewDetail(id),
          lessons: [...taught, ...byAttempt], notes, note_cards: noteCards };
      }
      default: throw new Error(`Unknown data query: ${name}`);
    }
  }

  #reviewDetail(conceptId) {
    const db = this.db;
    const raw = db.prepare('SELECT * FROM review_cards WHERE concept_id = ?').get(conceptId);
    if (!raw) return null;
    const card = { ...db.prepare('SELECT * FROM v_review_cards WHERE id = ?').get(raw.id) };
    const logs = db.prepare('SELECT * FROM v_review_logs WHERE card_id = ? ORDER BY reviewed_at DESC LIMIT 20').all(raw.id).map((r) => ({ ...r }));
    return { card, logs, preview: fsrsPreview(cardFromRow(raw), new Date(this.now())) };
  }

  // ---------- model-facing read-only SQL (tutor_table_query) ----------
  static QUERYABLE = Object.freeze(['v_knowledge_points', 'v_outline', 'v_board_cards', 'v_attempts', 'v_questions', 'v_todos', 'v_events', 'v_review_cards', 'v_review_logs',
    'v_lessons', 'v_lesson_concepts', 'v_notes', 'v_note_concepts', 'v_sources', 'v_source_refs', 'v_syllabus_changes']);
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
