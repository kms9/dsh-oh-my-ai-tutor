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
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import Dagre from '@dagrejs/dagre';
import { layoutForceGraph } from './layout.mjs';

/** Rendered node diameters (px), shared with the layouts so spacing matches. */
export const NODE_SIZE = { topic: 80, concept: 66 };
/** Preferred edge length for the packed force layout and the live simulation (upstream: 330). */
export const FORCE_LINK_DISTANCE = 110;
export const sizeOfKind = (k) => NODE_SIZE[k] ?? NODE_SIZE.concept;

export function radialPositions(count) {
  if (count <= 0) return [];
  if (count === 1) return [{ x: 0, y: 0 }];
  const radius = Math.max(160, (count * 110) / (2 * Math.PI));
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
  });
}
/** Top-left React Flow positions for the visible nodes. `layout`: 'force' | 'hierarchical'. */
export function layoutGraph(nodes, edges, layout, { aspect = 1.6, canvas } = {}) {
  if (layout === 'force') {
    const pack = (a) => layoutForceGraph(nodes.map((n) => n.id), edges, { nodeSize: NODE_SIZE.topic, linkDistance: FORCE_LINK_DISTANCE, componentGap: 60, aspect: a });
    let positions = pack(aspect);
    // (ours) shelf packing is coarse: for a known canvas try a few target aspects and keep the one that fits best
    if (canvas?.w && canvas?.h && nodes.length <= 200) {
      const zoomOf = (m) => {
        const ps = [...m.values()];
        const w = Math.max(...ps.map((p) => p.x)) - Math.min(...ps.map((p) => p.x)) + NODE_SIZE.topic;
        const h = Math.max(...ps.map((p) => p.y)) - Math.min(...ps.map((p) => p.y)) + NODE_SIZE.topic;
        return Math.min(canvas.w / w, canvas.h / h);
      };
      let best = zoomOf(positions);
      for (const a of [1, 1.5, 2, 3, 4, 5]) {
        if (a === aspect) continue;
        const m = pack(a), z = zoomOf(m);
        if (z > best + 1e-6) { best = z; positions = m; }
      }
    }
    return new Map(nodes.map((n) => [n.id, positions.get(n.id) ?? { x: 0, y: 0 }]));
  }
  if (edges.length === 0) {
    const ps = radialPositions(nodes.length);
    return new Map(nodes.map((n, i) => [n.id, ps[i]]));
  }
  const g = new Dagre.graphlib.Graph({ multigraph: true }).setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', ranksep: 100, nodesep: 40 });
  for (const n of nodes) g.setNode(n.id, { width: sizeOfKind(n.kind) + 40, height: sizeOfKind(n.kind) });
  for (const e of edges) g.setEdge(e.source, e.target, {}, e.id);
  Dagre.layout(g);
  return new Map(nodes.map((n) => {
    const p = g.node(n.id), half = sizeOfKind(n.kind) / 2;
    return [n.id, p ? { x: p.x - half, y: p.y - half } : { x: 0, y: 0 }];
  }));
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

