// Four independent resources (syllabus, concepts, mind map, knowledge graph) and wide anchors.
// Pure helpers used by core transitions and store migration. IDs stay distinct: a mind-map node is never
// forced to share an outline or concept id (skeleton nodes use an `mm-` / `mmroot-` prefix).
export const ANCHOR_TYPES = Object.freeze(['concept', 'topic', 'mindmapNode', 'graphNode', 'relation', 'lesson']);
export const BELONGS_TYPES = Object.freeze(['topic', 'concept']);
const ANCHOR_SET = new Set(ANCHOR_TYPES);
const BELONGS_SET = new Set(BELONGS_TYPES);

export function subConceptIds(sub) {
  if (Array.isArray(sub?.conceptIds) && sub.conceptIds.length) return [...new Set(sub.conceptIds.filter(Boolean))];
  if (sub?.conceptId) return [sub.conceptId];
  return [];
}
export function primaryConceptId(sub) { return subConceptIds(sub)[0] ?? null; }
export function stampSubConcepts(sub, ids) {
  const conceptIds = [...new Set((ids ?? subConceptIds(sub)).filter(Boolean))];
  sub.conceptIds = conceptIds;
  if (conceptIds[0]) sub.conceptId = conceptIds[0];
  else delete sub.conceptId;
  return sub;
}

export function originOf(phase, actor, at) {
  return { phase: phase === 'learning' ? 'learning' : 'authoring', actor: actor ?? 'ai', at: at ?? null };
}

export function canonicalGraphNodeId(conceptId) { return `gn-${conceptId}`; }
export function skeletonMindNodeId(syllabusId) { return `mm-${syllabusId}`; }
export function mindmapRootId(courseId) { return `mmroot-${courseId}`; }

export function conceptIdsFromAnchors(anchors) {
  return (anchors ?? []).filter((a) => a?.type === 'concept' && a.id).map((a) => a.id);
}
export function lessonIdFromAnchors(anchors) {
  return (anchors ?? []).find((a) => a?.type === 'lesson' && a.id)?.id ?? null;
}
export function legacyAnchors({ conceptIds, conceptId, lessonId } = {}) {
  const out = [];
  if (lessonId) out.push({ type: 'lesson', id: lessonId });
  const ids = Array.isArray(conceptIds) && conceptIds.length ? conceptIds : (conceptId ? [conceptId] : []);
  for (const id of ids) if (id && !out.some((a) => a.type === 'concept' && a.id === id)) out.push({ type: 'concept', id });
  return out;
}

function existsInCourse(state, courseId, type, id) {
  if (type === 'concept') return state.concepts[id]?.courseId === courseId ? state.concepts[id] : null;
  if (type === 'topic') {
    const course = state.courses[courseId];
    return course?.syllabus?.topics?.find((t) => t.id === id) ?? null;
  }
  if (type === 'mindmapNode') return mindmapOf(state, courseId)?.nodes?.[id] ?? null;
  if (type === 'graphNode') return state.graphNodes[id]?.courseId === courseId ? state.graphNodes[id] : null;
  if (type === 'relation') return state.relations[id]?.courseId === courseId ? state.relations[id] : null;
  if (type === 'lesson') return state.lessons[id]?.courseId === courseId ? state.lessons[id] : null;
  return null;
}

export function normalizeAnchors(state, courseId, raw, field = 'anchors') {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 40) throw new Error(`${field} must be an array of at most 40 {type,id} anchors`);
  const out = [];
  const seen = new Set();
  for (const a of raw) {
    if (!a || typeof a !== 'object' || !ANCHOR_SET.has(a.type) || typeof a.id !== 'string' || !a.id) {
      throw new Error(`${field} entries must be { type: ${ANCHOR_TYPES.join('|')}, id }`);
    }
    const key = `${a.type}:${a.id}`;
    if (seen.has(key)) continue;
    if (!existsInCourse(state, courseId, a.type, a.id)) throw new Error(`Unknown ${a.type} id in ${field}: ${a.id}`);
    seen.add(key);
    out.push({ type: a.type, id: a.id });
  }
  return out;
}

