/**
 * Collect incremental board.seed / board.generate operations.
 * Existing live cards keep their positions; only missing knowledge-point cards,
 * missing candidate-relation arrows, and missing extension notes are added.
 */
import { BOARD_CARD, boardSeedPosition } from './board-layout.mjs';
import { skeletonMindNodeIds, mindmapOf, titleKey, conceptIdsFromAnchors } from './resources.mjs';

const CARD = BOARD_CARD;

export function taughtConceptIds(course) {
  const ids = [];
  const seen = new Set();
  for (const t of course.syllabus?.topics ?? []) for (const s of t.subtopics ?? []) {
    const list = s.conceptIds?.length ? s.conceptIds : (s.conceptId ? [s.conceptId] : []);
    for (const cid of list) if (cid && !seen.has(cid)) { seen.add(cid); ids.push(cid); }
  }
  return ids;
}

/** All active knowledge points of the course: syllabus order first, then promoted / out-of-syllabus points. */
export function courseConceptIdsForBoard(state, course) {
  const ids = taughtConceptIds(course);
  const seen = new Set(ids);
  const rest = Object.values(state.concepts ?? {})
    .filter((c) => c.courseId === course.id && c.status === 'active' && !seen.has(c.id))
    .sort((a, b) => String(a.topicId ?? '').localeCompare(String(b.topicId ?? '')) || String(a.title).localeCompare(String(b.title)) || String(a.id).localeCompare(String(b.id)));
  for (const c of rest) ids.push(c.id);
  return ids;
}

function lessonScope(state, course, lessonId) {
  if (!lessonId) return null;
  const lesson = state.lessons[lessonId];
  if (!lesson || lesson.courseId !== course.id) throw new Error(`Unknown lessonId for this course: ${lessonId}`);
  return {
    lesson,
    topicId: lesson.topicId ?? null,
    conceptIds: new Set(lesson.conceptIds ?? []),
  };
}

function belongsToScope(belongsTo, state, scope) {
  if (!scope) return true;
  if (!belongsTo) return false;
  if (belongsTo.type === 'topic') return belongsTo.id === scope.topicId;
  if (belongsTo.type === 'concept') {
    if (scope.conceptIds.has(belongsTo.id)) return true;
    return state.concepts[belongsTo.id]?.topicId === scope.topicId && !!scope.topicId;
  }
  return false;
}

/** Mind-map / graph extension nodes that should appear as annotation cards (not exam items). */
export function extensionNotesForBoard(state, course, lessonId) {
  const scope = lessonScope(state, course, lessonId);
  const notes = [];
  const mm = mindmapOf(state, course.id);
  if (mm?.nodes) {
    const skeleton = skeletonMindNodeIds(course);
    for (const n of Object.values(mm.nodes)) {
      if (!n || n.id === mm.rootId || skeleton.has(n.id) || n.refersTo) continue;
      if (!belongsToScope(n.belongsTo, state, scope)) continue;
      const anchors = [{ type: 'mindmapNode', id: n.id }];
      if (n.belongsTo?.type === 'concept') anchors.push({ type: 'concept', id: n.belongsTo.id });
      else if (n.belongsTo?.type === 'topic') anchors.push({ type: 'topic', id: n.belongsTo.id });
      notes.push({ seedKey: `ext-mm-${n.id}`, text: n.title, anchors, nearConceptId: n.belongsTo?.type === 'concept' ? n.belongsTo.id : null });
    }
  }
  for (const n of Object.values(state.graphNodes ?? {})) {
    if (!n || n.courseId !== course.id || n.refersTo) continue;
    if (!belongsToScope(n.belongsTo, state, scope)) continue;
    const anchors = [{ type: 'graphNode', id: n.id }];
    if (n.belongsTo?.type === 'concept') anchors.push({ type: 'concept', id: n.belongsTo.id });
    else if (n.belongsTo?.type === 'topic') anchors.push({ type: 'topic', id: n.belongsTo.id });
    notes.push({ seedKey: `ext-gn-${n.id}`, text: n.title, anchors, nearConceptId: n.belongsTo?.type === 'concept' ? n.belongsTo.id : null });
  }
  return notes;
}

function overlaps(a, b, gap = 8) {
  return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
}

export function placeNoteNear(elements, near, fallback = { x: 24, y: 24 }) {
  const cards = elements.filter((e) => !e.deleted && e.type !== 'arrow').map((e) => ({ x: e.x, y: e.y, w: e.width ?? CARD.width, h: e.height ?? CARD.height }));
  let x, y;
  if (near) {
    // Sit under the related card (same column). Growing a section downward is easier for the
    // view-layer packer than sticking out into the neighbouring section on the right.
    const group = cards.filter((c) => Math.abs(c.x - near.x) < (near.width ?? CARD.width) + 8);
    const bottom = Math.max(near.y + (near.height ?? CARD.height), ...group.map((c) => c.y + c.h));
    x = near.x; y = bottom + 14;
  } else {
    const maxY = cards.length ? Math.max(...cards.map((c) => c.y + c.h)) : fallback.y;
    x = fallback.x; y = cards.length ? maxY + 34 : fallback.y;
  }
  const box = () => ({ x, y, w: CARD.width, h: CARD.height });
  for (let i = 0; i < 40; i++) {
    if (!cards.some((c) => overlaps(c, box()))) return { x, y };
    y += CARD.height + 14;
  }
  return { x, y };
}


