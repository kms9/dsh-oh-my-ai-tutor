// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Pure layout helpers ported from aws/context-ontology-accelerator
//   packages/web-app/src/components/graph/OntologyGraphFlow.tsx @ d28c001cfcc0460cbd1ec1b356a63dcad272790e
//   (radialPositions, circularLayout + layoutGraph, parallelEdgeCurves).
// Modifications (dsh-oh-my-ai-tutor, 2026-11-11): TypeScript → JavaScript; moved out of the component so they can be
//   unit-tested in Node; layoutGraph returns a Map id → top-left position instead of node copies; per-node sizes
//   (topic vs knowledge point); 'hierarchical' is dagre left → right (ranksep 100, nodesep 40, multigraph) instead of
//   top → bottom so a course fits a tall sidebar column; the force call passes linkDistance 110 / componentGap 60 and
//   the packing aspect that best fits the canvas (several are tried) instead of upstream's 330 / 175 / 2.4 for the same reason.
//   (2026-11-12) extra 'tb' layout = dagre top → bottom for the local focus / learning-path views (prerequisites above);
//   node sizes for extension and folded-group nodes; sizeOfNode grows circles a little for long labels (dagre spacing
//   and the live simulation's collision radius use it too).
//   (2026-11-12, later) rounded-rectangle nodes (nodeBox → { w, h }); 'force' homes come from layoutTopicClusters
//   (topic cards packed to the canvas aspect) instead of one force pass over the whole course; dagre uses rect sizes,
//   keeps the local views' levels (minlen), lays a fold card's bus edge out as one edge per target and spaces fold
//   cards apart.
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import Dagre from '@dagrejs/dagre';

/**
 * (2026-11-12, rect nodes) Nodes are rounded rectangles: a fixed-ish width (clamped) with the label wrapping to at
 * most 4 lines. `nodeBox(n)` → { w, h } is the single source of the rendered size; dagre, the packed cluster layout,
 * the live simulation's rectangle collision and the floating edges all use it.
 */
export const NODE_FONT = { topic: 13, concept: 12.5, extension: 12.5, fold: 13.5 };
const LINE_H = { topic: 17, concept: 16.5, extension: 16.5, fold: 17 };
/** Horizontal padding incl. the mastery stripe on knowledge points; vertical padding. */
const PAD_X = { topic: 24, concept: 24, extension: 22, fold: 20 };
const PAD_Y = 14;
export const NODE_W = { topic: [128, 184], concept: [120, 168], extension: [120, 168], fold: [150, 188] };
export const NODE_MIN_H = { topic: 40, concept: 36, extension: 36, fold: 58 };
export const MAX_LINES = 4;
/** Smallest box per kind (one short line), e.g. for a node whose label is not known. */
export const NODE_SIZE = Object.fromEntries(Object.keys(NODE_W).map((k) => [k, { w: NODE_W[k][0], h: NODE_MIN_H[k] }]));
/** Preferred edge length for the live simulation when no packed home distance is known (upstream: 330). */
export const FORCE_LINK_DISTANCE = 110;
/** Visual length of a label: CJK / full-width = 1, ASCII = 0.55 (about half as wide at the same font size). */
export const labelWeight = (s) => [...String(s ?? '')].reduce((w, ch) => w + (ch.charCodeAt(0) < 0x2000 ? 0.55 : 1), 0);
const kindOf = (n) => (NODE_W[n?.kind] ? n.kind : 'concept');
/** Number of wrapped lines a label needs at a given box width (10 % slack for line-breaking rules). */
export function labelLines(n, w) {
  const k = kindOf(n);
  const text = labelWeight(k === 'fold' ? n.title : n?.label) * NODE_FONT[k];
  return Math.max(1, Math.min(MAX_LINES, Math.ceil((text * 1.1) / Math.max(40, w - PAD_X[k]))));
}
/** Rendered size of a node: width = label on one line, clamped to NODE_W; height grows with the wrapped lines. */
export function nodeBox(n) {
  const k = kindOf(n);
  const [lo, hi] = NODE_W[k];
  if (k === 'fold') return { w: hi, h: NODE_MIN_H.fold + (labelLines(n, hi) > 1 ? LINE_H.fold : 0) };
  const text = labelWeight(n?.label) * NODE_FONT[k];
  const w = Math.max(lo, Math.min(hi, Math.ceil(text * 1.1) + PAD_X[k]));
  return { w, h: Math.max(NODE_MIN_H[k], Math.round(PAD_Y + labelLines(n, w) * LINE_H[k])) };
}

