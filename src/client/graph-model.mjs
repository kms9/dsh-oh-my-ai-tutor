/**
 * Knowledge-graph view model (pure; unit-tested in Node). React Flow only renders what this returns.
 * - Category nodes: one per syllabus topic (colour = topic), knowledge points are circles in their topic colour.
 * - Edges: "属于" (topic → knowledge point, structural, from the outline) and semantic relations (directed, labelled,
 *   dashed while candidate). Graph positions are a view: never written to the store.
 * - Collapse (visibleGraph), one-hop neighbours, shortest path and search are our own code; layouts and the live
 *   simulation are the Apache-2.0 port in ./coa/ (see graph-flow.jsx).
 */

export function buildGraph(view, topics) {
  const nodes = [], edges = [];
  const topicOf = new Map();
  topics.forEach((t, i) => {
    nodes.push({ id: `topic:${t.id}`, kind: 'topic', topicId: t.id, topicIndex: i, label: t.title });
    for (const s of t.subtopics) topicOf.set(s.conceptId, t.id);
  });
  const index = new Map(topics.map((t, i) => [t.id, i]));
  for (const n of view.nodes) {
    const tid = topicOf.get(n.id) ?? n.topicId;
    nodes.push({ id: n.id, kind: 'concept', topicId: tid, topicIndex: index.get(tid) ?? 0, label: n.label, mastery: n.mastery });
    if (index.has(tid)) edges.push({ id: `in:${n.id}`, kind: 'contains', source: `topic:${tid}`, target: n.id });
  }
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of view.edges) if (ids.has(e.from) && ids.has(e.to))
    edges.push({ id: e.id, kind: 'relation', source: e.from, target: e.to, label: e.type, status: e.status });
  return { nodes, edges };
}

/**
 * Collapsing a topic hides its knowledge points; their relations are re-attached to the topic node (aggregated,
 * one edge per (from, to, label)) so nothing silently disappears.
 */
export function visibleGraph(graph, collapsed = new Set()) {
  const hidden = new Map(); // conceptId → topic node id
  for (const n of graph.nodes) if (n.kind === 'concept' && collapsed.has(n.topicId)) hidden.set(n.id, `topic:${n.topicId}`);
  const nodes = graph.nodes.filter((n) => !hidden.has(n.id)).map((n) => n.kind === 'topic'
    ? { ...n, collapsed: collapsed.has(n.topicId), count: graph.nodes.filter((c) => c.kind === 'concept' && c.topicId === n.topicId).length } : n);
  const seen = new Map();
  for (const e of graph.edges) {
    if (e.kind === 'contains' && hidden.has(e.target)) continue;
    const source = hidden.get(e.source) ?? e.source, target = hidden.get(e.target) ?? e.target;
    if (source === target) continue;
    const aggregated = source !== e.source || target !== e.target;
    const key = aggregated ? `${source}>${target}>${e.label}` : e.id;
    if (seen.has(key)) { seen.get(key).members.push(e.id); continue; }
    seen.set(key, { ...e, id: aggregated ? `agg:${key}` : e.id, source, target, aggregated, members: [e.id] });
  }
  return { nodes, edges: [...seen.values()] };
}

export function neighbours(edges, id) {
  const out = new Set();
  for (const e of edges) { if (e.source === id) out.add(e.target); if (e.target === id) out.add(e.source); }
  return out;
}

/** Shortest path (undirected BFS over the visible edges). Returns { nodes:[ids], edges:[ids] } or null. */
export function shortestPath(edges, from, to) {
  if (!from || !to || from === to) return null;
  const adj = new Map();
  for (const e of edges) for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push([b, e.id]);
  }
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const [nb, eid] of adj.get(cur) ?? []) if (!prev.has(nb)) { prev.set(nb, [cur, eid]); queue.push(nb); }
  }
  if (!prev.has(to)) return null;
  const nodes = [to], es = [];
  for (let p = prev.get(to); p; p = prev.get(p[0])) { nodes.unshift(p[0]); es.unshift(p[1]); }
  return { nodes, edges: es };
}

/** Case-insensitive substring search on labels (and ids); returns matching node ids in graph order. */
export function searchNodes(nodes, q) {
  const s = String(q ?? '').trim().toLowerCase();
  if (!s) return [];
  return nodes.filter((n) => n.label.toLowerCase().includes(s) || n.id.toLowerCase() === s).map((n) => n.id);
}
