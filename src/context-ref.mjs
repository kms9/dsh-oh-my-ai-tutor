// Tutor-resource references for the composer (@ mentions and 「添加到对话」).
// Pure functions over durable state — the browser codec and the workbench RPC both use these so
// the model receives a current snapshot at send time, not a stale insert-time copy.

import { mindmapHierarchy } from './resources.mjs';

/** Source name registered with DSH inputTriggers (also the @-menu group title and codec routing key). */
export const SOURCE_NAME = '学习资源';

/** Kinds that can be referenced in the composer and (except where noted) jumped to from a chat link. */
export const RESOURCE_KINDS = Object.freeze([
  'concept', 'mindmapNode', 'graphNode', 'relation', 'topic', 'outline',
  'card', 'note', 'lesson', 'todo', 'review', 'quiz',
]);

export const RESOURCE_LABEL = Object.freeze({
  concept: '知识点',
  mindmapNode: '导图节点',
  graphNode: '图谱节点',
  relation: '关系',
  topic: '主题',
  outline: '大纲',
  card: '白板卡片',
  note: '笔记',
  lesson: '课时',
  todo: '待办',
  review: '复习卡片',
  quiz: '测这个点',
});

export const RESOURCE_SECTION = Object.freeze({
  concept: '知识点',
  mindmapNode: '思维导图',
  graphNode: '知识图谱',
  relation: '关系',
  topic: '大纲',
  outline: '大纲',
  card: '白板',
  note: '笔记',
  lesson: '课时',
  todo: '待办',
  review: '复习卡片',
  quiz: '知识点',
});

const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const BODY_LIMIT = 12_000;

export const RESOURCE_HINTS = Object.freeze({
  concept: '用 tutor_write concept.rename 改名。知识点不是树；向下扩展请在对应思维导图节点下用 tutor_mindmap_edit 的 addChild，或在图谱中 graphNode.add / relation.propose。不要把扩展自动写入大纲，除非学习者明确要求改大纲（tutor_outline_edit，须重新批准）。掌握与复习只针对知识点。',
  mindmapNode: '用 tutor_mindmap_edit：rename、addChild、insertSibling、insertParent、move、remove、setBelongsTo。导图修改不改大纲。深度不限。扩展节点不是考点，除非明确 concept.promote。',
  graphNode: '用 graphNode.rename / graphNode.remove；扩展是加关联节点（graphNode.add）或 relation.propose（关系永远是 candidate），不是加子节点。不要自动写入大纲。可将扩展 concept.promote 为知识点（仍不写入大纲）。',
  relation: '关系始终是 candidate，不可当成已确认事实。用 relation.propose 添加新关系。',
  topic: '用 tutor_outline_edit 的 renameTopic / addSubtopic / moveTopic / removeTopic 等。大纲只有两层（主题→子主题），且须带 syllabusRevision 与 reason，并重新批准。',
  outline: '用 tutor_outline_edit 增删改主题和子主题；须带 syllabusRevision 和 reason，并重新批准。不要因为改了导图或图谱就改大纲。',
  card: '用 tutor_board_patch 更新或删除卡片，或加便签和箭头。先 tutor_board_read 取最新 revision 和元素 id。',
  note: '用 tutor_write note.update 修改已有笔记的标题或正文；用 note.link 调整 anchors。不要用 note.add 覆盖已有笔记。',
  lesson: '用 lesson.updatePlan 改计划（仅 plan_pending）；用 lesson.partWrite 写讲解。批准计划须学习者同意或明确委托。',
  todo: '用 tutor_todo op:"update"，须带这条待办的 id 和 baseRevision。',
  review: '掌握与复习只针对知识点。仅在学习者于本对话真实回忆或作答后用 tutor_review_rate（须 baseRevision 和 evidence）。不要替学习者评分。',
  quiz: '学习者在知识图谱上点了「测这个点」，请求就这个知识点做一次测验：在相关课时里用 tutor_write lesson.ask 出一道题（带这个 conceptId 和题型；客观题出题时就写入 answerKey），一次只出一题，题目和答案都不要提前透露。等学习者真实作答后再用 assessment.record 记录（客观题由系统按冻结答案判分）。不要替学习者作答，不要编造分数或掌握状态；答对一题也不等于已掌握。',
});