/* ─── whole-course layout: topic clusters packed to the canvas ───
 * (ours, 2026-11-12) The old force pass laid the whole course out as one connected blob (relations join the topic
 * clusters) and came out as a wide strip. Instead every topic is a small card: the topic block with its nodes in one
 * column beside it ('side') or in two columns on both sides ('both'), so the dashed 包含 lines never cross a node.
 * The cards are then shelf-packed in syllabus order; the column mode and the shelf width are chosen by trying them
 * all and keeping the arrangement that can be shown at the largest zoom in the canvas. */
export const CLUSTER_GAP = { col: 30, row: 10, x: 30, y: 26 };

/** One topic card. Returns local top-left positions and the card size. */
export function clusterLayout(topic, members, boxOf, mode = 'side') {
  const pos = new Map();
  const tb = topic ? boxOf(topic) : { w: 0, h: 0 };
  const cols = mode === 'both' && members.length > 1 ? [members.filter((_, i) => i % 2 === 1), members.filter((_, i) => i % 2 === 0)] : [[], members];
  const colW = cols.map((c) => Math.max(0, ...c.map((m) => boxOf(m).w)));
  const colH = cols.map((c) => c.reduce((h, m, i) => h + boxOf(m).h + (i ? CLUSTER_GAP.row : 0), 0));
  const height = Math.max(tb.h, ...colH);
  let x = 0;
  const place = (col, ci) => {
    let y = (height - colH[ci]) / 2;
    for (const m of col) { const b = boxOf(m); pos.set(m.id, { x: x + (colW[ci] - b.w) / 2, y }); y += b.h + CLUSTER_GAP.row; }
    x += colW[ci];
  };
  if (cols[0].length) { place(cols[0], 0); x += CLUSTER_GAP.col; }
  if (topic) { pos.set(topic.id, { x, y: (height - tb.h) / 2 }); x += tb.w; }
  if (cols[1].length) { if (topic) x += CLUSTER_GAP.col; place(cols[1], 1); }
  return { pos, w: x, h: height };
}

/** Shelf packing in order: start a new row when the next card would pass `maxWidth`. Rows are centred. */
export function shelfPack(boxes, maxWidth, gap = CLUSTER_GAP) {
  const rows = [];
  let row = null;
  boxes.forEach((b, i) => {
    if (!row || (row.items.length && row.w + gap.x + b.w > maxWidth)) { row = { items: [], w: 0, h: 0 }; rows.push(row); }
    row.w += (row.items.length ? gap.x : 0) + b.w;
    row.h = Math.max(row.h, b.h);
    row.items.push(i);
  });
  const width = Math.max(0, ...rows.map((r) => r.w));
  const offsets = new Array(boxes.length);
  let y = 0;
  for (const r of rows) {
    let x = (width - r.w) / 2;
    for (const i of r.items) { offsets[i] = { x, y: y + (r.h - boxes[i].h) / 2 }; x += boxes[i].w + gap.x; }
    y += r.h + gap.y;
  }
  return { offsets, w: width, h: Math.max(0, y - gap.y) };
}

/** Zoom at which a w × h layout fits the canvas (the fit pads FIT_PAD + an 8 px ring margin per side). */
const fitZoom = (w, h, canvas, pad = 32) => Math.min((canvas.w - 2 * pad) / Math.max(1, w), (canvas.h - 2 * pad) / Math.max(1, h));

/**
 * Cluster-packed positions for the whole-course view. `canvas` = the area the fit can use; without one a 1.6 : 1
 * landscape is assumed. Deterministic. Returns Map id → top-left.
 */
