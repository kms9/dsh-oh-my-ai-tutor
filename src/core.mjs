import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const EDGE_TYPES = Object.freeze([
  'prerequisite', 'partOf', 'explains', 'contrasts', 'applies', 'exampleOf', 'relatedTo',
]);
const EDGE_SET = new Set(EDGE_TYPES);
const iso = () => new Date().toISOString();
const clone = (v) => structuredClone(v);
const id = (prefix) => `${prefix}-${randomUUID()}`;
const has = (x, key) => Object.prototype.hasOwnProperty.call(x, key);

function requireText(value, field, max = 5000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} must be a non-empty string (max ${max})`);
  return value.trim();
}
function requireId(state, kind, value) {
  const record = state[kind][value];
  if (!record) throw new Error(`Unknown ${kind} id: ${value}`);
  return record;
}
function unique(items, field) {
  const set = new Set();
  for (const item of items) {
    if (set.has(item[field])) throw new Error(`Duplicate ${field}: ${item[field]}`);
    set.add(item[field]);
  }
}
function normalizeTopics(topics, oldTopics = []) {
  if (!Array.isArray(topics) || !topics.length || topics.length > 40) throw new Error('topics must contain 1..40 items');
  const oldById = new Map(oldTopics.map((t) => [t.id, t]));
  const updated = topics.map((t) => {
    const old = t.id ? oldById.get(t.id) : null;
    if (t.id && !old) throw new Error('Unknown topic ID; add new topics without an id');
    if (!Array.isArray(t.subtopics) || !t.subtopics.length || t.subtopics.length > 60) throw new Error('Each topic needs 1..60 subtopics');
    const prevSubs = new Map((old?.subtopics ?? []).map((s) => [s.id, s]));
    const subtopics = t.subtopics.map((s) => {
      const prev = s.id ? prevSubs.get(s.id) : null;
      if (s.id && !prev) throw new Error('Unknown subtopic ID; add new subtopics without an id');
      return {
        id: prev?.id ?? id('sub'), title: requireText(s.title, 'subtopic.title', 160),
        description: typeof s.description === 'string' ? s.description.slice(0, 1500) : (prev?.description ?? ''),
        conceptId: prev?.conceptId ?? id('kp'),
      };
    });
    unique(subtopics, 'id');
    return { id: old?.id ?? id('topic'), title: requireText(t.title, 'topic.title', 160),
      description: typeof t.description === 'string' ? t.description.slice(0, 1500) : (old?.description ?? ''), subtopics };
  });
  unique(updated, 'id');
  return updated;
}
function wouldCycle(relations, source, target, type) {
  if (source === target) return true;
  const adjacency = new Map();
  for (const r of Object.values(relations)) {
    if (r.type !== type) continue;
    const targets = adjacency.get(r.from) ?? [];
    targets.push(r.to);
    adjacency.set(r.from, targets);
  }
  const seen = new Set(), stack = [target];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adjacency.get(cur) ?? []) stack.push(next);
  }
  return false;
}
export const SOURCE_KINDS = Object.freeze(['file', 'web', 'video', 'note', 'other']);
export const OUTLINE_OPS = Object.freeze([
  'addTopic', 'renameTopic', 'moveTopic', 'removeTopic',
  'addSubtopic', 'renameSubtopic', 'moveSubtopic', 'removeSubtopic',
]);
export const BOARD_ELEMENT_TYPES = Object.freeze(['concept', 'note', 'arrow']);
export const ACTORS = Object.freeze(['ai', 'learner']);
const MAX_BOARD_ELEMENTS = 2000;
const BOARD_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** Write a normalized topic tree into the course, keeping concept ids (and their evidence) stable. */
function applySyllabus(s, course, topics, now) {
  const activeIds = new Set();
  for (const t of topics) for (const sub of t.subtopics) {
    activeIds.add(sub.conceptId);
    const old = s.concepts[sub.conceptId];
    s.concepts[sub.conceptId] = { id: sub.conceptId, courseId: course.id, topicId: t.id, subtopicId: sub.id,
      title: sub.title, description: sub.description, status: 'active',
      evidenceRefs: old?.evidenceRefs ?? [], mastery: old?.mastery ?? 'unverified', updatedAt: now };
  }
  for (const concept of Object.values(s.concepts))
    if (concept.courseId === course.id && !activeIds.has(concept.id)) concept.status = 'retired';
  // Any syllabus change re-opens the learner approval gate (same rule as course.plan).
  course.syllabus = { topics, revision: course.syllabus.revision + 1, approvedAt: null, approvedBy: null };
  course.status = 'draft'; course.updatedAt = now;
}

function clampIndex(value, length, field) {
  if (value === undefined || value === null) return length;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return Math.min(value, length);
}
function optionalText(value, field, max) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be a string (max ${max})`);
  return value;
}

