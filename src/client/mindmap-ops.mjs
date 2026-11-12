// Pure mind-map gesture → mindmap.edit operations (no React / mind-elixir), unit tested in test/mindmap-ops.test.mjs.
import { indexMindmap } from '../resources.mjs';

export const PALETTE = ['#6273dd', '#3f9d8f', '#d0883a', '#b0569a', '#5b8ed6', '#7d8a3c', '#c0564b', '#4e6a8a'];

/** Hierarchy → mind-elixir data. Node ids are the mind-map's own ids (not syllabus ids). Depth is unlimited. */
export function toMindData(hierarchy, expanded = new Map()) {
  const walk = (n, i, depth) => ({
    id: n.id, topic: n.title, ...(depth === 0 ? { root: true } : {}),
    expanded: expanded.get(n.id) ?? true,
    ...(depth === 1 ? { branchColor: PALETTE[i % PALETTE.length] } : {}),
    metadata: { kind: n.kind ?? (depth === 0 ? 'root' : 'node'), conceptId: n.conceptId ?? n.refersTo ?? null, refersTo: n.refersTo ?? n.conceptId ?? null, belongsTo: n.belongsTo ?? null },
    children: (n.children ?? []).map((c, j) => walk(c, j, depth + 1)),
  });
  return { nodeData: walk(hierarchy, 0, 0) };
}

export function indexHierarchy(h) { return indexMindmap(h); }

const nextAfter = (siblings, id, skip) => { const rest = siblings.filter((x) => !skip.has(x) || x === id); const i = rest.indexOf(id); return rest.slice(i + 1).find((x) => !skip.has(x)) ?? null; };

/**
 * Translate one mind-elixir gesture into mindmap.edit operations, or a refusal.
 * `index` comes from indexHierarchy / indexMindmap.
 */
export function gestureToOps(index, name, args) {
  const kindOf = (id) => index.get(id)?.kind;
  const titleOf = (id) => index.get(id)?.title ?? '';
  switch (name) {
    case 'addChild': {
      const pid = args.parentId;
      if (!index.get(pid)) return { refuse: '未知的导图节点。' };
      return { ops: [{ op: 'addChild', parentId: pid, title: args.title ?? '新节点' }], summary: '思维导图：添加子节点' };
    }
    case 'insertSibling': {
      const n = index.get(args.id); if (!n || n.kind === 'root' || !n.parentId) return { refuse: '导图根节点不能加兄弟节点。' };
      return { ops: [{ op: 'insertSibling', id: args.id, position: args.position === 'before' ? 'before' : 'after', title: args.title ?? '新节点' }], summary: '思维导图：添加同级节点' };
    }
    case 'insertParent': {
      const n = index.get(args.id); if (!n || n.kind === 'root' || !n.parentId) return { refuse: '导图根节点不能插入父节点。' };
      return { ops: [{ op: 'insertParent', id: args.id, title: args.title ?? '新节点' }], summary: '思维导图：插入父节点' };
    }
    case 'remove': {
      const ids = (args.ids ?? []).filter((id) => index.get(id) && kindOf(id) !== 'root');
      if (!ids.length) return { refuse: '导图根节点不能删除。' };
      return { ops: [{ op: 'remove', ids }], summary: `思维导图：删除「${ids.map(titleOf).join('、').slice(0, 60)}」` };
    }
    case 'move': {
      const { where, ids, target } = args;
      if (!ids?.length || ids.includes(target) || ids.some((id) => kindOf(id) === 'root') || !index.get(target)) return { refuse: '不能这样移动导图节点。' };
      if (where === 'in' && kindOf(target) === 'root') {
        return { ops: ids.map((id) => ({ op: 'move', ids: [id], target, where: 'in' })), summary: `思维导图：把「${ids.map(titleOf).join('、').slice(0, 60)}」移到根下` };
      }
      const n = index.get(ids[0]);
      const label = ids.map(titleOf).join('、').slice(0, 60);
      return { ops: [{ op: 'move', ids, target, where }], summary: where === 'in' ? `思维导图：把「${label}」移到「${titleOf(target)}」下` : `思维导图：移动「${label}」` };
    }
    case 'step': {
      const n = index.get(args.id); if (!n || n.kind === 'root') return { refuse: '' };
      const i = n.siblings.indexOf(args.id);
      if (args.dir < 0 && i === 0) return { refuse: '' };
      if (args.dir > 0 && i === n.siblings.length - 1) return { refuse: '' };
      const target = args.dir < 0 ? n.siblings[i - 1] : n.siblings[i + 1];
      const where = args.dir < 0 ? 'before' : 'after';
      return { ops: [{ op: 'move', ids: [args.id], target, where }], summary: `思维导图：${args.dir < 0 ? '上移' : '下移'}「${n.title}」` };
    }
    case 'rename': {
      const n = index.get(args.id); if (!n) return { refuse: '未知的导图节点。' };
      return { ops: [{ op: 'rename', id: args.id, title: args.title }], summary: `思维导图：重命名为「${args.title}」` };
    }
    default: return { refuse: '' };
  }
}

void nextAfter;