export function layoutTopicClusters(nodes, { canvas, boxOf = nodeBox, maxZoom = 1.2, readableZoom = 0.8 } = {}) {
  const topicIds = new Set(nodes.filter((n) => n.kind === 'topic').map((n) => n.topicId));
  const groups = [];
  const byTopic = new Map();
  for (const n of nodes) if (n.kind === 'topic') { const g = { topic: n, members: [] }; groups.push(g); byTopic.set(n.topicId, g); }
  const loose = { topic: null, members: [] };
  for (const n of nodes) if (n.kind !== 'topic') (topicIds.has(n.topicId) ? byTopic.get(n.topicId) : loose).members.push(n);
  if (loose.members.length) groups.push(loose);
  if (!groups.length) return new Map();
  const known = !!(canvas?.w && canvas?.h);
  const c = known ? canvas : { w: 1600, h: 1000 };
  const cap = known ? maxZoom : Infinity; // no canvas: just aim for a 1.6 : 1 landscape
  let best = null;
  for (const mode of ['side', 'both']) {
    const cards = groups.map((g) => clusterLayout(g.topic, g.members, boxOf, g.members.length > 2 ? mode : 'side'));
    const total = cards.reduce((s, k) => s + k.w, 0) + CLUSTER_GAP.x * (cards.length - 1);
    // every distinct row width the shelf can produce (prefix sums from each card) is a candidate
    const widths = new Set([Math.max(...cards.map((k) => k.w)), total]);
    for (let i = 0; i < cards.length; i++) { let w = 0; for (let j = i; j < cards.length; j++) { w += (j > i ? CLUSTER_GAP.x : 0) + cards[j].w; widths.add(w); } }
    for (const mw of [...widths].sort((a, b) => a - b)) {
      const pk = shelfPack(cards, mw + 0.5);
      const z = Math.min(cap, fitZoom(pk.w, pk.h, c));
      // when nothing fits at the readable zoom (small canvas), an arrangement whose WIDTH still fits at that zoom is
      // preferred: the automatic fit then only overflows vertically (pan / scroll down) instead of cutting cards off
      // at the sides
      const widthOk = !known || pk.w * readableZoom <= c.w - 64;
      const score = z - 1e-7 * pk.w * pk.h; // same zoom: the smaller area wins
      const better = !best || (z >= readableZoom) !== (best.zoom >= readableZoom) ? !best || z >= readableZoom
        : best.zoom >= readableZoom || widthOk === best.widthOk ? score > best.score + 1e-9 : widthOk;
      if (better) best = { score, zoom: z, cards, pk, widthOk };
    }
  }
  const out = new Map();
  best.cards.forEach((card, i) => { const o = best.pk.offsets[i]; for (const [id, p] of card.pos) out.set(id, { x: o.x + p.x, y: o.y + p.y }); });
  return out;
}

export function radialPositions(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];
  const radius = Math.max(160, (count * 110) / (2 * Math.PI));
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}
/** Top-left React Flow positions for the visible nodes. `layout`: 'force' (topic clusters packed to the canvas; the live
 *  simulation runs on top) | 'hierarchical' (dagre left → right) | 'tb' (dagre top → bottom, local views). */