/** Fine-grained outline edits (shared by learner UI drag/rename/delete and AI tool calls). */
function editOutline(oldTopics, operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new Error('operations must contain 1..100 items');
  const topics = oldTopics.map((t) => ({ ...t, subtopics: t.subtopics.map((x) => ({ ...x })) }));
  const findTopic = (topicId) => {
    const index = topics.findIndex((t) => t.id === topicId);
    if (index < 0) throw new Error(`Unknown topicId: ${topicId}. Read the outline first and use the ids it returns.`);
    return index;
  };
  const findSub = (subtopicId) => {
    for (let ti = 0; ti < topics.length; ti++) {
      const si = topics[ti].subtopics.findIndex((x) => x.id === subtopicId);
      if (si >= 0) return [ti, si];
    }
    throw new Error(`Unknown subtopicId: ${subtopicId}. Read the outline first and use the ids it returns.`);
  };
  const newSub = (x, field) => {
    if (!x || typeof x !== 'object') throw new Error(`${field} must be an object`);
    if (x.id !== undefined) throw new Error('New subtopics must not carry an id; the store assigns one');
    return { id: id('sub'), title: requireText(x.title, `${field}.title`, 160),
      description: optionalText(x.description, `${field}.description`, 1500) ?? '', conceptId: id('kp') };
  };
  operations.forEach((op, n) => {
    if (!op || typeof op !== 'object' || !OUTLINE_OPS.includes(op.op)) throw new Error(`operations[${n}].op must be one of ${OUTLINE_OPS.join(', ')}`);
    switch (op.op) {
      case 'addTopic': {
        if (op.id !== undefined || op.topicId !== undefined) throw new Error('addTopic must not carry an id; the store assigns one');
        const subs = Array.isArray(op.subtopics) && op.subtopics.length ? op.subtopics : null;
        if (!subs) throw new Error('addTopic needs subtopics: [{title}] (a topic must contain at least one knowledge point)');
        const topic = { id: id('topic'), title: requireText(op.title, 'addTopic.title', 160),
          description: optionalText(op.description, 'addTopic.description', 1500) ?? '',
          subtopics: subs.map((x, i) => newSub(x, `addTopic.subtopics[${i}]`)) };
        topics.splice(clampIndex(op.index, topics.length, 'addTopic.index'), 0, topic); break;
      }
      case 'renameTopic': {
        const t = topics[findTopic(op.topicId)];
        if (op.title === undefined && op.description === undefined) throw new Error('renameTopic needs title or description');
        if (op.title !== undefined) t.title = requireText(op.title, 'renameTopic.title', 160);
        if (op.description !== undefined) t.description = optionalText(op.description, 'renameTopic.description', 1500);
        break;
      }
      case 'moveTopic': {
        const from = findTopic(op.topicId);
        const [t] = topics.splice(from, 1);
        topics.splice(clampIndex(op.toIndex, topics.length, 'moveTopic.toIndex'), 0, t); break;
      }
      case 'removeTopic': {
        topics.splice(findTopic(op.topicId), 1); break;
      }
      case 'addSubtopic': {
        const t = topics[findTopic(op.topicId)];
        t.subtopics.splice(clampIndex(op.index, t.subtopics.length, 'addSubtopic.index'), 0, newSub(op, 'addSubtopic')); break;
      }
      case 'renameSubtopic': {
        const [ti, si] = findSub(op.subtopicId);
        const x = topics[ti].subtopics[si];
        if (op.title === undefined && op.description === undefined) throw new Error('renameSubtopic needs title or description');
        if (op.title !== undefined) x.title = requireText(op.title, 'renameSubtopic.title', 160);
        if (op.description !== undefined) x.description = optionalText(op.description, 'renameSubtopic.description', 1500);
        break;
      }
      case 'moveSubtopic': {
        const [ti, si] = findSub(op.subtopicId);
        const target = op.toTopicId === undefined ? ti : findTopic(op.toTopicId);
        const [x] = topics[ti].subtopics.splice(si, 1);
        topics[target].subtopics.splice(clampIndex(op.toIndex, topics[target].subtopics.length, 'moveSubtopic.toIndex'), 0, x);
        break;
      }
      case 'removeSubtopic': {
        const [ti, si] = findSub(op.subtopicId);
        topics[ti].subtopics.splice(si, 1); break;
      }
    }
  });
  if (!topics.length || topics.length > 40) throw new Error('An outline must keep 1..40 topics');
  for (const t of topics) {
    if (!t.subtopics.length) throw new Error(`Topic "${t.title}" would have no knowledge points; remove the topic instead`);
    if (t.subtopics.length > 60) throw new Error('Each topic needs 1..60 subtopics');
  }
  unique(topics, 'id'); unique(topics.flatMap((t) => t.subtopics), 'id');
  return topics;
}

