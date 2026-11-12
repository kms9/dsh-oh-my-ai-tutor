import { randomUUID } from 'node:crypto';
import { BOARD_CARD, boardSeedPosition } from './board-layout.mjs';
import { collectBoardSeedOps } from './board-seed.mjs';
import { parseLocator, linksFor, refView } from './links.mjs';
import { diffOutline, diffLines } from './outline-diff.mjs';
import { questionSpec, gradeAnswer, expectedAnswer, isObjective, publicQuestion, redactAssessment, JUDGED_BY_KEY, JUDGED_BY_MODEL } from './grade.mjs';
import {
  subConceptIds, stampSubConcepts, originOf, mergeAnchors, conceptIdsFromAnchors, lessonIdFromAnchors,
  legacyAnchors, normalizeBelongsTo, normalizeAnchors, mindmapOf, mindmapHierarchy, buildMindmapFromSyllabus,
  ensureCanonicalGraphNode, resolveGraphEndpoint, conceptIdOfEndpoint, graphNodeForConcept,
  normalizeState, editMindmap, mindmapRootId, enrichMindmap, isMindmapSkeleton, titleKey,
  topicIdFromMindmapNode,
} from './resources.mjs';

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
      const inherited = subConceptIds(s).length ? subConceptIds(s) : subConceptIds(prev ?? {});
      const ids = inherited.length ? inherited : [id('kp')];
      return stampSubConcepts({
        id: prev?.id ?? id('sub'), title: requireText(s.title, 'subtopic.title', 160),
        description: typeof s.description === 'string' ? s.description.slice(0, 1500) : (prev?.description ?? ''),
      }, ids);
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
function applySyllabus(s, course, topics, now, change = {}) {
  const entries = diffOutline(course.syllabus.topics, topics);
  const adjusting = Object.values(s.lessons).find((l) => l.courseId === course.id && l.phase === 'plan_adjustment_pending');
  const record = { fromRevision: course.syllabus.revision, toRevision: course.syllabus.revision + 1, at: now, actor: change.actor ?? 'ai',
    via: change.via ?? 'edit', reason: change.reason ?? '', entries, lines: diffLines(entries),
    ...(adjusting ? { forLessonId: adjusting.id } : {}) };
  course.syllabusChanges = [...(course.syllabusChanges ?? []), record].slice(-MAX_CHANGES);
  // Concepts are an independent pool: a syllabus entry *references* them. Unmentioned concepts stay active.
  for (const t of topics) for (const sub of t.subtopics) {
    let ids = subConceptIds(sub);
    if (!ids.length) ids = [id('kp')];
    for (const cid of ids) {
      const old = s.concepts[cid];
      if (!old) {
        s.concepts[cid] = { id: cid, courseId: course.id, topicId: t.id, subtopicId: sub.id,
          title: sub.title, description: sub.description ?? '', status: 'active',
          evidenceRefs: [], mastery: 'unverified', updatedAt: now,
          origin: originOf('authoring', change.actor ?? 'ai', now) };
      } else {
        old.topicId = t.id;
        old.subtopicId = sub.id;
        if (old.status === 'retired') old.status = 'active';
        old.updatedAt = now;
      }
      ensureCanonicalGraphNode(s, s.concepts[cid], { now, actor: change.actor });
    }
    stampSubConcepts(sub, ids);
  }
  const existing = s.mindmaps[course.id];
  const unused = !existing || ((existing.revision ?? 1) <= 1 && Object.keys(existing.nodes ?? {}).length <= 1);
  if (unused) {
    s.mindmaps[course.id] = buildMindmapFromSyllabus({ ...course, syllabus: { ...(course.syllabus ?? {}), topics } }, { now, actor: change.actor ?? 'ai' });
  }
  // Any syllabus change re-opens the learner approval gate (same rule as course.plan).
  course.syllabus = { topics, revision: course.syllabus.revision + 1, approvedAt: null, approvedBy: null,
    ...(course.syllabus.lastApproved ? { lastApproved: course.syllabus.lastApproved } : {}) };
  course.status = 'draft'; course.updatedAt = now;
  return record;
}

/** Outline changes since the last approved version (null when it was never approved with a snapshot). */
export function sinceApproved(course) {
  const last = course?.syllabus?.lastApproved;
  if (!last?.topics) return null;
  if (course.status === 'active' && course.syllabus.approvedAt && last.revision === course.syllabus.revision) return { approvedRevision: last.revision, lines: [], entries: [] };
  const entries = diffOutline(last.topics, course.syllabus.topics);
  return { approvedRevision: last.revision, approvedBy: last.by, approvedAt: last.at, entries, lines: diffLines(entries) };
}

const MAX_CHANGES = 30;
/** Validate knowledge point ids of one course (active ones only, de-duplicated, order kept). */
function courseConcepts(s, courseId, ids, field, { allowRetired = false } = {}) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 60) throw new Error(`${field} must be an array of at most 60 knowledge point ids`);
  const out = [];
  for (const cid of ids) {
    const c = typeof cid === 'string' ? s.concepts[cid] : null;
    if (!c || c.courseId !== courseId) throw new Error(`${field}: unknown knowledge point for this course: ${cid} (ids come from tutor_visualize(outline) conceptId / tutor_read)`);
    if (c.status !== 'active' && !allowRetired) throw new Error(`${field}: knowledge point 「${c.title}」 was removed from the outline`);
    if (!out.includes(c.id)) out.push(c.id);
  }
  return out;
}
function courseTopic(course, topicId, field) {
  if (topicId === undefined || topicId === null) return null;
  const t = course.syllabus.topics.find((x) => x.id === topicId);
  if (!t) throw new Error(`${field}: unknown topic id for this course: ${topicId} (topic ids come from tutor_visualize(outline))`);
  return t.id;
}
/**
 * Structured source references: [{sourceId, locator?, quote?}] where sourceId is a registered source (source.register).
 * "source-…#p.12" / "source-… @ 01:30" strings are accepted and converted; other free text is refused (old free-text
 * references already stored stay readable, see links.refView). A referenced source is linked to the course.
 */
export function normalizeSourceRefs(s, course, refs, field = 'sourceRefs') {
  if (refs === undefined || refs === null) return [];
  if (!Array.isArray(refs) || refs.length > 50) throw new Error(`${field} must be an array of at most 50 {sourceId, locator?} items`);
  return refs.map((r, i) => {
    let sourceId, locator, quote;
    if (typeof r === 'string') {
      const m = /^(source-[A-Za-z0-9-]{1,80})(?:\s*[#@|]\s*(.{1,120}))?$/.exec(r.trim());
      if (!m) throw new Error(`${field}[${i}]: a reference is {sourceId, locator?} pointing at a registered source (register it with source.register, then use the id it returns); free text like "${r.slice(0, 40)}" is not accepted`);
      [, sourceId, locator] = m;
    } else if (r && typeof r === 'object' && !Array.isArray(r)) ({ sourceId, locator, quote } = r);
    else throw new Error(`${field}[${i}] must be {sourceId, locator?, quote?}`);
    if (typeof sourceId !== 'string' || !s.sources[sourceId])
      throw new Error(`${field}[${i}].sourceId is not a registered source: ${sourceId}. Register it with source.register first and use the id it returns (never invent source ids).`);
    if (locator !== undefined && locator !== null && typeof locator !== 'string' && typeof locator !== 'number') throw new Error(`${field}[${i}].locator must be a string such as "p.12", "第3页", "01:30"`);
    const loc = parseLocator(locator === undefined || locator === null ? '' : String(locator));
    const q = quote === undefined || quote === null ? undefined : optionalText(String(quote), `${field}[${i}].quote`, 500);
    if (course && !course.sourceIds.includes(sourceId)) course.sourceIds.push(sourceId);
    return { sourceId, ...loc, ...(q ? { quote: q } : {}) };
  });
}
export const APPROVAL_MODES = Object.freeze(['learner', 'delegated']);
/**
 * Approvals: the learner (workbench button) or the AI. The AI approves only on the learner's say-so: either `consent`
 * (the learner's own words in this conversation, e.g. 「交给你」 / 「你批准吧」) or a standing delegation the learner gave
 * (course.setApproval mode 'delegated'). Either way it stays one explicit approve action with a revision check.
 */
function approvalConsent(course, actor, consent, what) {
  if (actor === 'learner') return null;
  const text = typeof consent === 'string' && consent.trim() ? consent.trim().slice(0, 300) : null;
  if (text) return text;
  if (course.approvalMode === 'delegated') return course.approvalDelegation?.consent ?? '学习者已委托 AI 批准';
  throw Object.assign(new Error(`The AI may approve the ${what} only when the learner asked for it: pass consent (the learner's words, e.g. 「交给你」), or have the learner delegate approvals (course.setApproval mode "delegated"). Otherwise show it and ask the learner to approve (批准 in the AI 学习工作台).`), { code: 'forbidden' });
}
function lessonPlanRevision(lesson) { return Number.isInteger(lesson.planRevision) ? lesson.planRevision : 1; }
function normalizeParts(s, course, parts) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 8) throw new Error('parts must contain 1..8 items');
  return parts.map((p, i) => ({ id: id('part'), index: i, title: requireText(p?.title, 'part.title', 160),
    objective: requireText(p?.objective, 'part.objective', 2000), status: 'not_started', body: null, sourceRefs: [],
    conceptIds: courseConcepts(s, course.id, p?.conceptIds, `parts[${i}].conceptIds`) }));
}
/** A lesson's topic and knowledge points: explicit ids, the parts' ids, and (topic only) that topic's live knowledge points. */
function lessonLinks(s, course, payload, parts) {
  const topicId = courseTopic(course, payload.topicId, 'topicId');
  let conceptIds = courseConcepts(s, course.id, payload.conceptIds, 'conceptIds');
  for (const p of parts) for (const c of p.conceptIds) if (!conceptIds.includes(c)) conceptIds.push(c);
  if (!conceptIds.length && topicId) conceptIds = course.syllabus.topics.find((t) => t.id === topicId).subtopics.map((x) => x.conceptId).filter((c) => s.concepts[c]?.status === 'active');
  return { topicId, conceptIds };
}