/** Opaque source-owned ref: `kind:courseId:id`. */
export function encodeRef({ kind, courseId, id }) {
  if (!RESOURCE_KINDS.includes(kind) || !ID_RE.test(String(courseId ?? '')) || !ID_RE.test(String(id ?? ''))) return null;
  return `${kind}:${courseId}:${id}`;
}

export function decodeRef(ref) {
  if (typeof ref !== 'string') return null;
  const i = ref.indexOf(':');
  const j = i < 0 ? -1 : ref.indexOf(':', i + 1);
  if (i < 0 || j < 0) return null;
  const kind = ref.slice(0, i);
  const courseId = ref.slice(i + 1, j);
  const id = ref.slice(j + 1);
  if (!RESOURCE_KINDS.includes(kind) || !ID_RE.test(courseId) || !ID_RE.test(id)) return null;
  return { kind, courseId, id };
}

export function clipboardTextFor(ref) {
  const parsed = typeof ref === 'string' ? decodeRef(ref) : ref;
  if (!parsed) return '';
  return `@${parsed.kind}:${parsed.id}`;
}

export function labelFor(kind, title) {
  const prefix = RESOURCE_LABEL[kind] ?? kind;
  const t = String(title ?? '').trim();
  return t ? `${prefix}·${t}` : prefix;
}

/** Build the ReferenceInsert payload consumed by DSH's insert-reference event. */
export function makeReferenceInsert({ kind, courseId, id, title }) {
  const ref = encodeRef({ kind, courseId, id });
  if (!ref) throw new Error('无法编码学习资源引用');
  return { source: SOURCE_NAME, ref, label: labelFor(kind, title), clipboardText: clipboardTextFor(ref) };
}

