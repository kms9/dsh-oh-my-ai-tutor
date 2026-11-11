// Pure mind-map ↔ outline translation (no React / mind-elixir), unit tested in test/mindmap-ops.test.mjs.
export const PALETTE = ['#6273dd', '#3f9d8f', '#d0883a', '#b0569a', '#5b8ed6', '#7d8a3c', '#c0564b', '#4e6a8a'];
export const TWO_LEVELS = '思维导图只有两层：课程 → 主题 → 知识点，不能再往下加一层。';

/** Course hierarchy → mind-elixir data. Node ids are the syllabus ids, so every gesture maps back to an outline op. */
export function toMindData(hierarchy, expanded = new Map()) {
  return {
    nodeData: {
      id: hierarchy.id, topic: hierarchy.title, root: true, metadata: { kind: 'root' },
      children: hierarchy.children.map((t, i) => ({
        id: t.id, topic: t.title, expanded: expanded.get(t.id) ?? true, branchColor: PALETTE[i % PALETTE.length],
        metadata: { kind: 'topic' },
        children: t.children.map((s) => ({ id: s.id, topic: s.title, metadata: { kind: 'sub', conceptId: s.conceptId } })),
      })),
    },
  };
}

/**
 * Translate one mind-elixir gesture into tutor outline operations (course.editOutline), or a refusal.
 * Pure: easy to unit test. `index` maps id → { kind, topicId, siblings }.
 */
export function indexHierarchy(h) {
  const index = new Map([[h.id, { kind: 'root', siblings: [] }]]);
  const topicIds = h.children.map((t) => t.id);
  for (const t of h.children) {
    index.set(t.id, { kind: 'topic', siblings: topicIds, title: t.title });
    const subIds = t.children.map((s) => s.id);
    for (const s of t.children) index.set(s.id, { kind: 'sub', topicId: t.id, siblings: subIds, title: s.title, conceptId: s.conceptId });
  }
  return index;
}
const nextAfter = (siblings, id, skip) => { const rest = siblings.filter((x) => !skip.has(x) || x === id); const i = rest.indexOf(id); return rest.slice(i + 1).find((x) => !skip.has(x)) ?? null; };

export function gestureToOps(index, name, args) {
  const kindOf = (id) => index.get(id)?.kind;
  switch (name) {
    case 'addChild': {
      const pid = args.parentId, k = kindOf(pid);
      if (k === 'root') return { ops: [{ op: 'addTopic', title: '新主题', subtopics: [{ title: '新知识点' }] }], summary: '思维导图：添加主题' };
      if (k === 'topic') return { ops: [{ op: 'addSubtopic', topicId: pid, title: '新知识点' }], summary: '思维导图：添加知识点' };
      return { refuse: TWO_LEVELS };
    }
    case 'insertSibling': {
      const n = index.get(args.id); if (!n || n.kind === 'root') return { refuse: '课程根节点不能加兄弟节点。' };
      const at = n.siblings.indexOf(args.id) + (args.position === 'before' ? 0 : 1);
      if (n.kind === 'topic') return { ops: [{ op: 'addTopic', title: '新主题', subtopics: [{ title: '新知识点' }], index: at }], summary: '思维导图：添加主题' };
      return { ops: [{ op: 'addSubtopic', topicId: n.topicId, title: '新知识点', index: at }], summary: '思维导图：添加知识点' };
    }
    case 'remove': {
      const ids = args.ids.filter((id) => kindOf(id) && kindOf(id) !== 'root');
      // a topic removal already covers its knowledge points
      const topics = new Set(ids.filter((id) => kindOf(id) === 'topic'));
      const ops = ids.filter((id) => kindOf(id) === 'topic' || !topics.has(index.get(id).topicId))
        .map((id) => (kindOf(id) === 'topic' ? { op: 'removeTopic', topicId: id } : { op: 'removeSubtopic', subtopicId: id }));
      if (!ops.length) return { refuse: '课程根节点不能删除。' };
      return { ops, summary: `思维导图：删除「${ids.map((id) => index.get(id).title).join('、').slice(0, 60)}」` };
    }
    case 'move': {
      // where: 'before' | 'after' | 'in'; ids: dragged nodes; target: drop node id
      const { where, ids, target } = args;
      const tk = kindOf(target);
      const kinds = new Set(ids.map(kindOf));
      if (kinds.size !== 1 || kinds.has('root') || ids.includes(target)) return { refuse: TWO_LEVELS };
      const kind = [...kinds][0];
      const moving = new Set(ids);
      const label = ids.map((id) => index.get(id).title).join('、').slice(0, 60);
      if (where === 'in') {
        if (kind === 'sub' && tk === 'topic') return { ops: ids.map((id) => ({ op: 'moveSubtopic', subtopicId: id, toTopicId: target, beforeId: null })), summary: `思维导图：把「${label}」移到「${index.get(target).title}」` };
        if (kind === 'topic' && tk === 'root') return { ops: ids.map((id) => ({ op: 'moveTopic', topicId: id, beforeId: null })), summary: `思维导图：移动「${label}」` };
        return { refuse: TWO_LEVELS };
      }
      if (tk !== kind) return { refuse: kind === 'topic' ? '主题只能和主题调换位置。' : '知识点只能放在主题下面（或别的知识点前后）。' };
      const t = index.get(target);
      const beforeId = where === 'before' ? target : nextAfter(t.siblings, target, moving);
      if (kind === 'topic') return { ops: ids.map((id) => ({ op: 'moveTopic', topicId: id, beforeId })), summary: `思维导图：移动「${label}」` };
      return { ops: ids.map((id) => ({ op: 'moveSubtopic', subtopicId: id, toTopicId: t.topicId, beforeId })), summary: `思维导图：拖动「${label}」` };
    }
    case 'step': {
      const n = index.get(args.id); if (!n || n.kind === 'root') return { refuse: '' };
      const i = n.siblings.indexOf(args.id);
      if (args.dir < 0 && i === 0) return { refuse: '' };
      if (args.dir > 0 && i === n.siblings.length - 1) return { refuse: '' };
      const beforeId = args.dir < 0 ? n.siblings[i - 1] : (n.siblings[i + 2] ?? null);
      const op = n.kind === 'topic' ? { op: 'moveTopic', topicId: args.id, beforeId } : { op: 'moveSubtopic', subtopicId: args.id, beforeId };
      return { ops: [op], summary: `思维导图：${args.dir < 0 ? '上移' : '下移'}「${n.title}」` };
    }
    case 'rename': {
      const n = index.get(args.id); if (!n || n.kind === 'root') return { refuse: '课程标题不在思维导图里修改。' };
      return { ops: [n.kind === 'topic' ? { op: 'renameTopic', topicId: args.id, title: args.title } : { op: 'renameSubtopic', subtopicId: args.id, title: args.title }], summary: `思维导图：重命名为「${args.title}」` };
    }
    default: return { refuse: '' };
  }
}