function finiteNumber(value, field, min = -100_000, max = 100_000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${field} must be a number in [${min}, ${max}]`);
  return Math.round(n * 10) / 10;
}
function boardOf(s, courseId) {
  return s.boards[courseId] ?? { courseId, revision: 0, elements: [] };
}
const CARD = { width: 196, height: 72 };
/** Deterministic grouped layout: one column per syllabus topic, cards stacked by subtopic order. */
export function boardLayoutFor(course, conceptId) {
  const topics = course.syllabus.topics;
  for (let ti = 0; ti < topics.length; ti++) {
    const si = topics[ti].subtopics.findIndex((x) => x.conceptId === conceptId);
    if (si >= 0) return { x: 40 + ti * 236, y: 40 + si * 104 };
  }
  return { x: 40, y: 40 };
}
function boardPatch(s, course, board, operations, now, actor, maxOps = 100) {
  if (!Array.isArray(operations) || !operations.length || operations.length > maxOps) throw new Error(`operations must contain 1..${maxOps} items`);
  const elements = board.elements.map((e) => ({ ...e }));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const live = (eid) => { const e = byId.get(eid); return e && !e.deleted ? e : null; };
  const touched = [];
  operations.forEach((op, n) => {
    if (!op || typeof op !== 'object' || !['add', 'update', 'delete'].includes(op.op)) throw new Error(`operations[${n}].op must be add | update | delete`);
    if (op.op === 'add') {
      if (!BOARD_ELEMENT_TYPES.includes(op.type)) throw new Error(`operations[${n}].type must be one of ${BOARD_ELEMENT_TYPES.join(', ')}`);
      const eid = op.id === undefined ? id(op.type === 'arrow' ? 'arrow' : op.type === 'note' ? 'note' : 'card') : op.id;
      if (typeof eid !== 'string' || !BOARD_ID_RE.test(eid)) throw new Error(`operations[${n}].id must match ${BOARD_ID_RE}`);
      if (byId.has(eid)) throw new Error(`Element id already used (ids are never reused): ${eid}`);
      const base = { id: eid, type: op.type, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now };
      let el;
      if (op.type === 'arrow') {
        const from = live(op.from), to = live(op.to);
        if (!from || !to || from.type === 'arrow' || to.type === 'arrow') throw new Error('Arrow needs from/to ids of live cards on this board (add cards first)');
        if (from.id === to.id) throw new Error('Arrow cannot connect a card to itself');
        el = { ...base, from: from.id, to: to.id, label: optionalText(op.label, 'arrow.label', 80) ?? '' };
        if (op.relationId !== undefined) {
          const r = s.relations[op.relationId];
          if (!r || r.courseId !== course.id) throw new Error(`Unknown relationId: ${op.relationId}`);
          el.relationId = r.id;
        }
      } else {
        let text = '';
        let conceptId;
        if (op.type === 'concept') {
          const concept = s.concepts[op.conceptId];
          if (!concept || concept.courseId !== course.id || concept.status !== 'active') throw new Error(`Unknown or retired conceptId for this course: ${op.conceptId}`);
          if (elements.some((e) => !e.deleted && e.type === 'concept' && e.conceptId === concept.id)) throw new Error(`Concept already on board: ${concept.title}`);
          conceptId = concept.id;
        } else text = requireText(op.text, 'note.text', 500);
        const pos = conceptId ? boardLayoutFor(course, conceptId) : { x: 40, y: 40 };
        el = { ...base, ...(conceptId ? { conceptId } : { text }),
          x: op.x === undefined ? pos.x : finiteNumber(op.x, 'x'), y: op.y === undefined ? pos.y : finiteNumber(op.y, 'y'),
          width: op.width === undefined ? CARD.width : finiteNumber(op.width, 'width', 60, 800),
          height: op.height === undefined ? CARD.height : finiteNumber(op.height, 'height', 40, 600),
          color: optionalText(op.color, 'color', 24) ?? '' };
      }
      elements.push(el); byId.set(eid, el); touched.push(eid);
    } else {
      const el = live(op.id);
      if (!el) throw new Error(`Unknown or deleted element id: ${op.id}. Read the board first.`);
      if (op.op === 'delete') {
        el.deleted = true; el.updatedAt = now; el.updatedBy = actor; touched.push(el.id);
        if (el.type !== 'arrow') for (const a of elements) if (!a.deleted && a.type === 'arrow' && (a.from === el.id || a.to === el.id)) {
          a.deleted = true; a.updatedAt = now; a.updatedBy = actor; touched.push(a.id);
        }
      } else {
        const fields = ['x', 'y', 'width', 'height', 'text', 'color', 'label'].filter((k) => op[k] !== undefined);
        if (!fields.length) throw new Error('update needs at least one of x, y, width, height, text, color, label');
        if (el.type === 'arrow') {
          if (fields.some((k) => k !== 'label' && k !== 'color')) throw new Error('Arrows only accept label/color updates; delete and re-add to reconnect');
        } else if (op.label !== undefined) throw new Error('label is only for arrows');
        if (op.text !== undefined) {
          if (el.type !== 'note') throw new Error('Concept card text follows the syllabus; rename the subtopic instead');
          el.text = requireText(op.text, 'note.text', 500);
        }
        if (op.x !== undefined) el.x = finiteNumber(op.x, 'x');
        if (op.y !== undefined) el.y = finiteNumber(op.y, 'y');
        if (op.width !== undefined) el.width = finiteNumber(op.width, 'width', 60, 800);
        if (op.height !== undefined) el.height = finiteNumber(op.height, 'height', 40, 600);
        if (op.color !== undefined) el.color = optionalText(op.color, 'color', 24);
        if (op.label !== undefined) el.label = optionalText(op.label, 'arrow.label', 80);
        el.updatedAt = now; el.updatedBy = actor; touched.push(el.id);
      }
    }
  });
  if (elements.length > MAX_BOARD_ELEMENTS) throw new Error(`Board limit is ${MAX_BOARD_ELEMENTS} elements including tombstones`);
  return { courseId: course.id, revision: board.revision + 1, elements, updatedAt: now, touched };
}

export function newState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, goals: {}, courses: {}, concepts: {},
    lessons: {}, relations: {}, notes: {}, assessments: {}, sources: {}, boards: {}, events: [] };
}
export function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new Error('Unsupported or corrupt tutor state');
  for (const key of ['goals', 'courses', 'concepts', 'lessons', 'relations', 'notes', 'assessments', 'sources'])
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Missing ${key}`);
  if (!Array.isArray(state.events)) throw new Error('Missing event ledger');
  // `boards` was added after schema v1 shipped; older files simply have no boards yet.
  if (state.boards !== undefined && (!state.boards || typeof state.boards !== 'object' || Array.isArray(state.boards)))
    throw new Error('Corrupt boards');
  return state;
}