export function layoutGraph(nodes, edges, layout, { canvas, readableZoom } = {}) {
  if (layout === 'force') {
    const m = layoutTopicClusters(nodes, { canvas, readableZoom });
    return new Map(nodes.map((n) => [n.id, m.get(n.id) ?? { x: 0, y: 0 }]));
  }
  if (edges.length === 0) {
    const ps = radialPositions(nodes.length);
    return new Map(nodes.map((n, i) => [n.id, ps[i]]));
  }
  const g = new Dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  // fold cards draw a rail above the row they feed: leave room for one rail per card
  const folds = nodes.filter((n) => n.kind === 'fold').length;
  g.setGraph(layout === 'tb' ? { rankdir: 'TB', ranksep: 56 + Math.min(3, folds) * 12, nodesep: 28, ranker: 'network-simplex' } : { rankdir: 'LR', ranksep: 80, nodesep: 18 });
  const level = new Map(nodes.map((n) => [n.id, n.level]));
  // fold cards get extra room on both sides so two of them never sit edge to edge
  for (const n of nodes) { const b = nodeBox(n); g.setNode(n.id, { width: b.w + (n.kind === 'fold' ? 48 : 0), height: b.h }); }
  for (const e of edges) {
    // a fold card's bus edge (graph-focus mergeFoldEdges) feeds several nodes: lay it out as one edge per target, so
    // dagre keeps the fold above all of them and centred over them; local views keep the computed levels (minlen)
    for (const t of e.via ?? [e.target]) {
      const a = level.get(e.source), b = level.get(t);
      const minlen = layout === 'tb' && Number.isFinite(a) && Number.isFinite(b) ? Math.max(1, b - a) : 1;
      g.setEdge(e.source, t, { minlen }, e.via ? `${e.id}>${t}` : e.id);
    }
  }
  Dagre.layout(g);
  const pos = new Map(nodes.map((n) => {
    const p = g.node(n.id), b = nodeBox(n);
    return [n.id, p ? { x: p.x - b.w / 2, y: p.y - b.h / 2 } : { x: 0, y: 0 }];
  }));
  // local views: a rank wider than the canvas can show at the readable zoom wraps into staggered rows
  if (layout === 'tb' && canvas?.w) wrapRanks(pos, nodes, Math.max(3 * NODE_W.concept[1], (canvas.w - 64) / (readableZoom ?? 0.8)));
  return pos;
}

export const WRAP_GAP = { x: 28, y: 40 };
/**
 * (ours) Wrap wide top → bottom ranks: a rank (same dagre row) wider than `maxRowW` is split into balanced rows,
 * centred on the rank, every other row shifted by half a slot so the straight arrows of one row pass through the gaps
 * of the next; everything below moves down. Mutates and returns `pos` (Map id → top-left).
 */
export function wrapRanks(pos, nodes, maxRowW, gap = WRAP_GAP, boxOf = nodeBox) {
  const ranks = new Map();
  for (const n of nodes) {
    const p = pos.get(n.id); if (!p) continue;
    const b = boxOf(n), cy = Math.round(p.y + b.h / 2);
    if (!ranks.has(cy)) ranks.set(cy, []);
    ranks.get(cy).push({ n, b, p });
  }
  let shift = 0;
  const wrapped = [];
  for (const cy of [...ranks.keys()].sort((a, b) => a - b)) {
    const row = ranks.get(cy).sort((a, b) => a.p.x - b.p.x);
    const width = row.reduce((w, r) => w + r.b.w, 0) + gap.x * (row.length - 1);
    if (width <= maxRowW || row.length <= 3) { for (const r of row) r.p.y += shift; continue; }
    const centre = (Math.min(...row.map((r) => r.p.x)) + Math.max(...row.map((r) => r.p.x + r.b.w))) / 2;
    const slot = Math.max(...row.map((r) => r.b.w)) + gap.x;
    // fewest rows whose widest row (plus the half-slot stagger that equal-length rows get) fits; rows balanced
    let rows = 2, per = Math.ceil(row.length / 2);
    for (; rows < row.length; rows++) {
      per = Math.ceil(row.length / rows);
      const equal = row.length - per * (rows - 1) === per; // the last row is full too → explicit stagger
      if (per * slot - gap.x + (equal ? slot / 2 : 0) <= maxRowW) break;
    }
    const rowH = Math.max(...row.map((r) => r.b.h));
    for (let k = 0; k * per < row.length; k++) {
      const part = row.slice(k * per, (k + 1) * per);
      // equal-length rows get the half-slot stagger explicitly (a shorter row is already offset by centring)
      const stagger = k % 2 && part.length === per ? slot / 2 : 0;
      let x = centre - (part.length * slot - gap.x) / 2 + stagger;
      for (const r of part) { r.p.x = x + (slot - gap.x - r.b.w) / 2; r.p.y = cy - r.b.h / 2 + shift + k * (rowH + gap.y); x += slot; }
    }
    shift += (Math.ceil(row.length / per) - 1) * (rowH + gap.y);
    wrapped.push(row);
  }
  // dagre placed the other ranks for the unwrapped (wide) layout: a rank sticking out of the wrapped band (e.g. the
  // fold cards, centred over their far-left targets) slides back into it, so the whole view stays narrow
  if (wrapped.length) {
    const ext = (rs) => [Math.min(...rs.map((r) => r.p.x)), Math.max(...rs.map((r) => r.p.x + r.b.w))];
    const [l, r] = ext(wrapped.flat());
    for (const row of ranks.values()) {
      if (wrapped.includes(row)) continue;
      const [a, b] = ext(row);
      const dx = b - a > r - l ? (l + r) / 2 - (a + b) / 2 : a < l ? l - a : b > r ? r - b : 0;
      if (dx) for (const q of row) q.p.x += dx;
    }
  }
  return pos;
}