export function mergeAnchors(state, courseId, anchors, { conceptIds, lessonId } = {}, field = 'anchors') {
  const list = [...(anchors ?? [])];
  if (lessonId && !list.some((a) => a.type === 'lesson' && a.id === lessonId)) list.push({ type: 'lesson', id: lessonId });
  for (const id of conceptIds ?? []) if (id && !list.some((a) => a.type === 'concept' && a.id === id)) list.push({ type: 'concept', id });
  return normalizeAnchors(state, courseId, list, field);
}

export function normalizeBelongsTo(value, field = 'belongsTo') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || !BELONGS_SET.has(value.type) || typeof value.id !== 'string' || !value.id) {
    throw new Error(`${field} must be { type: topic|concept, id } or null`);
  }
  return { type: value.type, id: value.id };
}

export function mindmapOf(state, courseId) { return state.mindmaps?.[courseId] ?? null; }

export function mindmapChildren(nodes, parentId) {
  return Object.values(nodes).filter((n) => n.parentId === parentId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id)));
}

export function reindexSiblings(nodes, parentId) {
  mindmapChildren(nodes, parentId).forEach((n, i) => { n.order = i; });
}

export function collectDescendants(nodes, id) {
  const out = [id];
  for (const child of mindmapChildren(nodes, id)) out.push(...collectDescendants(nodes, child.id));
  return out;
}

export function wouldMindmapCycle(nodes, id, newParentId) {
  if (id === newParentId) return true;
  let cur = newParentId;
  const seen = new Set();
  while (cur) {
    if (cur === id) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = nodes[cur]?.parentId ?? null;
  }
  return false;
}

/** Nested { id, title, children, belongsTo, refersTo, origin, kind } tree used by projections and the editor. */
export function mindmapHierarchy(mindmap, course) {
  if (!mindmap?.nodes || !mindmap.rootId || !mindmap.nodes[mindmap.rootId]) {
    return { id: course.id, title: course.title, children: [], unsaved: true };
  }
  const nodes = mindmap.nodes;
  const walk = (id) => {
    const n = nodes[id];
    const kind = id === mindmap.rootId ? 'root' : (n.belongsTo?.type === 'topic' && !n.refersTo && mindmapChildren(nodes, id).some((c) => c.refersTo) ? 'topic' : (n.refersTo ? 'sub' : 'node'));
    return {
      id: n.id, title: n.title, belongsTo: n.belongsTo ?? null, refersTo: n.refersTo ?? null,
      conceptId: n.refersTo ?? null, origin: n.origin ?? null, kind,
      children: mindmapChildren(nodes, id).map((c) => walk(c.id)),
    };
  };
  return walk(mindmap.rootId);
}

export function buildMindmapFromSyllabus(course, { now, actor } = {}) {
  const origin = originOf('authoring', actor ?? 'system', now);
  const rootId = mindmapRootId(course.id);
  const nodes = {
    [rootId]: { id: rootId, title: course.title, parentId: null, order: 0, belongsTo: null, refersTo: null, origin },
  };
  (course.syllabus?.topics ?? []).forEach((t, ti) => {
    const tid = skeletonMindNodeId(t.id);
    nodes[tid] = { id: tid, title: t.title, parentId: rootId, order: ti, belongsTo: { type: 'topic', id: t.id }, refersTo: null, origin };
    (t.subtopics ?? []).forEach((s, si) => {
      const sid = skeletonMindNodeId(s.id);
      const cid = primaryConceptId(s);
      nodes[sid] = {
        id: sid, title: s.title, parentId: tid, order: si,
        belongsTo: cid ? { type: 'concept', id: cid } : { type: 'topic', id: t.id },
        refersTo: cid ?? null, origin,
      };
    });
  });
  return { courseId: course.id, rootId, revision: 1, updatedAt: now ?? null, nodes };
}

export function mermaidMindmap(hierarchy, tidy) {
  const lines = ['mindmap', `  root((${tidy(hierarchy.title)}))`];
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth + 1);
    for (const c of node.children ?? []) {
      lines.push(`${pad}${tidy(c.title)}`);
      walk(c, depth + 1);
    }
  };
  walk(hierarchy, 1);
  return lines.join('\n');
}