const clip = (text, max = BODY_LIMIT) => {
  if (text == null) return '';
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}\n（正文已截断）` : s;
};

function requireCourse(state, courseId) {
  const course = state.courses?.[courseId];
  if (!course) throw new Error(`学习资源不存在：课程 ${courseId} 已不在当前学习库中`);
  return course;
}

function missing(kind, id) {
  return new Error(`学习资源不存在：${RESOURCE_LABEL[kind] ?? kind}「${id}」已不在当前课程中`);
}

function topicOfConcept(course, conceptId) {
  for (const t of course.syllabus?.topics ?? []) {
    if ((t.subtopics ?? []).some((s) => s.conceptId === conceptId || s.id === conceptId)) return t;
  }
  return null;
}

function nodeTitle(state, courseId, nodeId) {
  return state.graphNodes?.[nodeId]?.title
    ?? state.concepts?.[state.graphNodes?.[nodeId]?.refersTo]?.title
    ?? state.concepts?.[nodeId]?.title
    ?? nodeId;
}

function cardTitle(state, el) {
  if (!el || el.type === 'arrow') return '';
  if (el.type === 'concept') return state.concepts?.[el.conceptId]?.title ?? el.text ?? '';
  if (el.noteId) return state.notes?.[el.noteId]?.title ?? el.text ?? '';
  return el.text ?? '';
}

function walkMindmap(state, course) {
  const mm = state.mindmaps?.[course.id];
  if (!mm?.nodes) return [];
  const tree = mindmapHierarchy(mm, course);
  const out = [];
  const walk = (n, parent) => {
    out.push({ ...n, parentId: parent?.id ?? null, parentTitle: parent?.title ?? null });
    for (const c of n.children ?? []) walk(c, n);
  };
  walk(tree, null);
  return out;
}

/**
 * Flat catalog of referenceable objects in one course. `extras.todos` / `extras.reviews` come from
 * the SQLite data panel (absent on the JSON store). Unknown or empty courses yield [].
 */
export function catalogFromState(state, courseId, extras = {}) {
  if (!courseId || !state?.courses?.[courseId]) return [];
  const course = state.courses[courseId];
  const items = [];
  const push = (kind, id, title) => {
    if (!id) return;
    items.push({
      kind, id, courseId, title: String(title ?? '').trim() || id,
      section: RESOURCE_SECTION[kind],
      name: `${kind}:${id}`,
    });
  };

  for (const c of Object.values(state.concepts ?? {})) {
    if (c.courseId === courseId && c.status === 'active') push('concept', c.id, c.title);
  }
  for (const n of walkMindmap(state, course)) {
    if (n.kind === 'root') continue;
    push('mindmapNode', n.id, n.title);
  }
  for (const n of Object.values(state.graphNodes ?? {})) {
    if (n.courseId === courseId) push('graphNode', n.id, n.title);
  }
  for (const r of Object.values(state.relations ?? {})) {
    if (r.courseId !== courseId) continue;
    const from = nodeTitle(state, courseId, r.from);
    const to = nodeTitle(state, courseId, r.to);
    push('relation', r.id, `${from} —${r.type}→ ${to}`);
  }
  push('outline', courseId, `大纲（第 ${course.syllabus?.revision ?? 0} 版）`);
  for (const t of course.syllabus?.topics ?? []) push('topic', t.id, t.title);

  const board = state.boards?.[courseId];
  for (const el of board?.elements ?? []) {
    if (el.deleted || el.type === 'arrow') continue;
    push('card', el.id, cardTitle(state, el));
  }
  for (const n of Object.values(state.notes ?? {})) {
    if (n.courseId === courseId) push('note', n.id, n.title);
  }
  for (const l of Object.values(state.lessons ?? {})) {
    if (l.courseId === courseId) push('lesson', l.id, l.title);
  }
  for (const t of extras.todos ?? []) push('todo', t.id, t.title);
  for (const r of extras.reviews ?? []) push('review', r.id, r.concept_title ? `复习「${r.concept_title}」` : r.id);
  return items;
}

/** Case-insensitive filter on title, kind label, section, id and name. Empty query keeps every item. */
export function filterCatalog(items, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => [it.title, it.name, it.id, it.kind, RESOURCE_LABEL[it.kind], it.section]
    .some((v) => String(v ?? '').toLowerCase().includes(q)));
}

export function lexiconNames(items) {
  return items.map((it) => `${it.kind}:${it.id}`);
}

/**
 * Current snapshot of one referenced object. Throws if the course or object is gone
 * (the codec must fail the send — never silently downgrade to clipboard text).
 */
export function resourceSnapshot(state, ref, extras = {}) {
  const parsed = typeof ref === 'string' ? decodeRef(ref) : ref;
  if (!parsed) throw new Error('学习资源引用无效');
  const { kind, courseId, id } = parsed;
  const course = requireCourse(state, courseId);
  const hint = RESOURCE_HINTS[kind];
  const base = { kind, id, courseId, hint };

  if (kind === 'concept' || kind === 'quiz') {
    const c = state.concepts?.[id];
    if (!c || c.courseId !== courseId) throw missing(kind, id);
    const topic = topicOfConcept(course, id);
    const mm = walkMindmap(state, course).filter((n) => n.refersTo === id || n.conceptId === id);
    const gn = Object.values(state.graphNodes ?? {}).find((n) => n.courseId === courseId && n.refersTo === id);
    return {
      ...base, title: c.title, status: c.status, mastery: c.mastery, description: c.description ?? '',
      topicId: c.topicId ?? topic?.id ?? null, topicTitle: topic?.title ?? null,
      mindmapNodeIds: mm.map((n) => n.id), graphNodeId: gn?.id ?? null,
      ...(kind === 'quiz' ? { request: '测这个点：请就这个知识点出一道题，等我作答', conceptId: id } : {}),
    };
  }
  if (kind === 'mindmapNode') {
    const mm = state.mindmaps?.[courseId];
    const node = mm?.nodes?.[id];
    if (!node) throw missing(kind, id);
    const parent = node.parentId ? mm.nodes[node.parentId] : null;
    const children = Object.values(mm.nodes).filter((n) => n.parentId === id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return {
      ...base, title: node.title, parentId: node.parentId ?? null, parentTitle: parent?.title ?? null,
      belongsTo: node.belongsTo ?? null, refersTo: node.refersTo ?? null,
      children: children.map((c) => ({ id: c.id, title: c.title })),
      mindmapRevision: mm.revision ?? 0,
    };
  }
  if (kind === 'graphNode') {
    const node = state.graphNodes?.[id];
    if (!node || node.courseId !== courseId) throw missing(kind, id);
    const related = Object.values(state.relations ?? {}).filter((r) => r.courseId === courseId && (r.from === id || r.to === id));
    return {
      ...base, title: node.title, description: node.description ?? '', refersTo: node.refersTo ?? null,
      belongsTo: node.belongsTo ?? null,
      relations: related.map((r) => ({ id: r.id, type: r.type, status: r.status, from: r.from, to: r.to, note: r.note ?? '' })),
    };
  }
  if (kind === 'relation') {
    const r = state.relations?.[id];
    if (!r || r.courseId !== courseId) throw missing(kind, id);
    return {
      ...base, title: `${nodeTitle(state, courseId, r.from)} —${r.type}→ ${nodeTitle(state, courseId, r.to)}`,
      from: r.from, to: r.to, fromTitle: nodeTitle(state, courseId, r.from), toTitle: nodeTitle(state, courseId, r.to),
      type: r.type, status: r.status, note: r.note ?? '',
      fromConceptId: r.fromConceptId ?? null, toConceptId: r.toConceptId ?? null,
    };
  }
  if (kind === 'topic') {
    const topic = (course.syllabus?.topics ?? []).find((t) => t.id === id);
    if (!topic) throw missing(kind, id);
    return {
      ...base, title: topic.title, description: topic.description ?? '',
      syllabusRevision: course.syllabus.revision,
      subtopics: (topic.subtopics ?? []).map((s) => ({ id: s.id, title: s.title, conceptId: s.conceptId ?? null })),
    };
  }
  if (kind === 'outline') {
    return {
      ...base, title: course.title, syllabusRevision: course.syllabus.revision, status: course.status,
      topics: (course.syllabus.topics ?? []).map((t) => ({
        id: t.id, title: t.title,
        subtopics: (t.subtopics ?? []).map((s) => ({ id: s.id, title: s.title, conceptId: s.conceptId ?? null })),
      })),
    };
  }
  if (kind === 'card') {
    const board = state.boards?.[courseId];
    const el = board?.elements?.find((e) => e.id === id && !e.deleted);
    if (!el || el.type === 'arrow') throw missing(kind, id);
    return {
      ...base, title: cardTitle(state, el), type: el.type, text: el.text ?? '',
      conceptId: el.conceptId ?? null, noteId: el.noteId ?? null,
      boardRevision: board.revision ?? 0,
    };
  }
  if (kind === 'note') {
    const n = state.notes?.[id];
    if (!n || n.courseId !== courseId) throw missing(kind, id);
    return {
      ...base, title: n.title, content: clip(n.content), author: n.author,
      anchors: n.anchors ?? [], conceptIds: n.conceptIds ?? [], lessonId: n.lessonId ?? null,
    };
  }
  if (kind === 'lesson') {
    const l = state.lessons?.[id];
    if (!l || l.courseId !== courseId) throw missing(kind, id);
    return {
      ...base, title: l.title, phase: l.phase, status: l.status,
      topicId: l.topicId ?? null, conceptIds: l.conceptIds ?? [],
      planRevision: l.planRevision ?? 1, activePartIndex: l.activePartIndex ?? 0,
      parts: (l.parts ?? []).map((p, i) => ({
        index: i, title: p.title, objective: p.objective, status: p.status,
        body: p.body ? clip(p.body, 2000) : '',
      })),
    };
  }
  if (kind === 'todo') {
    const t = (extras.todos ?? []).find((x) => x.id === id);
    if (!t) throw missing(kind, id);
    return {
      ...base, title: t.title, status: t.status, dueAt: t.due_at ?? null, note: t.note ?? '',
      conceptId: t.concept_id ?? null, conceptTitle: t.concept_title ?? null, revision: t.revision,
    };
  }
  if (kind === 'review') {
    const r = (extras.reviews ?? []).find((x) => x.id === id);
    if (!r) throw missing(kind, id);
    return {
      ...base, title: r.concept_title ?? id, conceptId: r.concept_id, conceptTitle: r.concept_title,
      state: r.state, dueAt: r.due_at ?? null, lastReviewAt: r.last_review_at ?? null,
      reps: r.reps, lapses: r.lapses, revision: r.revision,
    };
  }
  throw new Error(`学习资源引用无效：未知类型 ${kind}`);
}

function line(key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    if (!value.length) return `${key}：（无）`;
    return `${key}：${typeof value[0] === 'object' ? JSON.stringify(value) : value.join('、')}`;
  }
  if (typeof value === 'object') return `${key}：${JSON.stringify(value)}`;
  return `${key}：${value}`;
}

/** Compact structured block the model can act on. */
export function formatSnapshot(snap) {
  const skip = new Set(['kind', 'id', 'courseId', 'hint', 'title']);
  const lines = [
    `[学习资源 kind=${snap.kind} id=${snap.id} courseId=${snap.courseId}]`,
    line('标题', snap.title),
    ...Object.entries(snap).flatMap(([k, v]) => (skip.has(k) ? [] : [line(k, v)])).filter(Boolean),
    line('可进行的操作', snap.hint),
    '[/学习资源]',
  ];
  return lines.filter(Boolean).join('\n');
}

export function serializeResource(state, ref, extras = {}) {
  return formatSnapshot(resourceSnapshot(state, ref, extras));
}

/** Default course (most recently updated), same rule as the workbench. */
export function defaultCourseId(state) {
  const courses = Object.values(state?.courses ?? {}).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  return courses[0]?.id ?? null;
}

/**
 * Load to-dos and review cards for a course when the store supports the data panel.
 * JSON stores (no store.data) yield empty lists.
 */
export async function loadCatalogExtras(store, courseId) {
  if (!courseId || typeof store.data !== 'function') return { todos: [], reviews: [] };
  try {
    const [todos, reviews] = await Promise.all([
      Promise.resolve(store.data('todos', { courseId })),
      Promise.resolve(store.data('reviews', { courseId })),
    ]);
    return { todos: todos ?? [], reviews: reviews ?? [] };
  } catch {
    return { todos: [], reviews: [] };
  }
}

/** Headless catalog + serialize used by the workbench RPC (and tests). */
export async function contextCatalog(store, courseId) {
  const state = await store.read();
  const id = courseId && state.courses[courseId] ? courseId : defaultCourseId(state);
  if (!id) return { courseId: null, items: [] };
  const extras = await loadCatalogExtras(store, id);
  return { courseId: id, revision: state.revision, items: catalogFromState(state, id, extras) };
}

export async function contextSerialize(store, ref) {
  const parsed = decodeRef(ref);
  if (!parsed) throw new Error('学习资源引用无效');
  const state = await store.read();
  const extras = (parsed.kind === 'todo' || parsed.kind === 'review')
    ? await loadCatalogExtras(store, parsed.courseId)
    : {};
  return { text: serializeResource(state, parsed, extras), snapshot: resourceSnapshot(state, parsed, extras) };
}

