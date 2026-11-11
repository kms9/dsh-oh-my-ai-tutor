/**
 * Board geometry shared by the store (seed positions) and the workbench (topic sections, "按主题整理").
 *
 * Sections are a VIEW-LAYER grouping in this phase: nothing here is stored. A card belongs to the section of its
 * syllabus topic (concept cards via concept.topicId / the subtopic that owns the concept; notes by where they sit or
 * what they are connected to). The board schema and the CAS contract are unchanged.
 */
export const BOARD_CARD = Object.freeze({ width: 196, height: 72 });
export const SECTION = Object.freeze({ pad: 16, title: 38, gap: 14, cols: 2, columns: 2, sectionGap: 34, origin: 24 });
const SECTION_W = SECTION.pad * 2 + SECTION.cols * BOARD_CARD.width + (SECTION.cols - 1) * SECTION.gap;

/** Section rectangles for an ordered list of { id, count } (topics in syllabus order), laid out in a 2-column grid. */
export function sectionGrid(groups) {
  const out = new Map();
  let y = SECTION.origin;
  for (let i = 0; i < groups.length; i += SECTION.columns) {
    const row = groups.slice(i, i + SECTION.columns);
    let rowH = 0;
    row.forEach((g, j) => {
      const rows = Math.max(1, Math.ceil(g.count / SECTION.cols));
      const height = SECTION.title + SECTION.pad + rows * BOARD_CARD.height + (rows - 1) * SECTION.gap + SECTION.pad;
      out.set(g.id, { x: SECTION.origin + j * (SECTION_W + SECTION.sectionGap), y, width: SECTION_W, height });
      rowH = Math.max(rowH, height);
    });
    y += rowH + SECTION.sectionGap;
  }
  return out;
}

/** Top-left of the k-th card slot inside a section rectangle. */
export function slotPosition(rect, k) {
  return { x: rect.x + SECTION.pad + (k % SECTION.cols) * (BOARD_CARD.width + SECTION.gap),
    y: rect.y + SECTION.title + Math.floor(k / SECTION.cols) * (BOARD_CARD.height + SECTION.gap) };
}

/** Deterministic seed position of a concept card: its slot inside its topic's section (syllabus order). */
export function boardSeedPosition(topics, conceptId) {
  const grid = sectionGrid(topics.map((t) => ({ id: t.id, count: t.subtopics.length })));
  for (const t of topics) {
    const k = t.subtopics.findIndex((s) => s.conceptId === conceptId);
    if (k >= 0) return slotPosition(grid.get(t.id), k);
  }
  return { x: SECTION.origin, y: SECTION.origin };
}

const centre = (e) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 });
const inside = (p, r, margin = 0) => p.x >= r.x - margin && p.x <= r.x + r.width + margin && p.y >= r.y - margin && p.y <= r.y + r.height + margin;

function bbox(cards) {
  const x0 = Math.min(...cards.map((c) => c.x)), y0 = Math.min(...cards.map((c) => c.y));
  const x1 = Math.max(...cards.map((c) => c.x + c.width)), y1 = Math.max(...cards.map((c) => c.y + c.height));
  return { x: x0 - SECTION.pad, y: y0 - SECTION.title, width: x1 - x0 + SECTION.pad * 2, height: y1 - y0 + SECTION.title + SECTION.pad };
}

/**
 * topicId (or null) for every card on the board.
 * - concept card → the syllabus topic that owns the concept (fallback concept.topicId)
 * - note → the section it sits in (by its centre), else the topic of a card it is connected to, else null (free note)
 */
export function assignTopics(elements, topics, concepts = []) {
  const byConcept = new Map();
  for (const t of topics) for (const s of t.subtopics) byConcept.set(s.conceptId, t.id);
  for (const c of concepts) if (!byConcept.has(c.id) && c.topicId && topics.some((t) => t.id === c.topicId)) byConcept.set(c.id, c.topicId);
  const cards = elements.filter((e) => e.type !== 'arrow');
  const out = new Map();
  for (const c of cards) if (c.type === 'concept') out.set(c.id, byConcept.get(c.conceptId) ?? null);
  const conceptFrames = new Map();
  for (const t of topics) {
    const members = cards.filter((c) => out.get(c.id) === t.id);
    if (members.length) conceptFrames.set(t.id, bbox(members));
  }
  const arrows = elements.filter((e) => e.type === 'arrow');
  for (const n of cards.filter((c) => c.type !== 'concept')) {
    const p = centre(n);
    let topic = null;
    for (const t of topics) { const r = conceptFrames.get(t.id); if (r && inside(p, r)) { topic = t.id; break; } }
    if (!topic) for (const a of arrows) {
      const other = a.from === n.id ? a.to : a.to === n.id ? a.from : null;
      if (other && out.get(other)) { topic = out.get(other); break; }
    }
    out.set(n.id, topic);
  }
  return out;
}

/** Section frames for the current card positions (view only): one per topic that has cards on the board. */
export function sectionFrames(elements, topics, concepts = [], assignment = assignTopics(elements, topics, concepts)) {
  const cards = elements.filter((e) => e.type !== 'arrow');
  const frames = [];
  topics.forEach((t, index) => {
    const members = cards.filter((c) => assignment.get(c.id) === t.id);
    if (members.length) frames.push({ id: t.id, title: t.title, index, count: members.length, ...bbox(members) });
  });
  return frames;
}

/**
 * "按主题整理": update operations that move every card into its topic section (syllabus order, notes after the
 * concepts of their topic, unassigned notes in a last "便签" section). Only cards that actually move are touched.
 * Returns at most `max` operations (one board.patch batch).
 */
export function arrangeOps(elements, topics, concepts = [], max = 100) {
  const cards = elements.filter((e) => e.type !== 'arrow');
  const assignment = assignTopics(elements, topics, concepts);
  const order = new Map(topics.flatMap((t) => t.subtopics.map((s) => s.conceptId)).map((c, i) => [c, i]));
  const groups = [...topics.map((t) => ({ id: t.id })), { id: '__free' }].map((g) => {
    const members = cards.filter((c) => (assignment.get(c.id) ?? '__free') === g.id)
      .sort((a, b) => (a.type === 'concept' ? 0 : 1) - (b.type === 'concept' ? 0 : 1)
        || (order.get(a.conceptId) ?? 1e9) - (order.get(b.conceptId) ?? 1e9) || a.y - b.y || a.x - b.x);
    return { id: g.id, members, count: members.length };
  }).filter((g) => g.count);
  const grid = sectionGrid(groups);
  const ops = [];
  for (const g of groups) g.members.forEach((c, k) => {
    const p = slotPosition(grid.get(g.id), k);
    const change = { op: 'update', id: c.id };
    if (c.x !== p.x) change.x = p.x;
    if (c.y !== p.y) change.y = p.y;
    if (c.width !== BOARD_CARD.width) change.width = BOARD_CARD.width;
    if (c.height !== BOARD_CARD.height) change.height = BOARD_CARD.height;
    if (Object.keys(change).length > 2) ops.push(change);
  });
  return ops.slice(0, max);
}
