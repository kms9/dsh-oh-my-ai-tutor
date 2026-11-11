/** Pure helpers for the React Flow views (no React): graph clusters, edge sides, viewport fit. */

/** Which sides an edge between two rectangles should leave / enter (handle ids r, l, t, b). */
export function edgeSides(a, b) {
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
  const dx = bx - ax, dy = by - ay;
  // Prefer left/right unless the cards are clearly stacked (cards are wider than tall).
  if (Math.abs(dx) * 0.75 >= Math.abs(dy)) return dx >= 0 ? ['r', 'l'] : ['l', 'r'];
  return dy >= 0 ? ['b', 't'] : ['t', 'b'];
}

export const GRAPH_NODE = Object.freeze({ width: 176, height: 66 });
const G = { pad: 14, title: 36, gap: 12, clusterGap: 26, clusterGapX: 96 };
/** Chinese names for the semantic relation types (the type id stays visible in the detail card). */
export const RELATION_LABEL = { prerequisite: '前置', partOf: '组成', explains: '解释', contrasts: '对比', applies: '应用', exampleOf: '举例', relatedTo: '相关' };

/**
 * Knowledge graph layout: one cluster per syllabus topic (syllabus order), knowledge points inside in outline order.
 * With only a handful of candidate relations a force layout scatters the nodes without meaning; clusters keep the
 * course structure readable. `columns` = clusters per row (2 in the right column, 3 when the canvas is wide).
 * Inside a cluster, a node with an outgoing cross-cluster edge sits first and one with an incoming edge last,
 * so relation arrows run between neighbouring clusters instead of across them.
 */
export function graphClusters(nodes, edges, topics, columns = 2, inner = 2) {
  const known = new Set(topics.map((t) => t.id));
  const groups = [...topics.map((t) => ({ id: t.id, title: t.title })), { id: '__other', title: '其他知识点' }]
    .map((g) => ({ ...g, items: nodes.filter((n) => (known.has(n.topicId) ? n.topicId : '__other') === g.id) }))
    .filter((g) => g.items.length);
  const topicOf = new Map(nodes.map((n) => [n.id, known.has(n.topicId) ? n.topicId : '__other']));
  for (const g of groups) {
    const out = new Set(edges.filter((e) => topicOf.get(e.from) === g.id && topicOf.get(e.to) !== g.id).map((e) => e.from));
    const inc = new Set(edges.filter((e) => topicOf.get(e.to) === g.id && topicOf.get(e.from) !== g.id).map((e) => e.to));
    const score = (n) => (out.has(n.id) ? -1 : inc.has(n.id) ? 1 : 0);
    g.items = g.items.map((n, i) => ({ n, i })).sort((a, b) => score(a.n) - score(b.n) || a.i - b.i).map((x) => x.n);
    const cols = Math.min(inner, g.items.length), rows = Math.ceil(g.items.length / cols);
    g.width = G.pad * 2 + inner * GRAPH_NODE.width + (inner - 1) * G.gap;
    g.height = G.title + rows * GRAPH_NODE.height + (rows - 1) * G.gap + G.pad;
    g.cols = cols;
  }
  const clusters = [], positions = new Map();
  let y = 0;
  for (let i = 0; i < groups.length; i += columns) {
    const row = groups.slice(i, i + columns);
    const h = Math.max(...row.map((g) => g.height));
    row.forEach((g, j) => {
      const x = j * (row[0].width + G.clusterGapX);
      clusters.push({ id: g.id, title: g.title, index: topics.findIndex((t) => t.id === g.id), x, y, width: g.width, height: h, count: g.items.length });
      g.items.forEach((n, k) => positions.set(n.id, { x: x + G.pad + (k % g.cols) * (GRAPH_NODE.width + G.gap), y: y + G.title + Math.floor(k / g.cols) * (GRAPH_NODE.height + G.gap), ...GRAPH_NODE }));
    });
    y += h + G.clusterGap;
  }
  const width = clusters.length ? Math.max(...clusters.map((c) => c.x + c.width)) : 0;
  return { clusters, positions, width, height: Math.max(0, y - G.clusterGap), columns, inner };
}

/** The cluster arrangement (clusters per row × knowledge points per cluster row) that shows the graph largest in w×h. */
export function bestGraphLayout(nodes, edges, topics, w, h) {
  let best = null;
  for (const columns of [1, 2, 3, 4]) for (const inner of [1, 2, 3]) {
    const l = graphClusters(nodes, edges, topics, columns, inner);
    if (!l.clusters.length) return l;
    const zoom = Math.min((w || 1) / (l.width + 36), (h || 1) / (l.height + 36));
    // prefer fewer, wider clusters on ties (reads like the outline)
    if (!best || zoom > best.zoom + 0.02) best = { zoom, l };
  }
  return best.l;
}

/**
 * Viewport that shows `bounds` in a `w`×`h` canvas: as large as fits (≤ maxZoom), never below `minZoom` (readable
 * text). When it does not fit, the content is pinned to the top-left corner and `overflow` is true.
 */
export function fitViewport(bounds, w, h, { minZoom = 0.8, maxZoom = 1.15, pad = 18 } = {}) {
  if (!bounds || !w || !h) return { x: 0, y: 0, zoom: 1, overflow: false };
  const fit = Math.min((w - pad * 2) / bounds.width, (h - pad * 2) / bounds.height);
  const zoom = Math.max(minZoom, Math.min(maxZoom, fit));
  const cw = bounds.width * zoom, ch = bounds.height * zoom;
  const x = cw + pad * 2 <= w ? (w - cw) / 2 - bounds.x * zoom : pad - bounds.x * zoom;
  const y = ch + pad * 2 <= h ? Math.min(pad, (h - ch) / 2) - bounds.y * zoom : pad - bounds.y * zoom;
  return { x, y, zoom, overflow: fit < minZoom };
}

export function unionBounds(rects) {
  if (!rects.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.width)), y1 = Math.max(...rects.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