export function ensureCanonicalGraphNode(state, concept, { now, actor } = {}) {
  if (!concept?.id) return null;
  const existing = Object.values(state.graphNodes ?? {}).find((n) => n.courseId === concept.courseId && n.refersTo === concept.id);
  if (existing) return existing;
  const nid = canonicalGraphNodeId(concept.id);
  if (state.graphNodes[nid] && state.graphNodes[nid].refersTo === concept.id) return state.graphNodes[nid];
  if (state.graphNodes[nid] && state.graphNodes[nid].refersTo && state.graphNodes[nid].refersTo !== concept.id) {
    // extremely unlikely collision; allocate a fresh id
  }
  if (!state.graphNodes[nid]) {
    const node = {
      id: nid, courseId: concept.courseId, title: concept.title, description: concept.description ?? '',
      refersTo: concept.id,
      belongsTo: concept.topicId ? { type: 'topic', id: concept.topicId } : null,
      origin: concept.origin ?? originOf('authoring', actor ?? 'system', now ?? concept.updatedAt),
      createdAt: now ?? concept.updatedAt ?? null, updatedAt: now ?? concept.updatedAt ?? null,
    };
    state.graphNodes[nid] = node;
    return node;
  }
  if (!state.graphNodes[nid].refersTo) state.graphNodes[nid].refersTo = concept.id;
  return state.graphNodes[nid];
}

export function graphNodeForConcept(state, courseId, conceptId) {
  if (!conceptId) return null;
  const exact = state.graphNodes[canonicalGraphNodeId(conceptId)];
  if (exact?.courseId === courseId && exact.refersTo === conceptId) return exact;
  return Object.values(state.graphNodes ?? {}).find((n) => n.courseId === courseId && n.refersTo === conceptId) ?? null;
}

/** Accept a graph-node id or a concept id (resolved to its canonical graph node). */
export function resolveGraphEndpoint(state, courseId, value, field) {
  if (typeof value !== 'string' || !value) throw new Error(`${field} is required`);
  const node = state.graphNodes?.[value];
  if (node) {
    if (node.courseId !== courseId) throw new Error(`${field} belongs to another course`);
    return node;
  }
  const viaConcept = graphNodeForConcept(state, courseId, value);
  if (viaConcept) return viaConcept;
  throw new Error(`Unknown graph node or knowledge point id: ${value}`);
}

export function conceptIdOfEndpoint(state, graphNodeId) {
  return state.graphNodes?.[graphNodeId]?.refersTo ?? null;
}

export function remapRelationEndpoints(state, relation) {
  const courseId = relation.courseId;
  const mapOne = (value) => {
    if (state.graphNodes?.[value]) return value;
    if (state.concepts?.[value]) {
      const node = ensureCanonicalGraphNode(state, state.concepts[value]);
      return node.id;
    }
    return value;
  };
  relation.from = mapOne(relation.from);
  relation.to = mapOne(relation.to);
  relation.fromConceptId = conceptIdOfEndpoint(state, relation.from);
  relation.toConceptId = conceptIdOfEndpoint(state, relation.to);
  return relation;
}

/**
 * Idempotent in-place upgrade used when reading older state (JSON files, pre-v4 rows, in-memory tests).
 * Does not bump revision or write events; a later mutate persists the result.
 */
export function normalizeState(state) {
  if (!state.boards) state.boards = {};
  if (!state.mindmaps) state.mindmaps = {};
  if (!state.graphNodes) state.graphNodes = {};
  for (const course of Object.values(state.courses ?? {})) {
    for (const t of course.syllabus?.topics ?? []) for (const s of t.subtopics ?? []) stampSubConcepts(s);
  }
  for (const c of Object.values(state.concepts ?? {})) ensureCanonicalGraphNode(state, c);
  for (const r of Object.values(state.relations ?? {})) remapRelationEndpoints(state, r);
  for (const course of Object.values(state.courses ?? {})) {
    if (!state.mindmaps[course.id] && course.syllabus?.topics?.length) {
      state.mindmaps[course.id] = buildMindmapFromSyllabus(course, { now: course.updatedAt ?? course.createdAt, actor: 'system' });
    }
  }
  for (const n of Object.values(state.notes ?? {})) {
    if (!Array.isArray(n.anchors)) n.anchors = legacyAnchors(n);
    n.conceptIds = conceptIdsFromAnchors(n.anchors);
    const lid = lessonIdFromAnchors(n.anchors);
    if (lid && !n.lessonId) n.lessonId = lid;
  }
  for (const board of Object.values(state.boards ?? {})) {
    for (const e of board.elements ?? []) {
      if (!Array.isArray(e.anchors)) e.anchors = e.conceptId ? [{ type: 'concept', id: e.conceptId }] : [];
    }
  }
  return state;
}