/** Pure transactional state transition. Never infer learner answers or mastery from reading completion. */
export function transition(original, action, input = {}, opts = {}) {
  validateState(original);
  const s = clone(original);
  if (!s.boards) s.boards = {};
  const now = opts.now ?? iso();
  const actor = ACTORS.includes(opts.actor) ? opts.actor : 'ai';
  const payload = input ?? {};
  let result;
  switch (action) {
    case 'goal.create': {
      const item = { id: id('goal'), title: requireText(payload.title, 'title', 160),
        expectedOutcome: requireText(payload.expectedOutcome, 'expectedOutcome'), createdAt: now, updatedAt: now };
      s.goals[item.id] = item; result = item; break;
    }
    case 'course.create': {
      requireId(s, 'goals', payload.goalId);
      const item = { id: id('course'), goalId: payload.goalId, title: requireText(payload.title, 'title', 160),
        status: 'draft', sourceIds: [], syllabus: { topics: [], revision: 0, approvedAt: null }, createdAt: now, updatedAt: now };
      s.courses[item.id] = item; result = item; break;
    }
    case 'source.register': {
      const source = { id: id('source'), title: requireText(payload.title, 'source.title', 300),
        uri: requireText(payload.uri, 'source.uri', 4096),
        kind: SOURCE_KINDS.includes(payload.kind) ? payload.kind : 'other',
        ...(payload.kind !== undefined && !SOURCE_KINDS.includes(payload.kind) ? { requestedKind: String(payload.kind).slice(0, 40) } : {}),
        access: 'unverified', createdAt: now };
      s.sources[source.id] = source; result = source; break;
    }
    case 'course.linkSource': {
      const course = requireId(s, 'courses', payload.courseId);
      requireId(s, 'sources', payload.sourceId);
      if (!course.sourceIds.includes(payload.sourceId)) course.sourceIds.push(payload.sourceId);
      course.updatedAt = now;
      result = { courseId: course.id, sourceIds: course.sourceIds }; break;
    }
    case 'course.plan': {
      const course = requireId(s, 'courses', payload.courseId);
      const topics = normalizeTopics(payload.topics, course.syllabus.topics);
      applySyllabus(s, course, topics, now);
      result = { courseId: course.id, syllabus: course.syllabus }; break;
    }
    case 'course.editOutline': {
      const course = requireId(s, 'courses', payload.courseId);
      if (payload.syllabusRevision !== undefined && payload.syllabusRevision !== course.syllabus.revision)
        throw Object.assign(new Error(`Outline changed (syllabus revision ${course.syllabus.revision}); read it again`), { code: 'conflict' });
      const topics = editOutline(course.syllabus.topics, payload.operations);
      applySyllabus(s, course, topics, now);
      result = { courseId: course.id, syllabus: course.syllabus, applied: payload.operations.length }; break;
    }
    case 'course.approve': {
      const course = requireId(s, 'courses', payload.courseId);
      if (!course.syllabus.topics.length) throw new Error('Cannot approve an empty syllabus');
      course.status = 'active'; course.syllabus.approvedAt = now; course.syllabus.approvedBy = actor; course.updatedAt = now;
      result = { courseId: course.id, status: course.status, syllabusRevision: course.syllabus.revision }; break;
    }
    case 'lesson.create': {
      const course = requireId(s, 'courses', payload.courseId);
      if (course.status !== 'active') throw new Error('Approve course syllabus before creating a lesson');
      if (!Array.isArray(payload.parts) || payload.parts.length < 1 || payload.parts.length > 8) throw new Error('parts must contain 1..8 items');
      const item = { id: id('lesson'), courseId: course.id, title: requireText(payload.title, 'title', 160),
        status: 'planned', phase: 'plan_pending', activePartIndex: 0,
        parts: payload.parts.map((p, i) => ({ id: id('part'), index: i, title: requireText(p.title, 'part.title', 160),
          objective: requireText(p.objective, 'part.objective', 2000), status: 'not_started', body: null, sourceRefs: [] })),
        createdAt: now, updatedAt: now };
      s.lessons[item.id] = item; result = item; break;
    }
    case 'lesson.approve': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'plan_pending') throw new Error('Lesson plan is not awaiting approval');
      lesson.phase = 'teaching'; lesson.status = 'in_progress'; lesson.parts[0].status = 'in_progress'; lesson.updatedAt = now;
      result = { lessonId: lesson.id, phase: lesson.phase, current: lesson.parts[0] }; break;
    }
    case 'lesson.partWrite': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'teaching' || lesson.activePartIndex !== payload.partIndex)
        throw new Error('Can only write the current teaching part');
      const part = lesson.parts[payload.partIndex];
      part.body = requireText(payload.body, 'part.body', 60000);
      part.sourceRefs = Array.isArray(payload.sourceRefs) ? payload.sourceRefs.filter(x => typeof x === 'string').slice(0, 100) : [];
      lesson.updatedAt = now;
      result = { lessonId: lesson.id, partIndex: payload.partIndex, stored: true }; break;
    }
    case 'lesson.cover': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'teaching' || lesson.activePartIndex !== payload.partIndex) throw new Error('Wrong teaching phase or part index');
      if (!lesson.parts[payload.partIndex].body) throw new Error('Cannot cover a part without saved teaching content');
      lesson.parts[payload.partIndex].status = 'covered';
      if (payload.partIndex + 1 < lesson.parts.length) {
        lesson.activePartIndex++;
        lesson.parts[lesson.activePartIndex].status = 'in_progress';
      } else lesson.phase = 'review_pending';
      lesson.updatedAt = now;
      result = { lessonId: lesson.id, phase: lesson.phase, activePartIndex: lesson.activePartIndex }; break;
    }
    case 'assessment.record': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const concept = requireId(s, 'concepts', payload.conceptId);
      if (lesson.courseId !== concept.courseId) throw new Error('Assessment concept not in lesson course');
      if (!['review_pending', 'teaching'].includes(lesson.phase)) throw new Error('Assessment not allowed in this phase');
      const score = Number(payload.score), hintCount = Number(payload.hintCount ?? 0);
      if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('score must be between 0 and 1');
      if (!Number.isInteger(hintCount) || hintCount < 0 || hintCount > 10) throw new Error('hintCount must be 0..10');
      const record = { id: id('assess'), lessonId: lesson.id, conceptId: concept.id,
        question: requireText(payload.question, 'question'), studentAnswer: requireText(payload.studentAnswer, 'studentAnswer'),
        feedback: requireText(payload.feedback, 'feedback'), score, hintCount,
        transfer: payload.transfer === true, judgedBy: 'model-unverified', recordedAt: now };
      s.assessments[record.id] = record;
      // Provisional evidence level only; never claim calibrated mastery probability.
      concept.mastery = score >= 0.8 && record.transfer && hintCount === 0 ? 'demonstrated' : 'developing';
      concept.updatedAt = now;
      result = { assessment: record, provisionalMastery: concept.mastery }; break;
    }
    case 'lesson.reviewEnd': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'review_pending') throw new Error('Review not pending');
      if (payload.skipped !== true && !Object.values(s.assessments).some(a => a.lessonId === lesson.id))
        throw new Error('A review requires real learner answers, or explicitly skip it');
      lesson.phase = 'summary_pending'; lesson.reviewSkipped = payload.skipped === true; lesson.updatedAt = now;
      result = { lessonId: lesson.id, phase: lesson.phase, skipped: lesson.reviewSkipped }; break;
    }
    case 'note.add': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const note = { id: id('note'), courseId: lesson.courseId, lessonId: lesson.id,
        title: requireText(payload.title, 'note.title', 160), content: requireText(payload.content, 'note.content', 50_000),
        author: actor === 'learner' || payload.author === 'learner' ? 'learner' : 'ai',
        sourceRefs: Array.isArray(payload.sourceRefs) ? payload.sourceRefs.filter(x => typeof x === 'string').slice(0, 100) : [],
        createdAt: now };
      s.notes[note.id] = note; result = note; break;
    }
    case 'lesson.finish': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'summary_pending') throw new Error('Finish only after review choice');
      if (!Object.values(s.notes).some(note => note.lessonId === lesson.id) && payload.skipNotes !== true)
        throw new Error('Create a lesson note or explicitly skip notes');
      lesson.phase = 'complete'; lesson.status = 'complete'; lesson.updatedAt = now;
      result = { lessonId: lesson.id, status: lesson.status }; break;
    }
    case 'relation.propose': {
      const from = requireId(s, 'concepts', payload.from), to = requireId(s, 'concepts', payload.to);
      if (from.courseId !== to.courseId) throw new Error('Cross-course relation needs a dedicated merge/review workflow');
      if (!EDGE_SET.has(payload.type)) throw new Error(`Invalid relation type: ${payload.type}`);
      if (Object.values(s.relations).some(r => r.from === from.id && r.to === to.id && r.type === payload.type)) throw new Error('Duplicate relation');
      if (['prerequisite', 'partOf'].includes(payload.type) && wouldCycle(s.relations, from.id, to.id, payload.type)) throw new Error('Relation would create a cycle');
      if (from.id === to.id) throw new Error('Self relation is not allowed');
      const item = { id: id('rel'), courseId: from.courseId, from: from.id, to: to.id,
        type: payload.type, status: 'candidate', note: typeof payload.note === 'string' ? payload.note.slice(0, 1000) : '',
        evidenceRefs: Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs.filter(x => typeof x === 'string').slice(0, 50) : [],
        createdAt: now };
      s.relations[item.id] = item; result = item; break;
    }
    case 'board.seed': {
      const course = requireId(s, 'courses', payload.courseId);
      const board = boardOf(s, course.id);
      if (payload.baseRevision !== undefined && payload.baseRevision !== board.revision)
        throw Object.assign(new Error(`Board changed (latest revision ${board.revision}); read it again`), { code: 'conflict', boardRevision: board.revision });
      const used = new Set(board.elements.map((e) => e.id));
      const cards = new Map(board.elements.filter((e) => !e.deleted && e.type === 'concept').map((e) => [e.conceptId, e.id]));
      const ops = [];
      for (const t of course.syllabus.topics) for (const sub of t.subtopics) {
        if (cards.has(sub.conceptId) || s.concepts[sub.conceptId]?.status !== 'active') continue;
        let cid = `card-${sub.conceptId}`.slice(0, 120);
        if (used.has(cid)) cid = id('card');
        used.add(cid); cards.set(sub.conceptId, cid);
        ops.push({ op: 'add', type: 'concept', conceptId: sub.conceptId, id: cid });
      }
      // Candidate semantic relations are drawn once; a visual arrow never becomes a semantic edge by itself.
      const drawn = new Set(board.elements.filter((e) => e.type === 'arrow' && e.relationId).map((e) => e.relationId));
      for (const r of Object.values(s.relations))
        if (r.courseId === course.id && !drawn.has(r.id) && cards.has(r.from) && cards.has(r.to))
          ops.push({ op: 'add', type: 'arrow', from: cards.get(r.from), to: cards.get(r.to), label: r.type, relationId: r.id });
      if (!ops.length) { result = { courseId: course.id, revision: board.revision, added: 0 }; break; }
      const next = boardPatch(s, course, board, ops, now, actor, MAX_BOARD_ELEMENTS);
      delete next.touched;
      s.boards[course.id] = next;
      result = { courseId: course.id, revision: next.revision, added: ops.length }; break;
    }
    case 'board.patch': {
      const course = requireId(s, 'courses', payload.courseId);
      const board = boardOf(s, course.id);
      if (!Number.isInteger(payload.baseRevision)) throw new Error('baseRevision (board revision from tutor_board_read) is required');
      if (payload.baseRevision !== board.revision)
        throw Object.assign(new Error(`Board changed (latest revision ${board.revision}); read it again and re-evaluate against human edits`), { code: 'conflict', boardRevision: board.revision });
      const next = boardPatch(s, course, board, payload.operations, now, actor);
      const touched = next.touched; delete next.touched;
      s.boards[course.id] = next;
      result = { courseId: course.id, revision: next.revision, touched }; break;
    }
    default: throw new Error(`Unknown tutor action: ${action}`);
  }
  s.revision = original.revision + 1;
  s.events.push({ revision: s.revision, at: now, action, actor,
    entityId: result?.id ?? result?.lessonId ?? result?.courseId ?? null,
    ...(opts.summary ? { summary: String(opts.summary).slice(0, 200) } : {}) });
  return { state: s, result };
}

