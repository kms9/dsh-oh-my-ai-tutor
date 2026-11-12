import { snapshot } from './core.mjs';
import { mindmapHierarchy, mermaidMindmap, conceptIdOfEndpoint, isMindmapSkeleton } from './resources.mjs';

const tidy = (s) => String(s ?? '').replace(/[\r\n\t]/g, ' ').replace(/[()\[\]{}<>`"']/g, '').trim().slice(0, 80);
const elementId = (value, prefix) => `${prefix}-${String(value).replace(/[^A-Za-z0-9-]/g, '').slice(0, 110)}`;

/** Four independent resources: outline, mind map, knowledge graph and board are each their own authority. */
export function projectCourse(state, courseId, view = 'mindmap') {
  const data = snapshot(state, courseId);
  const syllabus = data.course.syllabus;
  if (view === 'outline') return { revision: data.revision, courseId: data.course.id, title: data.course.title,
    syllabusRevision: syllabus.revision, approvedAt: syllabus.approvedAt ?? null, status: data.course.status, topics: syllabus.topics };
  if (view === 'mindmap') {
    const mm = data.mindmap;
    const hierarchy = mm ? mindmapHierarchy(mm, data.course) : { id: data.course.id, title: data.course.title, children: [] };
    return { revision: data.revision, courseId: data.course.id, syllabusRevision: syllabus.revision,
      mindmapRevision: mm?.revision ?? 0, rootId: mm?.rootId ?? hierarchy.id,
      skeleton: !mm || isMindmapSkeleton(mm, data.course),
      hierarchy, mermaid: mermaidMindmap(hierarchy, tidy) };
  }
  const conceptById = new Map((data.concepts ?? []).map((c) => [c.id, c]));
  const nodes = (data.graphNodes ?? []).map((n) => {
    const c = n.refersTo ? conceptById.get(n.refersTo) : null;
    return {
      id: n.id, label: n.title, kind: n.refersTo ? 'knowledgePoint' : 'extension',
      refersTo: n.refersTo ?? null, conceptId: n.refersTo ?? null,
      belongsTo: n.belongsTo ?? null, origin: n.origin ?? null,
      mastery: c?.mastery ?? null, topicId: c?.topicId ?? (n.belongsTo?.type === 'topic' ? n.belongsTo.id : null),
      sourceRefs: c?.evidenceRefs ?? [],
    };
  });
  const edges = data.relations.map((r) => ({
    id: r.id, from: r.from, to: r.to,
    fromConceptId: r.fromConceptId ?? conceptIdOfEndpoint({ graphNodes: Object.fromEntries((data.graphNodes ?? []).map((n) => [n.id, n])) }, r.from),
    toConceptId: r.toConceptId ?? conceptIdOfEndpoint({ graphNodes: Object.fromEntries((data.graphNodes ?? []).map((n) => [n.id, n])) }, r.to),
    type: r.type, status: r.status, evidenceRefs: r.evidenceRefs,
  }));
  if (view === 'graph') return { revision: data.revision, courseId: data.course.id, nodes, edges };
  if (view === 'board') return { revision: data.revision, courseId: data.course.id, kind: 'board',
    boardRevision: data.board.revision, elements: data.board.elements };
  if (view === 'whiteboard-seed') {
    // Initial seed only. For edits, list/read same boardId and calculate an idempotent diff
    // against the latest scene revision; never blindly replay these add operations.
    const chosen = nodes.filter((n) => n.conceptId).slice(0, 30);
    const chosenIds = new Set(chosen.map((n) => n.conceptId));
    const ops = [];
    for (let i = 0; i < chosen.length; i++) {
      const n = chosen[i];
      ops.push({ op: 'add', id: elementId(n.conceptId, 'kp'), type: 'rectangle',
        x: (i % 4) * 260, y: Math.floor(i / 4) * 160,
        width: 210, height: 90, text: n.label });
    }
    for (const r of edges) if (chosenIds.has(r.fromConceptId) && chosenIds.has(r.toConceptId) && ops.length < 100) {
      ops.push({ op: 'add', id: elementId(r.id, 'relation'), type: 'arrow',
        startId: elementId(r.fromConceptId, 'kp'), endId: elementId(r.toConceptId, 'kp') });
    }
    return { revision: data.revision, kind: 'whiteboard-seed',
      boardBinding: 'REQUIRED: whiteboard_list/read in the owning DSH Session',
      operations: ops, truncated: nodes.filter((n) => n.conceptId).length > chosen.length || edges.length > ops.length - chosen.length,
      warning: 'Seed ONLY: use whiteboard_read to check current elements and revision before whiteboard_patch. Do not infer semantic graph edits from visual geometry.' };
  }
  throw new Error('view must be outline | mindmap | graph | board | whiteboard-seed');
}