export const MINDMAP_OPS = Object.freeze([
  'addChild', 'insertSibling', 'insertParent', 'remove', 'move', 'rename', 'setBelongsTo',
]);

function requireNode(nodes, id, field = 'id') {
  const n = nodes[id];
  if (!n) throw new Error(`Unknown mind-map node: ${id}`);
  return n;
}

/**
 * Apply one batch of mind-map operations. Mutates `mindmap`. Returns { mindmap, touched }.
 */
export function editMindmap(mindmap, operations, { id: makeId, now, actor, defaultTitle = '新节点' } = {}) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 100) throw new Error('operations must contain 1..100 items');
  const nodes = mindmap.nodes;
  const touched = [];
  const make = (title, parentId, extra = {}) => {
    const node = {
      id: makeId ? makeId('mm') : `mm-${crypto.randomUUID?.() ?? Date.now()}`,
      title, parentId, order: mindmapChildren(nodes, parentId).length,
      belongsTo: extra.belongsTo ?? null, refersTo: extra.refersTo ?? null,
      origin: originOf(extra.phase ?? 'learning', actor, now),
    };
    nodes[node.id] = node;
    touched.push(node.id);
    reindexSiblings(nodes, parentId);
    return node;
  };
  operations.forEach((op, n) => {
    if (!op || typeof op !== 'object' || !MINDMAP_OPS.includes(op.op)) throw new Error(`operations[${n}].op must be one of ${MINDMAP_OPS.join(', ')}`);
    switch (op.op) {
      case 'addChild': {
        const parent = requireNode(nodes, op.parentId, 'parentId');
        const title = (typeof op.title === 'string' && op.title.trim()) ? op.title.trim().slice(0, 160) : defaultTitle;
        const node = make(title, parent.id, { belongsTo: normalizeBelongsTo(op.belongsTo) });
        if (Number.isInteger(op.index) && op.index >= 0) {
          const sibs = mindmapChildren(nodes, parent.id).filter((x) => x.id !== node.id);
          const at = Math.min(op.index, sibs.length);
          sibs.splice(at, 0, node);
          sibs.forEach((x, i) => { x.order = i; });
        }
        break;
      }
      case 'insertSibling': {
        const cur = requireNode(nodes, op.id);
        if (!cur.parentId) throw new Error('The mind-map root cannot have a sibling');
        const title = (typeof op.title === 'string' && op.title.trim()) ? op.title.trim().slice(0, 160) : defaultTitle;
        const node = make(title, cur.parentId, { belongsTo: normalizeBelongsTo(op.belongsTo) ?? (cur.belongsTo ? { ...cur.belongsTo } : null) });
        const sibs = mindmapChildren(nodes, cur.parentId).filter((x) => x.id !== node.id);
        const i = sibs.findIndex((x) => x.id === cur.id);
        const at = op.position === 'before' ? i : i + 1;
        sibs.splice(at, 0, node);
        sibs.forEach((x, j) => { x.order = j; });
        break;
      }
      case 'insertParent': {
        const cur = requireNode(nodes, op.id);
        if (!cur.parentId) throw new Error('The mind-map root cannot have a parent inserted');
        const title = (typeof op.title === 'string' && op.title.trim()) ? op.title.trim().slice(0, 160) : defaultTitle;
        const mid = make(title, cur.parentId, { belongsTo: normalizeBelongsTo(op.belongsTo) });
        const oldParent = cur.parentId, oldOrder = cur.order;
        mid.order = oldOrder;
        cur.parentId = mid.id;
        reindexSiblings(nodes, oldParent);
        reindexSiblings(nodes, mid.id);
        break;
      }
      case 'remove': {
        const ids = (Array.isArray(op.ids) ? op.ids : (op.id ? [op.id] : [])).filter((id) => nodes[id]);
        if (ids.some((id) => id === mindmap.rootId)) throw new Error('The mind-map root cannot be deleted');
        if (!ids.length) throw new Error('remove needs one or more node ids');
        const drop = new Set();
        for (const id of ids) for (const d of collectDescendants(nodes, id)) drop.add(d);
        const parents = new Set();
        for (const id of drop) { parents.add(nodes[id].parentId); delete nodes[id]; }
        for (const p of parents) if (p && nodes[p]) reindexSiblings(nodes, p);
        touched.push(...ids);
        break;
      }
      case 'move': {
        const ids = (Array.isArray(op.ids) ? op.ids : (op.id ? [op.id] : []));
        const target = requireNode(nodes, op.target, 'target');
        if (!ids.length) throw new Error('move needs one or more node ids');
        if (ids.includes(mindmap.rootId) || ids.includes(op.target)) throw new Error('Cannot move the mind-map root or a node onto itself');
        for (const id of ids) {
          requireNode(nodes, id);
          const newParent = op.where === 'in' ? target.id : target.parentId;
          if (!newParent) throw new Error('Cannot move a node next to the root; drop it into the root instead');
          if (wouldMindmapCycle(nodes, id, newParent)) throw new Error('Move would create a cycle');
        }
        const newParent = op.where === 'in' ? target.id : target.parentId;
        for (const id of ids) {
          const node = nodes[id];
          const oldParent = node.parentId;
          node.parentId = newParent;
          reindexSiblings(nodes, oldParent);
        }
        const sibs = mindmapChildren(nodes, newParent).filter((x) => !ids.includes(x.id) || true);
        const moving = ids.map((id) => nodes[id]);
        const rest = mindmapChildren(nodes, newParent).filter((x) => !ids.includes(x.id));
        let at;
        if (op.where === 'in') at = rest.length;
        else if (op.where === 'before') at = rest.findIndex((x) => x.id === target.id);
        else at = rest.findIndex((x) => x.id === target.id) + 1;
        if (at < 0) at = rest.length;
        rest.splice(at, 0, ...moving);
        rest.forEach((x, i) => { x.order = i; });
        touched.push(...ids);
        void sibs;
        break;
      }
      case 'rename': {
        const node = requireNode(nodes, op.id);
        if (typeof op.title !== 'string' || !op.title.trim() || op.title.length > 160) throw new Error('rename.title must be a non-empty string (max 160)');
        node.title = op.title.trim();
        node.updatedAt = now ?? node.updatedAt;
        touched.push(node.id);
        break;
      }
      case 'setBelongsTo': {
        const node = requireNode(nodes, op.id);
        node.belongsTo = normalizeBelongsTo(op.belongsTo);
        touched.push(node.id);
        break;
      }
      default: break;
    }
  });
  mindmap.revision = (Number.isInteger(mindmap.revision) ? mindmap.revision : 1) + 1;
  mindmap.updatedAt = now ?? mindmap.updatedAt;
  return { mindmap, touched };
}

