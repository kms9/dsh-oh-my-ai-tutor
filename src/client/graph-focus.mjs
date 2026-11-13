/**
 * Local views over the knowledge graph (pure; unit-tested in Node). Our own code — the UX follows the idea of a
 * "focus node + prerequisite depth" browser and a diagnosis path, but nothing here is copied from another project.
 *
 * Only `prerequisite` (前置) relations are followed. A relation `A —前置→ B` means "learn A before B", so the
 * prerequisites of B sit above it and the points that use B sit below it. Every relation is still a candidate:
 * these views never turn an arrow into verified knowledge.
 *
 * - focusGraph:      the focused node, N levels of incoming 前置 (1 / 2 / 3 / all) and 1 level of outgoing 前置; when
 *                    there are too many ancestors the farther ones are folded into one node per syllabus topic.
 * - learningPath:    a directed 前置 path between two picked nodes (never an undirected fallback).
 * - learningPathTo:  every prerequisite of one target in learning order (condensed when long; skipped links are
 *                    marked so they can be drawn dotted).
 * - weakIds:         knowledge points (not extensions, not topics) whose mastery is not demonstrated.
 */

export const PREREQ = 'prerequisite';
/** Above this many ancestors the focus view folds the farther ones by topic. */
export const FOLD_AT = 40;
/** Above this many nodes a learning path keeps only the target, its direct prerequisites and the weak points. */
export const PATH_MAX = 24;
/** Depth choices for 「向上 1层 / 2层 / 3层 / 全部」. */
export const FOCUS_DEPTHS = [1, 2, 3, 'all'];
export const DEFAULT_DEPTH = 2;

const depthOf = (up) => (up === 'all' || up === Infinity ? Infinity : Math.max(0, Number(up) || 0));

/** The prerequisite relations of a graph built by buildGraph (relation edges labelled `prerequisite`). */
export function prereqEdges(graph) {
  return graph.edges.filter((e) => e.kind === 'relation' && e.label === PREREQ);
}

function adjacency(edges) {
  const inc = new Map(), out = new Map();
  for (const e of edges) {
    if (!inc.has(e.target)) inc.set(e.target, []);
    inc.get(e.target).push(e);
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }
  return { inc, out };
}

/** A knowledge point whose mastery is not 「已展示」. Extensions have no mastery; topics are not assessed. */
export const isWeak = (n) => !!n && n.kind === 'concept' && n.mastery !== 'demonstrated';
export function weakIds(nodes, ids) {
  const keep = ids ? new Set(ids) : null;
  return new Set(nodes.filter((n) => (!keep || keep.has(n.id)) && isWeak(n)).map((n) => n.id));
}

function topicTitles(graph) {
  return new Map(graph.nodes.filter((n) => n.kind === 'topic').map((n) => [n.topicId, { title: n.label, index: n.topicIndex }]));
}

/** Map edges through `alias` (folded member → fold node), drop self loops, aggregate duplicates (×n). */
function aliasEdges(edges, alias) {
  const seen = new Map();
  for (const e of edges) {
    const source = alias.get(e.source) ?? e.source, target = alias.get(e.target) ?? e.target;
    if (source === target) continue;
    const aggregated = source !== e.source || target !== e.target;
    const key = aggregated ? `fold:${source}>${target}` : e.id;
    if (seen.has(key)) { seen.get(key).members.push(e.id); continue; }
    seen.set(key, { ...e, id: key, source, target, aggregated, members: [e.id] });
  }
  return [...seen.values()];
}

/**
 * One arrow per fold card. A fold usually feeds many kept nodes (each folded member is the prerequisite of a different
 * direct prerequisite), which drew a fan of crossing arrows. Per fold, those edges become ONE `bus` edge: a single
 * stem from the fold card to a rail above the nodes it feeds, with a short tick down to each of them (`via`). It keeps
 * every member relation id (×n on hover) and stays a candidate 前置 like every member. Edges between two fold cards
 * are not drawn (both ends are folded); their relations count on the source fold's arrow. A fold feeding a single
 * kept node keeps its plain (×n) edge.
 */
export function mergeFoldEdges(edges, folds) {
  if (!folds.size) return edges;
  const rest = [];
  const byFold = new Map();
  for (const e of edges) {
    if (!folds.has(e.source)) { rest.push(e); continue; }
    if (!byFold.has(e.source)) byFold.set(e.source, []);
    byFold.get(e.source).push(e);
  }
  const merged = [];
  for (const [fid, es] of byFold) {
    const kept = es.filter((e) => !folds.has(e.target));
    const intoFolds = es.filter((e) => folds.has(e.target)).flatMap((e) => e.members);
    if (!kept.length) { merged.push(...es); continue; } // only feeds other folds: keep those edges
    if (kept.length === 1) { merged.push(intoFolds.length ? { ...kept[0], members: [...kept[0].members, ...intoFolds] } : kept[0]); continue; }
    merged.push({ ...kept[0], id: `fold:${fid}>bus`, target: kept[0].target, aggregated: true, merged: true, bus: true,
      via: kept.map((e) => e.target), members: [...kept.flatMap((e) => e.members), ...intoFolds] });
  }
  return [...rest, ...merged];
}