export const MAX_EVENTS = 2000;
function requireSyllabusRevision(course, value) {
  if (!Number.isInteger(value)) throw new Error(`syllabusRevision is required (current outline revision from tutor_visualize(outline) / tutor_read; now ${course.syllabus.revision})`);
  if (value !== course.syllabus.revision)
    throw Object.assign(new Error(`Outline changed (syllabus revision ${course.syllabus.revision}); read it again`), { code: 'conflict', syllabusRevision: course.syllabus.revision });
}
function requirePlanRevision(lesson, value, required) {
  const cur = lessonPlanRevision(lesson);
  if (value === undefined || value === null) { if (required) throw new Error(`planRevision is required (the lesson plan revision you showed the learner; now ${cur})`); return; }
  if (!Number.isInteger(value)) throw new Error('planRevision must be an integer');
  if (value !== cur) throw Object.assign(new Error(`Lesson plan changed (plan revision ${cur}); read it again`), { code: 'conflict', planRevision: cur });
}
/** course.plan never silently drops what the caller did not mention: unmentioned topics/subtopics are kept (remove them with tutor_outline_edit). */
function mergePlan(planned, oldTopics) {
  const kept = [];
  const mentioned = new Set(planned.map((t) => t.id));
  const topics = planned.map((t) => {
    const old = oldTopics.find((o) => o.id === t.id);
    if (!old) return t;
    const subIds = new Set(t.subtopics.map((x) => x.id));
    const extra = old.subtopics.filter((x) => !subIds.has(x.id));
    for (const x of extra) kept.push(x.id);
    return extra.length ? { ...t, subtopics: [...t.subtopics, ...extra.map((x) => ({ ...x }))] } : t;
  });
  for (const o of oldTopics) if (!mentioned.has(o.id)) { kept.push(o.id); topics.push({ ...o, subtopics: o.subtopics.map((x) => ({ ...x })) }); }
  return { topics, kept };
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
    const cid = id('kp');
    return stampSubConcepts({ id: id('sub'), title: requireText(x.title, `${field}.title`, 160),
      description: optionalText(x.description, `${field}.description`, 1500) ?? '', conceptId: cid }, [cid]);
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
        if (op.beforeId === op.topicId) break;
        const [t] = topics.splice(from, 1);
        let at;
        if (op.beforeId !== undefined) at = op.beforeId === null ? topics.length : findTopic(op.beforeId);
        else at = clampIndex(op.toIndex, topics.length, 'moveTopic.toIndex');
        topics.splice(at, 0, t); break;
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
        if (op.beforeId === op.subtopicId) break;
        let target = op.toTopicId === undefined ? ti : findTopic(op.toTopicId);
        if (op.beforeId != null) {
          const [bt] = findSub(op.beforeId);
          if (op.toTopicId !== undefined && bt !== target) throw new Error('beforeId must be a knowledge point inside toTopicId');
          target = bt;
        }
        const [x] = topics[ti].subtopics.splice(si, 1);
        const list = topics[target].subtopics;
        // beforeId is resolved AFTER removing the moved item, so dragging down inside one list never lands one slot late.
        const at = op.beforeId != null ? list.findIndex((y) => y.id === op.beforeId)
          : op.beforeId === null ? list.length : clampIndex(op.toIndex, list.length, 'moveSubtopic.toIndex');
        list.splice(at, 0, x);
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
/** Board coordinates: any finite number is accepted but clamped into the visible canvas quadrant [0, 20000]. */
function boardCoord(value, field) {
  const n = finiteNumber(value, field);
  return Math.min(20_000, Math.max(0, n));
}
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** Only plain hex colours reach CSS (no url(), no expressions). Empty string = default colour. */
function boardColor(value) {
  if (value === undefined) return undefined;
  if (value === '' ) return '';
  if (typeof value !== 'string' || !COLOR_RE.test(value)) throw new Error('color must be "#rgb", "#rrggbb" or ""');
  return value;
}
const REF_RE = /^[A-Za-z0-9_-]{1,40}$/;
function boardOf(s, courseId) {
  return s.boards[courseId] ?? { courseId, revision: 0, elements: [] };
}
const CARD = BOARD_CARD;

/** Create a candidate knowledge relation, or throw. Does not write to state. */
function buildCandidateRelation(s, payload, now) {
  const courseHint = payload.courseId ?? s.graphNodes[payload.from]?.courseId ?? s.concepts[payload.from]?.courseId
    ?? s.graphNodes[payload.to]?.courseId ?? s.concepts[payload.to]?.courseId;
  if (!courseHint) throw new Error('relation.propose needs from/to (graph node or knowledge point ids)');
  const from = resolveGraphEndpoint(s, courseHint, payload.from, 'from');
  const to = resolveGraphEndpoint(s, courseHint, payload.to, 'to');
  if (from.courseId !== to.courseId) throw new Error('Cross-course relation needs a dedicated merge/review workflow');
  if (!EDGE_SET.has(payload.type)) throw new Error(`Invalid relation type: ${payload.type}`);
  if (Object.values(s.relations).some(r => r.from === from.id && r.to === to.id && r.type === payload.type)) throw new Error('Duplicate relation');
  if (from.id === to.id) throw new Error('Self relation is not allowed');
  const fromConcept = from.refersTo ?? null, toConcept = to.refersTo ?? null;
  if (fromConcept && toConcept && fromConcept === toConcept) throw new Error('Self relation is not allowed');
  if (['prerequisite', 'partOf'].includes(payload.type)) {
    if (wouldCycle(s.relations, from.id, to.id, payload.type)) throw new Error('Relation would create a cycle');
    if (fromConcept && toConcept) {
      const byConcept = Object.fromEntries(Object.entries(s.relations).map(([k, r]) => [k, { ...r, from: r.fromConceptId ?? conceptIdOfEndpoint(s, r.from), to: r.toConceptId ?? conceptIdOfEndpoint(s, r.to) }]));
      if (wouldCycle(byConcept, fromConcept, toConcept, payload.type)) throw new Error('Relation would create a cycle');
    }
  }
  return { id: id('rel'), courseId: from.courseId, from: from.id, to: to.id,
    fromConceptId: fromConcept, toConceptId: toConcept,
    type: payload.type, status: 'candidate', note: typeof payload.note === 'string' ? payload.note.slice(0, 1000) : '',
    evidenceRefs: Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs.filter(x => typeof x === 'string').slice(0, 50) : [],
    createdAt: now };
}

/** Deterministic seed layout: every concept card in its topic section, with overflow for out-of-syllabus points. */
export function boardLayoutFor(course, conceptId, concepts = []) {
  return boardSeedPosition(course.syllabus.topics, conceptId, concepts);
}
/**
 * Apply one atomic board batch. Element ids are always assigned by the store (callers never invent ids);
 * an `add` may carry a batch-local `ref` so later operations in the same batch can point at it (`from: "$ref"`).
 * Only the internal seed path may pass explicit ids (`internalIds`).
 */
function boardPatch(s, course, board, operations, now, actor, maxOps = 100, internalIds = false) {
  if (!Array.isArray(operations) || !operations.length || operations.length > maxOps) throw new Error(`operations must contain 1..${maxOps} items`);
  const elements = board.elements.map((e) => ({ ...e }));
  const byId = new Map(elements.map((e) => [e.id, e]));
  const refs = new Map();
  const resolve = (eid) => (typeof eid === 'string' && eid.startsWith('$') ? refs.get(eid.slice(1)) ?? eid : eid);
  const live = (eid) => { const e = byId.get(resolve(eid)); return e && !e.deleted ? e : null; };
  const deletedNow = new Set();
  const touched = [];
  operations.forEach((op, n) => {
    if (!op || typeof op !== 'object' || !['add', 'update', 'delete'].includes(op.op)) throw new Error(`operations[${n}].op must be add | update | delete`);
    if (op.op === 'add') {
      if (!BOARD_ELEMENT_TYPES.includes(op.type)) throw new Error(`operations[${n}].type must be one of ${BOARD_ELEMENT_TYPES.join(', ')}`);
      if (op.id !== undefined && !internalIds) throw new Error(`operations[${n}]: add must not carry an id; the store assigns one (use ref:"name" and "$name" to point at it in the same batch)`);
      if (op.ref !== undefined && (typeof op.ref !== 'string' || !REF_RE.test(op.ref) || refs.has(op.ref))) throw new Error(`operations[${n}].ref must be a new batch-local name matching ${REF_RE}`);
      const eid = op.id === undefined ? id(op.type === 'arrow' ? 'arrow' : op.type === 'note' ? 'note' : 'card') : op.id;
      if (typeof eid !== 'string' || !BOARD_ID_RE.test(eid)) throw new Error(`operations[${n}].id must match ${BOARD_ID_RE}`);
      if (byId.has(eid)) throw new Error(`Element id already used (ids are never reused): ${eid}`);
      if (op.ref !== undefined) refs.set(op.ref, eid);
      let linkTo = [];
      const base = { id: eid, type: op.type, createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now };
      let el;
      if (op.type === 'arrow') {
        const from = live(op.from), to = live(op.to);
        if (!from || !to || from.type === 'arrow' || to.type === 'arrow') throw new Error('Arrow needs from/to ids of live cards on this board (ids only come from tutor_board_read, or "$ref" of a card added earlier in this batch)');
        if (from.id === to.id) throw new Error('Arrow cannot connect a card to itself');
        el = { ...base, from: from.id, to: to.id, label: optionalText(op.label, 'arrow.label', 80) ?? '' };
        if (op.relationId !== undefined) {
          const r = s.relations[op.relationId];
          if (!r || r.courseId !== course.id) throw new Error(`Unknown relationId: ${op.relationId}`);
          el.relationId = r.id;
        }
      } else {
        let text = '';
        let conceptId, noteId;
        let pos = { x: 40, y: 40 };
        if (op.type === 'concept') {
          const concept = s.concepts[op.conceptId];
          if (!concept || concept.courseId !== course.id || concept.status !== 'active') throw new Error(`Unknown or retired conceptId for this course: ${op.conceptId}`);
          if (elements.some((e) => !e.deleted && e.type === 'concept' && e.conceptId === concept.id)) throw new Error(`Concept already on board: ${concept.title}`);
          conceptId = concept.id;
          pos = boardLayoutFor(course, conceptId, Object.values(s.concepts).filter((c) => c.courseId === course.id));
        } else if (op.noteId !== undefined) {
          // a lesson note as a card: its text follows the note; it links back to the note and its knowledge points
          const note = s.notes[op.noteId];
          if (!note || note.courseId !== course.id) throw new Error(`Unknown noteId for this course: ${op.noteId} (note ids come from tutor_read / note.add)`);
          if (op.text !== undefined) throw new Error('A note card shows its lesson note; do not pass text (edit the note instead)');
          if (elements.some((e) => !e.deleted && e.type === 'note' && e.noteId === note.id)) throw new Error(`Note already on board: ${note.title}`);
          noteId = note.id;
          const near = elements.find((e) => !e.deleted && e.type === 'concept' && (note.conceptIds ?? []).includes(e.conceptId));
          if (near) pos = { x: Math.min(20_000, near.x + (near.width ?? CARD.width) + 28), y: near.y };
          if (op.arrows === true) linkTo = elements.filter((e) => !e.deleted && e.type === 'concept' && (note.conceptIds ?? []).includes(e.conceptId));
        } else text = requireText(op.text, 'note.text', 500);
        const anchors = op.anchors !== undefined ? normalizeAnchors(s, course.id, op.anchors, 'anchors') : undefined;
        if (op.seedKey !== undefined && (typeof op.seedKey !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(op.seedKey)))
          throw new Error(`operations[${n}].seedKey must match /^[A-Za-z0-9_-]{1,120}$/`);
        el = { ...base, ...(conceptId ? { conceptId } : noteId ? { noteId } : { text }),
          x: op.x === undefined ? pos.x : boardCoord(op.x, 'x'), y: op.y === undefined ? pos.y : boardCoord(op.y, 'y'),
          width: op.width === undefined ? CARD.width : finiteNumber(op.width, 'width', 60, 800),
          height: op.height === undefined ? CARD.height : finiteNumber(op.height, 'height', 40, 600),
          color: boardColor(op.color) ?? '',
          ...(anchors?.length ? { anchors } : {}),
          ...(op.seedKey ? { seedKey: op.seedKey } : {}),
          ...(op.conceptIds ? { conceptIds: [...new Set(op.conceptIds.filter((id) => typeof id === 'string' && s.concepts[id]?.courseId === course.id))] } : (anchors ? { conceptIds: conceptIdsFromAnchors(anchors) } : {})) };
      }
      elements.push(el); byId.set(eid, el); touched.push(eid);
      // visual arrows from a note card to its knowledge point cards (a view of note.conceptIds, not a semantic relation)
      for (const target of linkTo) {
        const aid = id('arrow');
        const arrow = { id: aid, type: 'arrow', createdBy: actor, updatedBy: actor, createdAt: now, updatedAt: now, from: eid, to: target.id, label: '', noteLink: true };
        elements.push(arrow); byId.set(aid, arrow); touched.push(aid);
      }
    } else {
      const el = live(op.id);
      // Deleting something this same batch already removed (e.g. an arrow cascaded away with its card) is a no-op success.
      if (!el && op.op === 'delete' && deletedNow.has(resolve(op.id))) return;
      if (!el) throw new Error(`Unknown or deleted element id: ${op.id}. Element ids only come from tutor_board_read (never from tutor_visualize or invented); read the board again.`);
      if (op.op === 'delete') {
        el.deleted = true; el.deletedBy = 'direct'; el.updatedAt = now; el.updatedBy = actor; touched.push(el.id); deletedNow.add(el.id);
        if (el.type !== 'arrow') for (const a of elements) if (!a.deleted && a.type === 'arrow' && (a.from === el.id || a.to === el.id)) {
          a.deleted = true; a.deletedBy = 'cascade'; a.updatedAt = now; a.updatedBy = actor; touched.push(a.id); deletedNow.add(a.id);
        }
      } else {
        const fields = ['x', 'y', 'width', 'height', 'text', 'color', 'label'].filter((k) => op[k] !== undefined);
        if (!fields.length) throw new Error('update needs at least one of x, y, width, height, text, color, label');
        if (el.type === 'arrow') {
          if (fields.some((k) => k !== 'label' && k !== 'color')) throw new Error('Arrows only accept label/color updates; delete and re-add to reconnect');
        } else if (op.label !== undefined) throw new Error('label is only for arrows');
        if (op.text !== undefined) {
          if (el.type !== 'note') throw new Error('Concept card text follows the syllabus; rename the subtopic instead');
          if (el.noteId) throw new Error('A note card shows its lesson note; edit the note instead');
          el.text = requireText(op.text, 'note.text', 500);
        }
        if (op.x !== undefined) el.x = boardCoord(op.x, 'x');
        if (op.y !== undefined) el.y = boardCoord(op.y, 'y');
        if (op.width !== undefined) el.width = finiteNumber(op.width, 'width', 60, 800);
        if (op.height !== undefined) el.height = finiteNumber(op.height, 'height', 40, 600);
        if (op.color !== undefined) el.color = boardColor(op.color);
        if (op.label !== undefined) el.label = optionalText(op.label, 'arrow.label', 80);
        el.updatedAt = now; el.updatedBy = actor; touched.push(el.id);
      }
    }
  });
  if (elements.length > MAX_BOARD_ELEMENTS) throw new Error(`Board limit is ${MAX_BOARD_ELEMENTS} elements including tombstones`);
  return { courseId: course.id, revision: board.revision + 1, elements, updatedAt: now, touched, refs: Object.fromEntries(refs) };
}

export function newState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, goals: {}, courses: {}, concepts: {},
    lessons: {}, relations: {}, notes: {}, assessments: {}, sources: {}, boards: {}, mindmaps: {}, graphNodes: {}, events: [] };
}
export function validateState(state) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(state.revision) || state.revision < 0)
    throw new Error('Unsupported or corrupt tutor state');
  for (const key of ['goals', 'courses', 'concepts', 'lessons', 'relations', 'notes', 'assessments', 'sources'])
    if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) throw new Error(`Missing ${key}`);
  if (!Array.isArray(state.events)) throw new Error('Missing event ledger');
  // `boards`, `mindmaps` and `graphNodes` were added after schema v1 shipped; older files simply have none yet.
  for (const key of ['boards', 'mindmaps', 'graphNodes'])
    if (state[key] !== undefined && (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])))
      throw new Error(`Corrupt ${key}`);
  return state;
}

