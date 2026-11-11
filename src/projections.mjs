import { snapshot } from './core.mjs';

const tidy = (s) => String(s ?? '').replace(/[\r\n\t]/g, ' ').replace(/[()\[\]{}<>`"']/g, '').trim().slice(0, 80);
const elementId = (value, prefix) => `${prefix}-${String(value).replace(/[^A-Za-z0-9-]/g, '').slice(0, 110)}`;

/** Curriculum mind map and semantic knowledge graph are different views. */
export function projectCourse(state, courseId, view = 'mindmap') {
  const data = snapshot(state, courseId);
  const syllabus = data.course.syllabus;
  if (view === 'outline') return { revision: data.revision, courseId: data.course.id, title: data.course.title,
    syllabusRevision: syllabus.revision, approvedAt: syllabus.approvedAt ?? null, status: data.course.status, topics: syllabus.topics };
  if (view === 'mindmap') {
    const hierarchy = { id: data.course.id, title: data.course.title,
      children: data.course.syllabus.topics.map((t) => ({ id: t.id, title: t.title,
        children: t.subtopics.map((s) => ({ id: s.id, title: s.title, conceptId: s.conceptId })) })) };
    const lines = ['mindmap', `  root((${tidy(hierarchy.title)}))`];
    for (const t of hierarchy.children) {
      lines.push(`    ${tidy(t.title)}`);
      for (const s of t.children) lines.push(`      ${tidy(s.title)}`);
    }
    return { revision: data.revision, courseId: data.course.id, syllabusRevision: syllabus.revision, hierarchy, mermaid: lines.join('\n') };
  }
  const order = new Map(syllabus.topics.flatMap((t) => t.subtopics.map((x) => x.conceptId)).map((cid, i) => [cid, i]));
  const nodes = data.concepts.slice().sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9))
    .map((c) => ({ id: c.id, label: c.title, kind: 'knowledgePoint',
    mastery: c.mastery, topicId: c.topicId, sourceRefs: c.evidenceRefs }));
  const edges = data.relations.map((r) => ({ id: r.id, from: r.from, to: r.to,
    type: r.type, status: r.status, evidenceRefs: r.evidenceRefs }));
  if (view === 'graph') return { revision: data.revision, courseId: data.course.id, nodes, edges };
  if (view === 'board') return { revision: data.revision, courseId: data.course.id, kind: 'board',
    boardRevision: data.board.revision, elements: data.board.elements };
  if (view === 'whiteboard-seed') {
    // Initial seed only. For edits, list/read same boardId and calculate an idempotent diff
    // against the latest scene revision; never blindly replay these add operations.
    const chosen = nodes.slice(0, 30);
    const chosenIds = new Set(chosen.map((n) => n.id));
    const ops = [];
    for (let i = 0; i < chosen.length; i++) {
      const n = chosen[i];
      ops.push({ op: 'add', id: elementId(n.id, 'kp'), type: 'rectangle',
        x: (i % 4) * 260, y: Math.floor(i / 4) * 160,
        width: 210, height: 90, text: n.label });
    }
    for (const r of edges) if (chosenIds.has(r.from) && chosenIds.has(r.to) && ops.length < 100) {
      ops.push({ op: 'add', id: elementId(r.id, 'relation'), type: 'arrow',
        startId: elementId(r.from, 'kp'), endId: elementId(r.to, 'kp') });
    }
    return { revision: data.revision, kind: 'whiteboard-seed',
      boardBinding: 'REQUIRED: whiteboard_list/read in the owning DSH Session',
      operations: ops, truncated: nodes.length > chosen.length || edges.length > ops.length - chosen.length,
      warning: 'Seed ONLY: use whiteboard_read to check current elements and revision before whiteboard_patch. Do not infer semantic graph edits from visual geometry.' };
  }
  throw new Error('view must be outline | mindmap | graph | board | whiteboard-seed');
}