/** Index used by the mind-elixir gesture translator: id → { kind, parentId, siblings, title, refersTo, belongsTo }. */
export function indexMindmap(hierarchy) {
  const index = new Map();
  const walk = (node, parentId, siblings) => {
    index.set(node.id, {
      kind: node.kind ?? (parentId == null ? 'root' : 'node'),
      parentId, siblings, title: node.title,
      refersTo: node.refersTo ?? node.conceptId ?? null,
      belongsTo: node.belongsTo ?? null,
      conceptId: node.refersTo ?? node.conceptId ?? null,
    });
    const childIds = (node.children ?? []).map((c) => c.id);
    for (const c of node.children ?? []) walk(c, node.id, childIds);
  };
  walk(hierarchy, null, []);
  return index;
}

export default {
  ANCHOR_TYPES, BELONGS_TYPES, subConceptIds, primaryConceptId, stampSubConcepts, originOf,
  canonicalGraphNodeId, skeletonMindNodeId, mindmapRootId, conceptIdsFromAnchors, lessonIdFromAnchors,
  legacyAnchors, normalizeAnchors, mergeAnchors, normalizeBelongsTo, mindmapOf, mindmapChildren,
  reindexSiblings, collectDescendants, wouldMindmapCycle, mindmapHierarchy, buildMindmapFromSyllabus,
  mermaidMindmap, ensureCanonicalGraphNode, graphNodeForConcept, resolveGraphEndpoint,
  conceptIdOfEndpoint, remapRelationEndpoints, normalizeState, MINDMAP_OPS, editMindmap, indexMindmap,
};