/** Pure transactional state transition. Never infer learner answers or mastery from reading completion. */
export function transition(original, action, input = {}, opts = {}) {
  validateState(original);
  const s = normalizeState(clone(original));
  const now = opts.now ?? iso();
  const actor = ACTORS.includes(opts.actor) ? opts.actor : 'ai';
  const payload = input ?? {};
  let result;
  let autoSummary = null;
  // why the outline changed (shown next to the diff); the model-facing tools require it for AI edits of an existing outline
  const needReason = () => (typeof payload.reason === 'string' ? payload.reason.trim().slice(0, 500) : '');
  const touchLesson = (lesson) => { const c = s.courses[lesson.courseId]; if (c) c.resume = { lessonId: lesson.id, at: now }; lesson.updatedAt = now; };
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
      requireSyllabusRevision(course, payload.syllabusRevision);
      const { topics, kept } = mergePlan(normalizeTopics(payload.topics, course.syllabus.topics), course.syllabus.topics);
      if (topics.length > 40) throw new Error('An outline must keep 1..40 topics');
      const change = applySyllabus(s, course, topics, now, { actor, reason: needReason(), via: 'plan' });
      result = { courseId: course.id, syllabus: course.syllabus, change, ...(kept.length ? { keptUnmentioned: kept } : {}) }; break;
    }
    case 'course.editOutline': {
      const course = requireId(s, 'courses', payload.courseId);
      requireSyllabusRevision(course, payload.syllabusRevision);
      const reason = needReason();
      const topics = editOutline(course.syllabus.topics, payload.operations);
      const change = applySyllabus(s, course, topics, now, { actor, reason, via: 'edit' });
      result = { courseId: course.id, syllabus: course.syllabus, applied: payload.operations.length, change }; break;
    }
    case 'course.approve': {
      // One explicit approve of the exact outline revision (CAS). The learner (workbench) or the AI on the learner's say-so.
      const course = requireId(s, 'courses', payload.courseId);
      requireSyllabusRevision(course, payload.syllabusRevision);
      if (!course.syllabus.topics.length) throw new Error('Cannot approve an empty syllabus');
      const consent = approvalConsent(course, actor, payload.consent, 'outline');
      course.status = 'active'; course.syllabus.approvedAt = now; course.syllabus.approvedBy = actor; course.updatedAt = now;
      course.syllabus.approval = { by: actor, at: now, ...(consent ? { consent } : {}), ...(actor === 'ai' && !payload.consent ? { delegated: true } : {}) };
      course.syllabus.lastApproved = { revision: course.syllabus.revision, at: now, by: actor, topics: clone(course.syllabus.topics) };
      if (actor === 'ai') autoSummary = `AI 代为批准大纲第 ${course.syllabus.revision} 版（依据：${consent.slice(0, 60)}）`;
      // feedback → adjust → approve → continue: approving the adjusted outline resumes every lesson that waited for it
      const resumed = [];
      for (const l of Object.values(s.lessons)) {
        if (l.courseId !== course.id || l.phase !== 'plan_adjustment_pending' || course.syllabus.revision <= (l.adjust?.fromSyllabusRevision ?? Infinity)) continue;
        l.adjust = { ...l.adjust, doneAt: now, skipped: false, toSyllabusRevision: course.syllabus.revision, by: 'approval' };
        l.phase = l.adjust.returnPhase;
        if (l.phase === 'complete') l.status = 'complete';
        l.updatedAt = now;
        resumed.push({ lessonId: l.id, phase: l.phase });
      }
      result = { courseId: course.id, status: course.status, syllabusRevision: course.syllabus.revision, approvedBy: actor, ...(consent ? { consent } : {}), ...(resumed.length ? { resumedLessons: resumed } : {}) }; break;
    }
    case 'course.setApproval': {
      const course = requireId(s, 'courses', payload.courseId);
      if (!APPROVAL_MODES.includes(payload.mode)) throw new Error(`mode must be one of ${APPROVAL_MODES.join(' | ')}`);
      let consent = null;
      if (payload.mode === 'delegated') {
        consent = actor === 'learner' ? '学习者在工作台选择「交给 AI 批准」' : (typeof payload.consent === 'string' && payload.consent.trim() ? payload.consent.trim().slice(0, 300) : null);
        if (!consent) throw Object.assign(new Error('Delegating approvals to the AI needs the learner\'s words as consent (e.g. 「以后大纲和课时计划你直接批准」)'), { code: 'forbidden' });
      }
      course.approvalMode = payload.mode;
      course.approvalDelegation = payload.mode === 'delegated' ? { by: actor, at: now, consent } : null;
      course.updatedAt = now;
      autoSummary = payload.mode === 'delegated' ? `${actor === 'learner' ? '你' : 'AI'}把批准交给 AI（${consent.slice(0, 60)}）` : `${actor === 'learner' ? '你' : 'AI'}恢复为学习者批准`;
      result = { courseId: course.id, approvalMode: course.approvalMode, ...(consent ? { consent } : {}) }; break;
    }
    case 'lesson.create': {
      const course = requireId(s, 'courses', payload.courseId);
      if (course.status !== 'active') throw new Error('Approve course syllabus before creating a lesson');
      const parts = normalizeParts(s, course, payload.parts);
      const item = { id: id('lesson'), courseId: course.id, title: requireText(payload.title, 'title', 160),
        status: 'planned', phase: 'plan_pending', activePartIndex: 0, ...lessonLinks(s, course, payload, parts), planRevision: 1,
        parts, createdAt: now, updatedAt: now };
      s.lessons[item.id] = item; touchLesson(item); result = item; break;
    }
    case 'lesson.updatePlan': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const course = requireId(s, 'courses', lesson.courseId);
      if (lesson.phase !== 'plan_pending') throw new Error('Only a lesson plan that is still awaiting approval can be changed');
      requirePlanRevision(lesson, payload.planRevision, true);
      if (payload.title !== undefined) lesson.title = requireText(payload.title, 'title', 160);
      if (payload.parts !== undefined) lesson.parts = normalizeParts(s, course, payload.parts);
      if (payload.parts !== undefined || payload.topicId !== undefined || payload.conceptIds !== undefined)
        Object.assign(lesson, lessonLinks(s, course, { topicId: payload.topicId === undefined ? lesson.topicId : payload.topicId, conceptIds: payload.conceptIds }, lesson.parts));
      lesson.planRevision = lessonPlanRevision(lesson) + 1; touchLesson(lesson);
      result = { lessonId: lesson.id, planRevision: lesson.planRevision, parts: lesson.parts, topicId: lesson.topicId, conceptIds: lesson.conceptIds }; break;
    }
    case 'lesson.link': {
      // attach (or re-attach) a lesson to its topic / knowledge points; older lessons may have none
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const course = requireId(s, 'courses', lesson.courseId);
      if (payload.topicId === undefined && payload.conceptIds === undefined) throw new Error('lesson.link needs topicId and/or conceptIds');
      if (payload.topicId !== undefined) lesson.topicId = courseTopic(course, payload.topicId, 'topicId');
      if (payload.conceptIds !== undefined) lesson.conceptIds = courseConcepts(s, course.id, payload.conceptIds, 'conceptIds');
      else if (!lesson.conceptIds?.length && lesson.topicId) lesson.conceptIds = lessonLinks(s, course, { topicId: lesson.topicId }, []).conceptIds;
      lesson.updatedAt = now;
      result = { lessonId: lesson.id, topicId: lesson.topicId ?? null, conceptIds: lesson.conceptIds ?? [] }; break;
    }
    case 'lesson.approve': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const course = requireId(s, 'courses', lesson.courseId);
      if (lesson.phase !== 'plan_pending') throw new Error('Lesson plan is not awaiting approval');
      requirePlanRevision(lesson, payload.planRevision, actor === 'ai');
      const consent = approvalConsent(course, actor, payload.consent, 'lesson plan');
      lesson.phase = 'teaching'; lesson.status = 'in_progress'; lesson.parts[0].status = 'in_progress';
      lesson.approval = { by: actor, at: now, planRevision: lessonPlanRevision(lesson), ...(consent ? { consent } : {}) };
      touchLesson(lesson);
      if (actor === 'ai') autoSummary = `AI 代为批准课时计划「${lesson.title}」（依据：${consent.slice(0, 60)}）`;
      result = { lessonId: lesson.id, phase: lesson.phase, current: lesson.parts[0], approvedBy: actor, planRevision: lessonPlanRevision(lesson) }; break;
    }
    case 'lesson.partWrite': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'teaching' || lesson.activePartIndex !== payload.partIndex)
        throw new Error('Can only write the current teaching part');
      const part = lesson.parts[payload.partIndex];
      part.body = requireText(payload.body, 'part.body', 60000);
      part.sourceRefs = normalizeSourceRefs(s, s.courses[lesson.courseId], payload.sourceRefs);
      touchLesson(lesson);
      result = { lessonId: lesson.id, partIndex: payload.partIndex, stored: true, sourceRefs: part.sourceRefs }; break;
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
      touchLesson(lesson);
      result = { lessonId: lesson.id, phase: lesson.phase, activePartIndex: lesson.activePartIndex }; break;
    }
    case 'assessment.record': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const concept = requireId(s, 'concepts', payload.conceptId);
      if (lesson.courseId !== concept.courseId) throw new Error('Assessment concept not in lesson course');
      if (!['review_pending', 'teaching'].includes(lesson.phase)) throw new Error('Assessment not allowed in this phase');
      const pending = lesson.pendingQuestion ?? null;
      if (payload.questionId !== undefined && payload.questionId !== pending?.id) throw new Error(`questionId ${payload.questionId} is not the open question of this lesson${pending ? ` (open: ${pending.id})` : ' (none is open)'}`);
      const answersPending = pending && (payload.questionId === pending.id || (payload.questionId === undefined && String(payload.question ?? '').trim() === pending.question));
      // objective questions (choice / multi / fill with a key frozen at lesson.ask) are graded HERE against that key;
      // the model's score is ignored. Everything else keeps the model's provisional score.
      const keyed = answersPending && isObjective(pending);
      const studentAnswer = requireText(payload.studentAnswer, 'studentAnswer');
      const grade = keyed ? gradeAnswer(pending, studentAnswer) : null;
      const score = keyed ? grade.score : Number(payload.score), hintCount = Number(payload.hintCount ?? (answersPending ? pending.hintCount : 0));
      if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error('score must be between 0 and 1');
      if (!Number.isInteger(hintCount) || hintCount < 0 || hintCount > 10) throw new Error('hintCount must be 0..10');
      const feedback = keyed ? (payload.feedback === undefined || payload.feedback === null ? '' : String(payload.feedback).trim().slice(0, 5000))
        : requireText(payload.feedback, 'feedback');
      const record = { id: id('assess'), lessonId: lesson.id, conceptId: concept.id,
        question: keyed && (payload.question === undefined || payload.question === null) ? pending.question : requireText(payload.question, 'question'),
        studentAnswer, feedback, score, hintCount,
        transfer: payload.transfer === true, type: answersPending ? (pending.type ?? 'short') : 'short',
        judgedBy: keyed ? JUDGED_BY_KEY : JUDGED_BY_MODEL, recordedAt: now };
      if (keyed) {
        record.options = pending.options;
        record.answerKey = pending.answerKey;
        record.expectedAnswer = expectedAnswer(pending).text;
        record.grading = { parsed: grade.parsed, matched: grade.matched, ...(payload.score !== undefined && Number(payload.score) !== score ? { ignoredModelScore: Number.isFinite(Number(payload.score)) ? Number(payload.score) : String(payload.score).slice(0, 40) } : {}) };
      }
      let closed = false;
      if (answersPending) {
        pending.attempts += 1; pending.lastAnswerAt = now; pending.lastScore = score;
        record.questionId = pending.id; record.attemptNo = pending.attempts;
        // the question stays open after a wrong answer (hint → try again) unless it is closed explicitly
        if (score >= 0.8 || payload.close === true) { lesson.answeredQuestions = [...(lesson.answeredQuestions ?? []), { ...pending, closedAt: now }].slice(-20); lesson.pendingQuestion = null; closed = true; }
      }
      s.assessments[record.id] = record;
      touchLesson(lesson);
      // Provisional evidence level only; never claim calibrated mastery probability.
      concept.mastery = score >= 0.8 && record.transfer && hintCount === 0 ? 'demonstrated' : 'developing';
      concept.updatedAt = now;
      // the key is revealed in the result only once the learner can no longer retry this question
      const shown = keyed && !closed ? redactAssessment(record, new Set([pending.id])) : record;
      result = { assessment: shown, provisionalMastery: concept.mastery, pendingQuestion: publicQuestion(lesson.pendingQuestion ?? null),
        official: { score, judgedBy: record.judgedBy, ...(keyed ? { isCorrect: grade.correct, ...(closed ? { expectedAnswer: record.expectedAnswer }
          : { expectedAnswer: null, note: 'Wrong; the question stays open for another try, so the key is withheld. Give a hint (lesson.hint), or close it (close:true / lesson.dropQuestion) to get the expected answer.' }) } : {}) } };
      break;
    }
    case 'lesson.ask': {
      // the question now waiting for the learner's answer (survives a new DSH session)
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (!['teaching', 'review_pending'].includes(lesson.phase)) throw new Error('Questions are asked while teaching or in the review');
      if (lesson.pendingQuestion && payload.replace !== true)
        throw new Error(`A question is still waiting for the learner's answer: 「${lesson.pendingQuestion.question.slice(0, 80)}」 (${lesson.pendingQuestion.id}). Record the answer with assessment.record, or pass replace:true to drop it`);
      const conceptId = payload.conceptId === undefined ? null : courseConcepts(s, lesson.courseId, [payload.conceptId], 'conceptId')[0];
      // choice / multi / fill: options and the answer key are validated and frozen now, before the learner answers
      const spec = questionSpec(payload);
      const question = requireText(payload.question, 'question', 5000);
      if (lesson.pendingQuestion) lesson.answeredQuestions = [...(lesson.answeredQuestions ?? []), { ...lesson.pendingQuestion, droppedAt: now }].slice(-20);
      lesson.pendingQuestion = { id: id('q'), question, ...spec, conceptId,
        phase: lesson.phase, partIndex: lesson.phase === 'teaching' ? lesson.activePartIndex : null, askedAt: now, attempts: 0, hintCount: 0, hints: [] };
      touchLesson(lesson);
      result = { lessonId: lesson.id, pendingQuestion: publicQuestion(lesson.pendingQuestion) }; break;
    }
    case 'lesson.hint': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const q = lesson.pendingQuestion;
      if (!q) throw new Error('No open question to give a hint for (lesson.ask first)');
      q.hints = [...q.hints, requireText(payload.hint, 'hint', 1000)].slice(-10); q.hintCount = Math.min(10, q.hintCount + 1); q.lastHintAt = now;
      touchLesson(lesson);
      result = { lessonId: lesson.id, pendingQuestion: publicQuestion(q) }; break;
    }
    case 'lesson.dropQuestion': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (!lesson.pendingQuestion) throw new Error('No open question');
      const dropped = lesson.pendingQuestion;
      lesson.answeredQuestions = [...(lesson.answeredQuestions ?? []), { ...dropped, droppedAt: now }].slice(-20);
      lesson.pendingQuestion = null; touchLesson(lesson);
      // closed now: the expected answer of a keyed question can be explained
      result = { lessonId: lesson.id, pendingQuestion: null, ...(isObjective(dropped) ? { droppedQuestion: { id: dropped.id, type: dropped.type, expectedAnswer: expectedAnswer(dropped).text } } : {}) }; break;
    }
    case 'lesson.checkpoint': {
      // a short recap of where the learner is, read back first when the lesson resumes (「先回忆」)
      const lesson = requireId(s, 'lessons', payload.lessonId);
      lesson.recap = { text: requireText(payload.recap, 'recap', 2000), at: now, by: actor };
      touchLesson(lesson);
      result = { lessonId: lesson.id, recap: lesson.recap }; break;
    }
    case 'lesson.reviewEnd': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'review_pending') throw new Error('Review not pending');
      if (payload.skipped !== true && !Object.values(s.assessments).some(a => a.lessonId === lesson.id))
        throw new Error('A review requires real learner answers, or explicitly skip it');
      const dropped = lesson.pendingQuestion;
      if (dropped) { lesson.answeredQuestions = [...(lesson.answeredQuestions ?? []), { ...dropped, droppedAt: now }].slice(-20); lesson.pendingQuestion = null; }
      lesson.phase = 'summary_pending'; lesson.reviewSkipped = payload.skipped === true; touchLesson(lesson);
      result = { lessonId: lesson.id, phase: lesson.phase, skipped: lesson.reviewSkipped, ...(dropped ? { droppedQuestion: dropped.question } : {}) }; break;
    }
    case 'note.add': {
      const lesson = payload.lessonId ? requireId(s, 'lessons', payload.lessonId) : null;
      const courseId = lesson?.courseId ?? payload.courseId;
      if (!courseId || !s.courses[courseId]) throw new Error('note.add needs lessonId or courseId');
      const conceptIds = courseConcepts(s, courseId, payload.conceptIds, 'conceptIds');
      const anchors = mergeAnchors(s, courseId, payload.anchors, { conceptIds, lessonId: lesson?.id }, 'anchors');
      if (!anchors.length && !lesson) throw new Error('note.add needs a lessonId or at least one anchor');
      const note = { id: id('note'), courseId, lessonId: lessonIdFromAnchors(anchors) ?? lesson?.id ?? null,
        title: requireText(payload.title, 'note.title', 160), content: requireText(payload.content, 'note.content', 50_000),
        author: actor, anchors, conceptIds: conceptIdsFromAnchors(anchors),
        sourceRefs: normalizeSourceRefs(s, s.courses[courseId], payload.sourceRefs),
        createdAt: now };
      s.notes[note.id] = note; result = note; break;
    }
    case 'note.link': {
      const note = requireId(s, 'notes', payload.noteId);
      const conceptIds = payload.conceptIds !== undefined ? courseConcepts(s, note.courseId, payload.conceptIds, 'conceptIds') : conceptIdsFromAnchors(note.anchors ?? legacyAnchors(note));
      note.anchors = mergeAnchors(s, note.courseId, payload.anchors ?? (payload.conceptIds === undefined ? note.anchors : []), { conceptIds, lessonId: payload.lessonId === undefined ? note.lessonId : payload.lessonId }, 'anchors');
      note.conceptIds = conceptIdsFromAnchors(note.anchors);
      note.lessonId = lessonIdFromAnchors(note.anchors) ?? note.lessonId ?? null;
      note.updatedAt = now;
      result = { id: note.id, noteId: note.id, conceptIds: note.conceptIds, anchors: note.anchors, lessonId: note.lessonId }; break;
    }
    case 'note.update': {
      const note = requireId(s, 'notes', payload.noteId);
      if (payload.title === undefined && payload.content === undefined) throw new Error('note.update needs title or content');
      if (payload.title !== undefined) note.title = requireText(payload.title, 'note.title', 160);
      if (payload.content !== undefined) note.content = requireText(payload.content, 'note.content', 50_000);
      note.updatedAt = now;
      result = { id: note.id, noteId: note.id, title: note.title, content: note.content }; break;
    }
    case 'lesson.finish': {
      const lesson = requireId(s, 'lessons', payload.lessonId);
      if (lesson.phase !== 'summary_pending') throw new Error('Finish only after review choice');
      if (!Object.values(s.notes).some(note => note.lessonId === lesson.id || (note.anchors ?? []).some((a) => a.type === 'lesson' && a.id === lesson.id)) && payload.skipNotes !== true)
        throw new Error('Create a lesson note or explicitly skip notes');
      // end-of-lesson feedback comes next (it may adjust the outline); lesson.feedback completes the lesson
      lesson.phase = 'feedback_pending'; lesson.notesSkipped = payload.skipNotes === true; touchLesson(lesson);
      result = { lessonId: lesson.id, phase: lesson.phase, status: lesson.status }; break;
    }
    case 'lesson.feedback': {
      // the learner's own end-of-lesson (or mid-lesson) feedback; adjustOutline opens plan_adjustment_pending
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const course = requireId(s, 'courses', lesson.courseId);
      if (!['feedback_pending', 'teaching'].includes(lesson.phase)) throw new Error('Feedback is collected at the end of a lesson (after lesson.finish) or while teaching');
      const skipped = payload.skipped === true;
      const text = skipped ? null : requireText(payload.feedback, 'feedback (the learner\'s own words; or skipped:true)', 4000);
      const adjust = payload.adjustOutline === true;
      if (skipped && adjust) throw new Error('adjustOutline needs the learner\'s feedback');
      const preview = optionalText(payload.nextPreview, 'nextPreview', 2000);
      const entry = { text, skipped, adjustOutline: adjust, at: now, by: actor, phase: lesson.phase, syllabusRevision: course.syllabus.revision };
      lesson.feedbackLog = [...(lesson.feedbackLog ?? []), entry].slice(-20);
      lesson.feedback = entry;
      if (preview) lesson.nextPreview = { text: preview, at: now };
      if (adjust) {
        lesson.adjust = { returnPhase: lesson.phase === 'teaching' ? 'teaching' : 'complete', fromSyllabusRevision: course.syllabus.revision, at: now };
        lesson.phase = 'plan_adjustment_pending';
      } else if (lesson.phase === 'feedback_pending') { lesson.phase = 'complete'; lesson.status = 'complete'; }
      touchLesson(lesson);
      result = { lessonId: lesson.id, phase: lesson.phase, status: lesson.status, feedback: entry, nextPreview: lesson.nextPreview ?? null }; break;
    }
    case 'lesson.adjustDone': {
      // feedback → outline change → approval → continue (or the learner decided against the change: skipped)
      const lesson = requireId(s, 'lessons', payload.lessonId);
      const course = requireId(s, 'courses', lesson.courseId);
      if (lesson.phase !== 'plan_adjustment_pending') {
        // already resumed by the approval of the adjusted outline: only the next-lesson preview is still to record
        if (!lesson.adjust?.doneAt) throw new Error('No outline adjustment is pending for this lesson');
        const preview = optionalText(payload.nextPreview, 'nextPreview', 2000);
        if (preview) { lesson.nextPreview = { text: preview, at: now }; touchLesson(lesson); }
        result = { lessonId: lesson.id, phase: lesson.phase, status: lesson.status, adjust: lesson.adjust, nextPreview: lesson.nextPreview ?? null, alreadyResumed: true }; break;
      }
      const skipped = payload.skipped === true;
      if (!skipped) {
        if (course.syllabus.revision <= lesson.adjust.fromSyllabusRevision) throw new Error('The outline has not been changed since the feedback; change it (tutor_outline_edit with a reason) or pass skipped:true if the learner decided against it');
        if (course.status !== 'active') throw Object.assign(new Error(`The adjusted outline (revision ${course.syllabus.revision}) still needs approval: the learner approves it in the workbench, or you approve it (course.approve) if the learner asked you to`), { code: 'conflict', syllabusRevision: course.syllabus.revision });
      }
      const preview = optionalText(payload.nextPreview, 'nextPreview', 2000);
      if (preview) lesson.nextPreview = { text: preview, at: now };
      lesson.adjust = { ...lesson.adjust, doneAt: now, skipped, toSyllabusRevision: course.syllabus.revision };
      lesson.phase = lesson.adjust.returnPhase;
      if (lesson.phase === 'complete') lesson.status = 'complete';
      touchLesson(lesson);
      result = { lessonId: lesson.id, phase: lesson.phase, status: lesson.status, adjust: lesson.adjust, nextPreview: lesson.nextPreview ?? null }; break;
    }
    case 'relation.propose': {
      const item = buildCandidateRelation(s, payload, now);
      s.relations[item.id] = item; result = item; break;
    }
    case 'board.seed':
    case 'board.generate': {
      const course = requireId(s, 'courses', payload.courseId);
      const board = boardOf(s, course.id);
      if (!Number.isInteger(payload.baseRevision)) throw new Error('baseRevision (board revision from tutor_board_read) is required');
      if (payload.baseRevision !== board.revision)
        throw Object.assign(new Error(`Board changed (latest revision ${board.revision}); read it again`), { code: 'conflict', boardRevision: board.revision });
      // Missing knowledge-point cards (including promoted / out-of-syllabus), candidate-relation arrows,
      // and related mind-map / graph extensions as annotation cards. Existing layout is left alone.
      const ops = collectBoardSeedOps(s, course, board, { lessonId: payload.lessonId, notes: payload.notes });
      if (!ops.length) { result = { courseId: course.id, revision: board.revision, added: 0 }; break; }
      const next = boardPatch(s, course, board, ops, now, actor, MAX_BOARD_ELEMENTS, true);
      const { touched, refs } = next; delete next.touched; delete next.refs;
      s.boards[course.id] = next;
      result = { courseId: course.id, revision: next.revision, added: ops.length, touched, ...(Object.keys(refs).length ? { refs } : {}) }; break;
    }
    case 'board.patch': {
      const course = requireId(s, 'courses', payload.courseId);
      const board = boardOf(s, course.id);
      if (!Number.isInteger(payload.baseRevision)) throw new Error('baseRevision (board revision from tutor_board_read) is required');
      if (payload.baseRevision !== board.revision)
        throw Object.assign(new Error(`Board changed (latest revision ${board.revision}); read it again and re-evaluate against human edits`), { code: 'conflict', boardRevision: board.revision });
      const next = boardPatch(s, course, board, payload.operations, now, actor);
      const { touched, refs } = next; delete next.touched; delete next.refs;
      s.boards[course.id] = next;
      result = { courseId: course.id, revision: next.revision, touched, ...(Object.keys(refs).length ? { refs } : {}) }; break;
    }
    case 'mindmap.ensure': {
      const course = requireId(s, 'courses', payload.courseId);
      if (!s.mindmaps[course.id]) s.mindmaps[course.id] = buildMindmapFromSyllabus(course, { now, actor });
      for (const c of Object.values(s.concepts)) if (c.courseId === course.id) ensureCanonicalGraphNode(s, c, { now, actor });
      const mm = s.mindmaps[course.id];
      result = { courseId: course.id, mindmapRevision: mm.revision, rootId: mm.rootId, created: true }; break;
    }
    case 'mindmap.edit': {
      const course = requireId(s, 'courses', payload.courseId);
      if (!s.mindmaps[course.id]) s.mindmaps[course.id] = buildMindmapFromSyllabus(course, { now, actor });
      const mm = s.mindmaps[course.id];
      if (payload.mindmapRevision !== undefined && payload.mindmapRevision !== null) {
        if (!Number.isInteger(payload.mindmapRevision)) throw new Error('mindmapRevision must be an integer');
        if (payload.mindmapRevision !== mm.revision)
          throw Object.assign(new Error(`Mind map changed (revision ${mm.revision}); read it again`), { code: 'conflict', mindmapRevision: mm.revision });
      }
      const { touched } = editMindmap(mm, payload.operations, { id, now, actor });
      s.mindmaps[course.id] = mm;
      result = { courseId: course.id, mindmapRevision: mm.revision, applied: payload.operations.length, touched,
        hierarchy: mindmapHierarchy(mm, course) }; break;
    }
    case 'graphNode.add': {
      const course = requireId(s, 'courses', payload.courseId);
      const refersTo = payload.refersTo ? requireId(s, 'concepts', payload.refersTo).id : null;
      if (refersTo && s.concepts[refersTo].courseId !== course.id) throw new Error('refersTo belongs to another course');
      const node = { id: id('gn'), courseId: course.id, title: requireText(payload.title, 'title', 160),
        description: typeof payload.description === 'string' ? payload.description.slice(0, 1500) : '',
        refersTo, belongsTo: normalizeBelongsTo(payload.belongsTo),
        origin: originOf(payload.phase === 'authoring' ? 'authoring' : 'learning', actor, now),
        createdAt: now, updatedAt: now };
      s.graphNodes[node.id] = node; result = node; break;
    }
    case 'graphNode.rename': {
      const node = requireId(s, 'graphNodes', payload.id);
      node.title = requireText(payload.title, 'title', 160);
      if (payload.description !== undefined) node.description = typeof payload.description === 'string' ? payload.description.slice(0, 1500) : '';
      node.updatedAt = now; result = node; break;
    }
    case 'graphNode.remove': {
      const node = requireId(s, 'graphNodes', payload.id);
      if (node.refersTo) throw new Error('A graph node that refers to a knowledge point cannot be deleted; retire or unlink it first');
      for (const r of Object.values(s.relations)) if (r.from === node.id || r.to === node.id) delete s.relations[r.id];
      delete s.graphNodes[node.id];
      result = { id: node.id, removed: true }; break;
    }
    case 'concept.create': {
      const course = requireId(s, 'courses', payload.courseId);
      const item = { id: id('kp'), courseId: course.id, title: requireText(payload.title, 'title', 160),
        description: typeof payload.description === 'string' ? payload.description.slice(0, 1500) : '',
        topicId: payload.topicId ?? null, subtopicId: null, status: 'active', evidenceRefs: [], mastery: 'unverified',
        origin: originOf(payload.phase === 'learning' ? 'learning' : 'authoring', actor, now), updatedAt: now };
      if (item.topicId) courseTopic(course, item.topicId, 'topicId');
      s.concepts[item.id] = item;
      ensureCanonicalGraphNode(s, item, { now, actor });
      result = item; break;
    }
    case 'concept.promote': {
      const course = requireId(s, 'courses', payload.courseId);
      const from = payload.from;
      if (!from || typeof from !== 'object' || !['mindmapNode', 'graphNode'].includes(from.type) || typeof from.id !== 'string')
        throw new Error("concept.promote needs from: { type: 'mindmapNode'|'graphNode', id }");
      let srcTitle, node, mm = null;
      if (from.type === 'mindmapNode') {
        mm = mindmapOf(s, course.id);
        node = mm?.nodes?.[from.id];
        if (!node) throw new Error(`Unknown mind-map node: ${from.id}`);
        if (node.refersTo && s.concepts[node.refersTo])
          throw Object.assign(new Error('This mind-map node already refers to a knowledge point'), { conceptId: node.refersTo });
        srcTitle = node.title;
      } else {
        node = requireId(s, 'graphNodes', from.id);
        if (node.courseId !== course.id) throw new Error('Graph node belongs to another course');
        if (node.refersTo && s.concepts[node.refersTo])
          throw Object.assign(new Error('This graph node already refers to a knowledge point'), { conceptId: node.refersTo });
        srcTitle = node.title;
      }
      const item = { id: id('kp'), courseId: course.id,
        title: payload.title !== undefined ? requireText(payload.title, 'title', 160) : requireText(srcTitle, 'title', 160),
        description: typeof payload.description === 'string' ? payload.description.slice(0, 1500) : '',
        topicId: from.type === 'mindmapNode' ? topicIdFromMindmapNode(s, mm, node) : (node.belongsTo?.type === 'topic' ? node.belongsTo.id : (s.concepts[node.belongsTo?.id]?.topicId ?? null)),
        subtopicId: null, status: 'active', evidenceRefs: [], mastery: 'unverified',
        origin: originOf('learning', actor, now), updatedAt: now };
      s.concepts[item.id] = item;
      node.refersTo = item.id;
      node.updatedAt = now;
      if (from.type === 'graphNode') {
        // the promoted node itself is the graph node that refers to the new knowledge point
      } else {
        ensureCanonicalGraphNode(s, item, { now, actor });
      }
      result = { conceptId: item.id, concept: item, from, refersTo: item.id }; break;
    }
    case 'concept.rename': {
      const concept = requireId(s, 'concepts', payload.conceptId ?? payload.id);
      concept.title = requireText(payload.title, 'title', 160);
      if (payload.description !== undefined) concept.description = typeof payload.description === 'string' ? payload.description.slice(0, 1500) : '';
      concept.updatedAt = now;
      const gn = graphNodeForConcept(s, concept.courseId, concept.id);
      if (gn) { gn.title = concept.title; gn.updatedAt = now; }
      result = concept; break;
    }
    case 'mindmap.generate': {
      const course = requireId(s, 'courses', payload.courseId);
      if (!s.mindmaps[course.id]) s.mindmaps[course.id] = buildMindmapFromSyllabus(course, { now, actor });
      const mm = s.mindmaps[course.id];
      if (payload.mindmapRevision !== undefined && payload.mindmapRevision !== null) {
        if (!Number.isInteger(payload.mindmapRevision)) throw new Error('mindmapRevision must be an integer');
        if (payload.mindmapRevision !== mm.revision)
          throw Object.assign(new Error(`Mind map changed (revision ${mm.revision}); read it again`), { code: 'conflict', mindmapRevision: mm.revision });
      }
      const phase = payload.phase === 'learning' ? 'learning' : 'authoring';
      const raw = Array.isArray(payload.nodes) ? payload.nodes : [];
      const additions = raw.map((n) => ({ ...n, phase: n.phase ?? phase }));
      const { added, skipped } = enrichMindmap(mm, additions, { id, now, actor });
      s.mindmaps[course.id] = mm;
      result = { courseId: course.id, mindmapRevision: mm.revision, added: added.length, skipped, addedIds: added,
        hierarchy: mindmapHierarchy(mm, course), skeleton: isMindmapSkeleton(mm, course) }; break;
    }
    case 'graph.generate': {
      const course = requireId(s, 'courses', payload.courseId);
      for (const c of Object.values(s.concepts)) if (c.courseId === course.id) ensureCanonicalGraphNode(s, c, { now, actor });
      const proposedNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
      const proposedRels = Array.isArray(payload.relations) ? payload.relations : [];
      if (proposedNodes.length + proposedRels.length > 100) throw new Error('graph.generate accepts at most 100 nodes and relations in total');
      const addedNodes = [], skippedNodes = [], addedRelations = [], skippedRelations = [];
      const refs = new Map();
      const remember = (ref, nodeId) => { if (typeof ref === 'string' && ref) refs.set(ref, nodeId); };
      proposedNodes.forEach((item, i) => {
        if (!item || typeof item !== 'object') throw new Error(`nodes[${i}] must be an object`);
        const refersTo = item.refersTo ? requireId(s, 'concepts', item.refersTo).id : null;
        if (refersTo && s.concepts[refersTo].courseId !== course.id) throw new Error('refersTo belongs to another course');
        if (refersTo) {
          const existing = graphNodeForConcept(s, course.id, refersTo);
          if (existing) { skippedNodes.push({ title: item.title ?? existing.title, reason: 'exists', id: existing.id }); remember(item.ref, existing.id); return; }
        }
        const title = requireText(item.title, `nodes[${i}].title`, 160);
        if (!refersTo) {
          const dup = Object.values(s.graphNodes).find((n) => n.courseId === course.id && !n.refersTo && titleKey(n.title) === titleKey(title));
          if (dup) { skippedNodes.push({ title, reason: 'duplicate', id: dup.id }); remember(item.ref, dup.id); return; }
        }
        const node = { id: id('gn'), courseId: course.id, title,
          description: typeof item.description === 'string' ? item.description.slice(0, 1500) : '',
          refersTo, belongsTo: normalizeBelongsTo(item.belongsTo),
          origin: originOf(item.phase === 'learning' || payload.phase === 'learning' ? 'learning' : 'authoring', actor, now),
          createdAt: now, updatedAt: now };
        s.graphNodes[node.id] = node; addedNodes.push(node.id); remember(item.ref, node.id);
      });
      const resolveEnd = (value, field) => {
        if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
        if (value.startsWith('$')) {
          const nid = refs.get(value.slice(1));
          if (!nid) throw new Error(`Unknown graph.generate ref: ${value}`);
          return nid;
        }
        if (refs.has(value)) return refs.get(value);
        return value;
      };
      for (const rel of proposedRels) {
        if (!rel || typeof rel !== 'object') throw new Error('relations entries must be objects');
        try {
          const item = buildCandidateRelation(s, {
            courseId: course.id, from: resolveEnd(rel.from, 'from'), to: resolveEnd(rel.to, 'to'),
            type: rel.type, note: rel.note, evidenceRefs: rel.evidenceRefs,
          }, now);
          s.relations[item.id] = item; addedRelations.push(item.id);
        } catch (err) {
          if (!/Duplicate relation/.test(err.message)) throw err;
          skippedRelations.push({ from: rel.from, to: rel.to, type: rel.type, reason: 'duplicate' });
        }
      }
      result = { courseId: course.id, addedNodes, skippedNodes, addedRelations, skippedRelations }; break;
    }
    default: throw new Error(`Unknown tutor action: ${action}`);

  }
  s.revision = original.revision + 1;
  const summary = opts.summary ?? autoSummary;
  s.events.push({ revision: s.revision, at: now, action, actor,
    entityId: result?.id ?? result?.lessonId ?? result?.courseId ?? null,
    ...(summary ? { summary: String(summary).slice(0, 200) } : {}) });
  // Bounded ledger: the workbench shows the last 40; keep the file from growing without limit.
  if (s.events.length > MAX_EVENTS) s.events.splice(0, s.events.length - MAX_EVENTS);
  return { state: s, result };
}