/**
 * Focus view. `up`: 1 | 2 | 3 | 'all'; `down`: levels of dependents (default 1); `unfold`: show every ancestor.
 * Returns null when the node is not in the graph. Nodes carry `level` (< 0 above, 0 the focus, > 0 below).
 */
export function focusGraph(graph, focusId, { up = DEFAULT_DEPTH, down = 1, foldAt = FOLD_AT, unfold = false } = {}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const focus = byId.get(focusId);
  if (!focus || focus.kind === 'topic') return null;
  const pre = prereqEdges(graph);
  const { inc, out } = adjacency(pre);
  const level = new Map([[focusId, 0]]);
  const walk = (start, max, next, sign) => {
    let frontier = [start];
    for (let d = 1; d <= max && frontier.length; d++) {
      const nxt = [];
      for (const id of frontier) for (const e of next.get(id) ?? []) {
        const other = sign < 0 ? e.source : e.target;
        if (!level.has(other) && byId.has(other)) { level.set(other, sign * d); nxt.push(other); }
      }
      frontier = nxt;
    }
  };
  walk(focusId, depthOf(up), inc, -1);
  walk(focusId, depthOf(down), out, 1);

  const ancestors = [...level].filter(([, l]) => l < 0).map(([id]) => id);
  const alias = new Map();
  const folds = new Map();
  if (!unfold && ancestors.length > foldAt) {
    // keep the nearest levels whole while they fit (level 1 always stays), fold everything farther by topic
    const perLevel = new Map();
    for (const id of ancestors) { const d = -level.get(id); perLevel.set(d, (perLevel.get(d) ?? 0) + 1); }
    let keep = 1, kept = perLevel.get(1) ?? 0;
    while (perLevel.has(keep + 1) && kept + perLevel.get(keep + 1) <= foldAt) { keep += 1; kept += perLevel.get(keep); }
    const titles = topicTitles(graph);
    for (const id of ancestors) {
      if (-level.get(id) <= keep) continue;
      const n = byId.get(id), tid = n.topicId ?? null;
      const fid = `fold:${tid ?? '__other'}`;
      if (!folds.has(fid)) {
        const t = tid ? titles.get(tid) : null;
        folds.set(fid, { id: fid, kind: 'fold', topicId: tid ?? undefined, topicIndex: t?.index ?? n.topicIndex ?? 0, title: t?.title ?? '其他', members: [], level: -Infinity });
      }
      const f = folds.get(fid);
      f.members.push(id);
      f.level = Math.max(f.level, level.get(id)); // the nearest member decides the fold's level
      alias.set(id, fid);
    }
    for (const f of folds.values()) { f.count = f.members.length; f.label = `${f.title} · ${f.count}个`; }
  }

  const members = new Set(level.keys());
  const kept = [
    ...[...level].filter(([id]) => !alias.has(id)).map(([id, l]) => ({ ...byId.get(id), level: l })),
    ...folds.values(),
  ].sort((a, b) => a.level - b.level);
  const nodes = kept;
  const edges = mergeFoldEdges(aliasEdges(pre.filter((e) => members.has(e.source) && members.has(e.target)), alias), folds);
  return {
    kind: 'focus', focusId, up: up === Infinity ? 'all' : up, down,
    graph: { nodes, edges },
    ancestorCount: ancestors.length,
    dependentCount: [...level.values()].filter((l) => l > 0).length,
    foldedCount: alias.size,
    folds: [...folds.values()],
  };
}

function bfsDirected(out, from, to) {
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const e of out.get(cur) ?? []) if (!prev.has(e.target)) { prev.set(e.target, e); queue.push(e.target); }
  }
  if (!prev.has(to)) return null;
  const nodes = [to], edges = [];
  for (let e = prev.get(to); e; e = prev.get(e.source)) { nodes.unshift(e.source); edges.unshift(e.id); }
  return { nodes, edges };
}

/**
 * Directed 前置 path between two picked nodes, in learning order. Tries a → b, then b → a (the learner may pick the
 * target first); `reversed` says which. Returns null when neither direction has a path — never an undirected one.
 */
export function learningPath(graph, a, b) {
  if (!a || !b || a === b) return null;
  const { out } = adjacency(prereqEdges(graph));
  const fwd = bfsDirected(out, a, b);
  const p = fwd ?? bfsDirected(out, b, a);
  if (!p) return null;
  return { directed: true, reversed: !fwd, from: p.nodes[0], to: p.nodes.at(-1), nodes: p.nodes, edges: p.edges };
}

/**
 * Every prerequisite of `target` (any depth) in learning order — a topological order where farther prerequisites
 * come first — ending with the target. Long chains (> maxNodes) are condensed to the target, its direct
 * prerequisites and the weak knowledge points; a kept pair joined only through omitted nodes gets a `skip` edge.
 */