/** Size of an edge-label chip (11 px text, 7 px side padding). */
export const labelChip = (text) => ({ w: Math.ceil(labelWeight(text) * 11) + 16, h: 20 });
const rectReachOf = (b, ux, uy) => Math.min(Math.abs(ux) > 1e-6 ? b.w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? b.h / 2 / Math.abs(uy) : Infinity);
/**
 * (ours) Where along each edge its label chip can sit without covering a node or another chip. `items`:
 * [{ id, source, target, text }]; `boxes`: Map id → { x, y, w, h } (top-left). Tries t = 0.5, then outwards (labelTs);
 * returns Map id → t, or null when there is no free spot (that label then shows only while the edge is lit).
 */
/** Candidate spots along an edge with `free` px between the two boxes: 0.5, then outwards every ~2 px. */
export function labelTs(free) {
  const step = Math.min(0.05, 2 / Math.max(1, free)), out = [0.5];
  for (let d = step; d < 0.5; d += step) out.push(0.5 - d, 0.5 + d);
  return out;
}
export function placeEdgeLabels(items, boxes, { pad = 2 } = {}) {
  const placed = [];
  const out = new Map();
  const hit = (r) => [...boxes.values()].some((b) => r.x < b.x + b.w + pad && b.x < r.x + r.w + pad && r.y < b.y + b.h + pad && b.y < r.y + r.h + pad)
    || placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
  for (const it of items) {
    const a = boxes.get(it.source), b = boxes.get(it.target);
    if (!a || !b) { out.set(it.id, null); continue; }
    const s = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, t = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const len = Math.hypot(t.x - s.x, t.y - s.y) || 1, ux = (t.x - s.x) / len, uy = (t.y - s.y) / len;
    const r0 = rectReachOf(a, ux, uy), r1 = rectReachOf(b, ux, uy);
    const free = len - r0 - r1;
    const chip = labelChip(it.text);
    let got = null;
    if (free > 0) {
      for (const k of labelTs(free)) {
        const d = r0 + free * k, c = { x: s.x + ux * d, y: s.y + uy * d };
        const r = { x: c.x - chip.w / 2, y: c.y - chip.h / 2, w: chip.w, h: chip.h };
        if (!hit(r)) { got = k; placed.push(r); break; }
      }
    }
    out.set(it.id, got);
  }
  return out;
}

/** Spread edges that share the same (unordered) node pair so their labels do not stack (upstream parallelEdgeCurves). */
export function parallelEdgeCurves(edges) {
  const groups = new Map();
  edges.forEach((e, i) => {
    const key = [e.source, e.target].sort().join('\u0000');
    const g = groups.get(key) ?? [];
    g.push(i);
    groups.set(key, g);
  });
  const curves = new Array(edges.length).fill(0);
  for (const indices of groups.values()) {
    const n = indices.length;
    indices.forEach((edgeIndex, k) => {
      const e = edges[edgeIndex];
      const sign = e.source <= e.target ? 1 : -1;
      curves[edgeIndex] = sign * (k - (n - 1) / 2) * 44;
    });
  }
  return curves;
}