function safeKey(raw, fallback) {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
  return cleaned || fallback;
}

function keyFromText(prefix, text, i = 0) {
  let hash = 0;
  const s = String(text ?? '');
  for (let k = 0; k < s.length; k++) hash = ((hash << 5) - hash + s.charCodeAt(k)) | 0;
  return `${prefix}-${(hash >>> 0).toString(16)}-${i}`.slice(0, 120);
}

function liveBySeedKey(elements, seedKey) {
  return elements.find((e) => e.seedKey === seedKey && !e.deleted);
}

function blockedSeedKey(elements, seedKey) {
  return elements.some((e) => e.seedKey === seedKey && e.deleted && e.deletedBy === 'direct');
}

function noteAlreadyPresent(elements, text, anchors = []) {
  const key = titleKey(text);
  const akey = anchors.map((a) => `${a.type}:${a.id}`).sort().join(',');
  return elements.some((e) => {
    if (e.deleted || e.type !== 'note') return false;
    if (titleKey(e.text) === key && key) return true;
    const ek = (e.anchors ?? []).map((a) => `${a.type}:${a.id}`).sort().join(',');
    return akey && ek === akey;
  });
}

/**
 * Build add operations for missing cards and arrows. Caller applies them with boardPatch (internal ids allowed).
 */
export function collectBoardSeedOps(state, course, board, { lessonId, notes = [] } = {}) {
  const used = new Set(board.elements.map((e) => e.id));
  const cards = new Map(board.elements.filter((e) => !e.deleted && e.type === 'concept').map((e) => [e.conceptId, e.id]));
  const ops = [];
  const planned = board.elements.map((e) => ({ ...e }));

  const conceptIds = courseConceptIdsForBoard(state, course);
  const concepts = Object.values(state.concepts ?? {}).filter((c) => c.courseId === course.id);
  for (const conceptId of conceptIds) {
    if (cards.has(conceptId) || state.concepts[conceptId]?.status !== 'active') continue;
    let cid = `card-${conceptId}`.slice(0, 120);
    if (used.has(cid)) cid = `card-${crypto.randomUUID()}`.slice(0, 120);
    if (used.has(cid)) continue;
    used.add(cid); cards.set(conceptId, cid);
    const pos = boardSeedPosition(course.syllabus.topics, conceptId, concepts);
    ops.push({ op: 'add', type: 'concept', conceptId, id: cid, x: pos.x, y: pos.y });
    planned.push({ id: cid, type: 'concept', conceptId, x: pos.x, y: pos.y, width: CARD.width, height: CARD.height });
  }

  const drawn = new Set(board.elements.filter((e) => e.type === 'arrow' && e.relationId && (!e.deleted || e.deletedBy !== 'cascade')).map((e) => e.relationId));
  for (const r of Object.values(state.relations ?? {})) {
    const fromC = r.fromConceptId ?? state.graphNodes?.[r.from]?.refersTo ?? null;
    const toC = r.toConceptId ?? state.graphNodes?.[r.to]?.refersTo ?? null;
    if (r.courseId !== course.id || drawn.has(r.id) || !fromC || !toC || !cards.has(fromC) || !cards.has(toC)) continue;
    ops.push({ op: 'add', type: 'arrow', from: cards.get(fromC), to: cards.get(toC), label: r.type, relationId: r.id });
    drawn.add(r.id);
  }

  const annotations = [
    ...extensionNotesForBoard(state, course, lessonId),
    ...(notes ?? []).map((n, i) => ({
      seedKey: safeKey(n.seedKey, '') || keyFromText('ext-gen', n.text, i),
      text: n.text,
      anchors: n.anchors ?? [],
      nearConceptId: n.nearConceptId ?? null,
    })),
  ];
  for (const note of annotations) {
    if (!note.text || typeof note.text !== 'string' || !note.text.trim()) continue;
    const text = note.text.trim().slice(0, 500);
    if (note.seedKey && (liveBySeedKey(board.elements, note.seedKey) || blockedSeedKey(board.elements, note.seedKey))) continue;
    if (noteAlreadyPresent(planned, text, note.anchors)) continue;
    let nid = note.seedKey && /^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(note.seedKey) ? note.seedKey.slice(0, 120) : null;
    if (!nid || used.has(nid)) nid = `note-${note.seedKey || text}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
    if (!nid || used.has(nid)) continue;
    const near = note.nearConceptId && cards.has(note.nearConceptId)
      ? planned.find((e) => e.id === cards.get(note.nearConceptId))
      : null;
    const pos = placeNoteNear(planned, near);
    used.add(nid);
    const anchors = note.anchors ?? [];
    const op = { op: 'add', type: 'note', id: nid, text, x: pos.x, y: pos.y, seedKey: note.seedKey, anchors, conceptIds: conceptIdsFromAnchors(anchors) };
    ops.push(op);
    planned.push({ id: nid, type: 'note', text, x: pos.x, y: pos.y, width: CARD.width, height: CARD.height, seedKey: note.seedKey, anchors: note.anchors ?? [] });
  }
  return ops;
}