/** Minimal scoped read model; this is domain state, not the DSH Session transcript. */
export function snapshot(state, courseId) {
  validateState(state);
  const s = normalizeState(clone(state));
  if (!courseId) return { revision: s.revision, goals: Object.values(s.goals), courses: Object.values(s.courses),
    resume: Object.values(s.courses).map((c) => resumePointer(s, c)) };
  const course = requireId(s, 'courses', courseId);
  const openIds = openQuestionIds(s);
  return { revision: s.revision, course,
    concepts: Object.values(s.concepts).filter(x => x.courseId === courseId && x.status === 'active'),
    relations: Object.values(s.relations).filter(x => x.courseId === courseId),
    graphNodes: Object.values(s.graphNodes).filter(x => x.courseId === courseId),
    mindmap: s.mindmaps[courseId] ?? null,
    lessons: Object.values(s.lessons).filter(x => x.courseId === courseId).map(publicLesson),
    notes: Object.values(s.notes).filter(x => x.courseId === courseId),
    sources: (course.sourceIds ?? []).map(id => s.sources[id]).filter(Boolean),
    assessments: Object.values(s.assessments).filter(x => s.lessons[x.lessonId]?.courseId === courseId).map((a) => redactAssessment(a, openIds)),
    board: liveBoard(s, course), resume: resumePointer(s, course), outlineSinceApproved: sinceApproved(course) };
}