export function learningPathTo(graph, target, { maxNodes = PATH_MAX } = {}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const t = byId.get(target);
  if (!t || t.kind === 'topic') return null;
  const pre = prereqEdges(graph);
  const { inc } = adjacency(pre);
  const dist = new Map([[target, 0]]);
  let frontier = [target];
  for (let d = 1; frontier.length; d++) {
    const nxt = [];
    for (const id of frontier) for (const e of inc.get(id) ?? []) if (!dist.has(e.source) && byId.has(e.source)) { dist.set(e.source, d); nxt.push(e.source); }
    frontier = nxt;
  }
  const inSet = new Set(dist.keys());
  const sub = pre.filter((e) => inSet.has(e.source) && inSet.has(e.target));
  // Kahn's algorithm; among ready nodes the farthest prerequisite (then the label) goes first
  const indeg = new Map([...inSet].map((id) => [id, 0]));
  for (const e of sub) indeg.set(e.target, indeg.get(e.target) + 1);
  const order = [];
  const ready = [...inSet].filter((id) => indeg.get(id) === 0);
  const rank = (x, y) => dist.get(y) - dist.get(x) || String(byId.get(x).label).localeCompare(String(byId.get(y).label)) || x.localeCompare(y);
  const outSub = adjacency(sub).out;
  while (ready.length) {
    ready.sort(rank);
    const id = ready.shift();
    order.push(id);
    for (const e of outSub.get(id) ?? []) { indeg.set(e.target, indeg.get(e.target) - 1); if (indeg.get(e.target) === 0) ready.push(e.target); }
  }
  const weak = weakIds(graph.nodes, order);
  let keep = new Set(order);
  let omitted = 0;
  if (order.length > maxNodes) {
    keep = new Set([target, ...order.filter((id) => dist.get(id) === 1 || weak.has(id))]);
    omitted = order.length - keep.size;
  }
  const edges = sub.filter((e) => keep.has(e.source) && keep.has(e.target)).map((e) => ({ ...e, members: [e.id] }));
  if (omitted) {
    // kept → kept through omitted nodes only: one dotted `skip` edge (unless a direct edge already exists)
    const direct = new Set(edges.map((e) => `${e.source}>${e.target}`));
    const { out } = adjacency(sub);
    for (const s of keep) {
      const seen = new Set([s]); const stack = (out.get(s) ?? []).map((e) => e.target).filter((x) => !keep.has(x));
      const reach = new Set();
      while (stack.length) {
        const cur = stack.pop(); if (seen.has(cur)) continue; seen.add(cur);
        for (const e of out.get(cur) ?? []) { if (keep.has(e.target)) reach.add(e.target); else stack.push(e.target); }
      }
      for (const r of reach) if (!direct.has(`${s}>${r}`)) edges.push({ id: `skip:${s}>${r}`, kind: 'skip', source: s, target: r, label: PREREQ, status: 'candidate', members: [] });
    }
  }
  const ids = order.filter((id) => keep.has(id));
  return {
    kind: 'path', target, nodes: ids, omitted, weak: new Set(ids.filter((id) => weak.has(id))),
    graph: { nodes: ids.map((id) => ({ ...byId.get(id), level: -dist.get(id) })), edges },
  };
}

/** Most cross-topic neighbours a topic view shows as ghost nodes (the rest are counted). */
export const GHOST_MAX = 8;

/**
 * Topic view (narrow canvas): one topic's card — the topic, its nodes and the relations among them — plus, as `ghost`
 * nodes, the nodes of OTHER topics that one of its nodes has a (candidate) relation with, so cross-topic links stay
 * visible without drawing the whole course. Returns null for an unknown topic.
 */
export function topicGraph(graph, topicId, { ghostMax = GHOST_MAX } = {}) {
  const topic = graph.nodes.find((n) => n.kind === 'topic' && n.topicId === topicId);
  if (!topic) return null;
  const members = graph.nodes.filter((n) => n.kind !== 'topic' && n.topicId === topicId);
  const inside = new Set([topic.id, ...members.map((n) => n.id)]);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const ghostIds = [];
  for (const e of graph.edges) {
    if (e.kind !== 'relation') continue;
    const other = inside.has(e.source) && !inside.has(e.target) ? e.target : inside.has(e.target) && !inside.has(e.source) ? e.source : null;
    if (other && byId.get(other)?.kind !== 'topic' && !ghostIds.includes(other)) ghostIds.push(other);
  }
  const shownGhosts = ghostIds.slice(0, ghostMax);
  const keep = new Set([...inside, ...shownGhosts]);
  const nodes = [{ ...topic, collapsed: false, count: members.length }, ...members, ...shownGhosts.map((id) => ({ ...byId.get(id), ghost: true }))];
  const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target) && (e.kind === 'contains' ? inside.has(e.target) : e.kind === 'relation'))
    .map((e) => (e.members ? e : { ...e, members: [e.id] }));
  return { kind: 'topic', topicId, graph: { nodes, edges }, memberCount: members.length, ghostCount: shownGhosts.length, hiddenGhosts: ghostIds.length - shownGhosts.length };
}
