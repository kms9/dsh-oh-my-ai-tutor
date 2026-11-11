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
export function newState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, goals: {}, courses: {}, concepts: {},
    lessons: {}, relations: {}, notes: {}, assessments: {}, sources: {}, events: [] };
}
export function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new Error('Unsupported or corrupt tutor state');
  for (const key of ['goals', 'courses', 'concepts', 'lessons', 'relations', 'notes', 'assessments', 'sources'])
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Missing ${key}`);
  if (!Array.isArray(state.events)) throw new Error('Missing event ledger');
  return state;
}

/** Pure transactional state transition. Never infer learner answers or mastery from reading completion. */
export function transition(original, action, input = {}, opts = {}) {
  validateState(original);
  const s = clone(original);
  const now = opts.now ?? iso();
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
        kind: ['file', 'web', 'video', 'note', 'other'].includes(payload.kind) ? payload.kind : 'other',
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
      course.syllabus = { topics, revision: course.syllabus.revision + 1, approvedAt: null };
      course.status = 'draft'; course.updatedAt = now;
      result = { courseId: course.id, syllabus: course.syllabus }; break;
    }
    case 'course.approve': {
      const course = requireId(s, 'courses', payload.courseId);
      if (!course.syllabus.topics.length) throw new Error('Cannot approve an empty syllabus');
      course.status = 'active'; course.syllabus.approvedAt = now; course.updatedAt = now;
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
        author: payload.author === 'learner' ? 'learner' : 'ai',
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
    default: throw new Error(`Unknown tutor action: ${action}`);
  }
  s.revision = original.revision + 1;
  s.events.push({ revision: s.revision, at: now, action,
    entityId: result?.id ?? result?.lessonId ?? result?.courseId ?? null });
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
    assessments: Object.values(state.assessments).filter(x => state.lessons[x.lessonId]?.courseId === courseId) };
}