/** Ids of questions still waiting for an answer: their answer keys stay inside the store. */
export function openQuestionIds(state) {
  return new Set(Object.values(state.lessons ?? {}).map((l) => l.pendingQuestion?.id).filter(Boolean));
}
/** A lesson as read outside the store: the open question without its answer key. */
export function publicLesson(lesson) {
  return lesson?.pendingQuestion?.answerKey ? { ...lesson, pendingQuestion: publicQuestion(lesson.pendingQuestion) } : lesson;
}

const NEXT_STEP = {
  plan_pending: '课时计划待批准：出示计划请学习者批准（或经同意由 AI 用 lesson.approve 代批）',
  teaching: '分段讲解中：先帮学习者回忆上次要点；有待答题就从同一题接着',
  review_pending: '课末复习：一次一题，记录真实作答（有待答题先接着问）',
  summary_pending: '复习结束：征得同意后写笔记（note.add），或 lesson.finish 显式 skipNotes',
  feedback_pending: '课末反馈：请学习者说说这节课的感受和想调整的地方（lesson.feedback），并预告下一课',
  plan_adjustment_pending: '根据反馈调整大纲：tutor_outline_edit（带理由）→ 批准 → lesson.adjustDone',
  complete: '本课已结束：按预告创建下一课（lesson.create 带 topicId / conceptIds）',
};
/**
 * Where to pick up in a new conversation: the current lesson (course.resume, else the latest unfinished), its part,
 * the open question with its attempts and hints, the last recap, what was covered and the next-lesson preview.
 */
