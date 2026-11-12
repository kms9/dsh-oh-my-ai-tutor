/**
 * Knowledge-graph selection (pure; unit-tested in Node).
 *
 * The other workbench tabs share one knowledge-point selection (a concept id). Graph nodes need not be knowledge
 * points (extension nodes, topics), so the graph keeps a selection of its own — a graph node id — and only syncs the
 * shared knowledge-point selection when the picked node is backed by a knowledge point. A pick remembers the
 * knowledge-point selection it was made under: when another tab changes that selection, the graph follows it again.
 */

/** Graph node (from buildGraph / graph-focus) for an id; null when unknown. */
export const graphNodeById = (graph, id) => (id ? graph.nodes.find((n) => n.id === id) ?? null : null);

/**
 * The learner clicked graph node `id` while the shared knowledge-point selection is `kpSelected`.
 * Returns `{ pick, syncKp }`: `pick` is the graph selection to keep, `syncKp` the concept id to push to the other
 * tabs (null for extension / topic / fold nodes, which leave the shared selection alone).
 */
export function pickGraphNode(graph, id, kpSelected = null) {
  const n = graphNodeById(graph, id);
  if (!n || n.kind === 'fold') return { pick: null, syncKp: null };
  const syncKp = n.kind === 'concept' ? (n.conceptId ?? null) : null;
  return { pick: { id: n.id, kp: syncKp ?? kpSelected ?? null }, syncKp };
}

/**
 * The graph node to show as selected: the graph's own pick while the shared knowledge-point selection is still the one
 * it was made under, otherwise the graph node of the selected knowledge point (accepting a raw graph node id too).
 */
export function resolveGraphSelection(graph, pick, kpSelected = null) {
  if (pick && pick.kp === (kpSelected ?? null)) {
    const n = graphNodeById(graph, pick.id);
    if (n) return n;
  }
  if (!kpSelected) return null;
  return graph.nodes.find((n) => n.kind === 'concept' && (n.conceptId === kpSelected || n.refersTo === kpSelected))
    ?? graph.nodes.find((n) => n.id === kpSelected && n.kind !== 'fold') ?? null;
}

/** What the side panel may offer for a selected graph node: assessment only on knowledge points. */
export function selectionActions(n) {
  const kind = n?.kind;
  return {
    quiz: kind === 'concept',        // 测这个点
    mastery: kind === 'concept',     // 理解状态
    focus: kind === 'concept' || kind === 'extension', // 聚焦 (前置 neighbourhood)
    path: kind === 'concept' || kind === 'extension',  // 学习路径
  };
}

/**
 * Compact relation rows for the side panel: one row per relation touching the selected node (or, for a knowledge
 * point, any graph node backed by it), with the direction seen from the selection and the other end.
 */
export function relationRows(graph, relations, selectedId, conceptId = null) {
  const node = (id) => graph.nodes.find((n) => n.id === id || (n.kind === 'concept' && n.conceptId === id));
  const mine = (id) => id === selectedId || (conceptId && (id === conceptId || node(id)?.conceptId === conceptId));
  const rows = [], seen = new Set();
  for (const r of relations) {
    if (seen.has(r.id)) continue;
    const out = mine(r.from), inn = mine(r.to);
    if (!out && !inn) continue;
    seen.add(r.id);
    const otherId = out ? r.to : r.from;
    const other = node(otherId);
    rows.push({ id: r.id, type: r.type, status: r.status ?? 'candidate', dir: out && inn ? 'self' : out ? 'out' : 'in',
      otherId: other?.id ?? otherId, otherLabel: other?.label ?? otherId, otherKind: other?.kind ?? null });
  }
  return rows;
}