/** Minimal scoped read model; this is domain state, not the DSH Session transcript. */
export function snapshot(state, courseId) {
  validateState(state);
  if (!courseId) return { revision: state.revision, goals: Object.values(state.goals), courses: Object.values(state.courses) };
  const course = requireId(state, 'courses', courseId);
  return { revision: state.revision, course,
    concepts: Object.values(state.concepts).filter(x => x.courseId === courseId && x.status === 'active'),
    relations: Object.values(state.relations).filter(x => x.courseId === courseId),
    lessons: Object.values(state.lessons).filter(x => x.courseId === courseId),
    notes: Object.values(state.notes).filter(x => x.courseId === courseId),
    sources: (course.sourceIds ?? []).map(id => state.sources[id]).filter(Boolean),
    assessments: Object.values(state.assessments).filter(x => state.lessons[x.lessonId]?.courseId === courseId),
    board: liveBoard(state, course) };
}

/** Board read model: live elements only, concept cards resolved to their current syllabus title. */
export function liveBoard(state, course) {
  const board = state.boards?.[course.id] ?? { courseId: course.id, revision: 0, elements: [] };
  const live = board.elements.filter((e) => !e.deleted);
  const ids = new Set(live.map((e) => e.id));
  return { courseId: course.id, revision: board.revision,
    elements: live.filter((e) => e.type !== 'arrow' || (ids.has(e.from) && ids.has(e.to))).map((e) => {
      if (e.type !== 'concept') return e;
      const c = state.concepts[e.conceptId];
      return { ...e, text: c?.title ?? '(已删除的知识点)', mastery: c?.mastery ?? 'unverified', stale: !c || c.status !== 'active' };
    }) };
}