export function resumePointer(state, course) {
  const lessons = Object.values(state.lessons).filter((l) => l.courseId === course.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const lesson = state.lessons[course.resume?.lessonId] ?? lessons.filter((l) => l.status !== 'complete').at(-1) ?? lessons.at(-1) ?? null;
  const preview = lessons.filter((l) => l.nextPreview).sort((a, b) => String(a.nextPreview.at).localeCompare(String(b.nextPreview.at))).at(-1)?.nextPreview ?? null;
  if (!lesson) return { courseId: course.id, lessonId: null, phase: null, nextPreview: preview,
    nextStep: course.status === 'active' ? '大纲已批准：创建第一课（lesson.create 带 topicId / conceptIds）' : '大纲待批准：出示大纲请学习者批准（或经同意由 AI 代批）',
    links: linksFor(state, course.id, { outline: true }) };
  const part = lesson.parts[lesson.activePartIndex] ?? null;
  const notes = Object.values(state.notes).filter((n) => n.lessonId === lesson.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const attempts = Object.values(state.assessments).filter((a) => a.lessonId === lesson.id).sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))).slice(-3);
  const q = lesson.pendingQuestion ?? null;
  return { courseId: course.id, lessonId: lesson.id, lessonNo: lessons.indexOf(lesson) + 1, lessonTitle: lesson.title, phase: lesson.phase,
    partIndex: lesson.activePartIndex, partTitle: part?.title ?? null, partHasBody: Boolean(part?.body),
    pendingQuestion: q ? { id: q.id, question: q.question, type: q.type ?? 'short', ...(q.options ? { options: q.options } : {}), ...(q.answerKey ? { hasAnswerKey: true } : {}),
      conceptId: q.conceptId, attempts: q.attempts, hintCount: q.hintCount, hintGiven: q.hintCount > 0, hints: q.hints, askedAt: q.askedAt } : null,
    recap: lesson.recap ?? null,
    covered: lesson.parts.filter((p) => p.status === 'covered').map((p) => ({ index: p.index, title: p.title, objective: p.objective })),
    lastAttempts: attempts.map((a) => ({ question: a.question, score: a.score, judgedBy: a.judgedBy ?? 'model-unverified', conceptId: a.conceptId, at: a.recordedAt })),
    lastNote: notes.at(-1) ? { id: notes.at(-1).id, title: notes.at(-1).title } : null,
    topicId: lesson.topicId ?? null, conceptIds: lesson.conceptIds ?? [],
    feedback: lesson.feedback ?? null, adjust: lesson.adjust ?? null, nextPreview: lesson.nextPreview ?? preview,
    nextStep: NEXT_STEP[lesson.phase] ?? '',
    links: linksFor(state, course.id, { lessonIds: [lesson.id], conceptIds: [...(q?.conceptId ? [q.conceptId] : []), ...(lesson.conceptIds ?? [])].slice(0, 8), noteIds: notes.slice(-2).map((n) => n.id) }) };
}
/** Stored references of one lesson part / note, readable (legacy free-text strings included) and clickable. */
export function refsView(state, refs) { return (refs ?? []).map((r) => refView(state, r)); }

/** Board read model: live elements only, concept cards resolved to their current syllabus title. */
export function liveBoard(state, course) {
  const board = state.boards?.[course.id] ?? { courseId: course.id, revision: 0, elements: [] };
  const live = board.elements.filter((e) => !e.deleted);
  const ids = new Set(live.map((e) => e.id));
  return { courseId: course.id, revision: board.revision,
    elements: live.filter((e) => e.type !== 'arrow' || (ids.has(e.from) && ids.has(e.to))).map((e) => {
      if (e.type === 'note' && e.noteId) {
        const n = state.notes?.[e.noteId];
        return { ...e, text: n?.title ?? '(已删除的笔记)', excerpt: n ? String(n.content).slice(0, 140) : '', noteAuthor: n?.author ?? null,
          conceptIds: n?.conceptIds ?? conceptIdsFromAnchors(n?.anchors), lessonId: n?.lessonId ?? null, anchors: n?.anchors ?? e.anchors ?? [], stale: !n };
      }
      if (e.type !== 'concept') return e;
      const c = state.concepts[e.conceptId];
      return { ...e, text: c?.title ?? '(已删除的知识点)', mastery: c?.mastery ?? 'unverified', stale: !c || c.status !== 'active' };
    }) };
}
