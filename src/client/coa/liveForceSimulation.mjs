// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ported from aws/context-ontology-accelerator
//   packages/web-app/src/components/graph/useLiveForceSimulation.ts @ d28c001cfcc0460cbd1ec1b356a63dcad272790e
// Modifications (dsh-oh-my-ai-tutor, 2026-11-11):
//   - TypeScript → JavaScript.
//   - The body of the hook's effect is split out as the plain factory `createLiveForceSimulation` (so it can be
//     unit-tested under node:test without a DOM); `useLiveForceSimulation` in ../graph-flow.jsx is a thin wrapper.
//   - Option `startPositions` (Map id → centre): nodes that were already on screen restart from where they are, so
//     a live refresh (an AI edit adding one node) does not replay the fly-in for the whole graph. Nodes without a
//     start position keep the original compressed-toward-centroid fly-in.
//   - Option `nodeSizeOf(id)` (per-node diameter, falls back to `nodeSize`) because topic and knowledge-point circles
//     differ in size; `half` is computed per node.
//   - `step(n)` / `simulation` are exposed for tests. Nothing here writes application data: ticks only call setNodes.
//   - (2026-11-12, rect nodes) Option `boxOf(id)` → { w, h }: nodes are rounded rectangles, so centres use w / 2 and
//     h / 2 and the circle `forceCollide` is replaced by `forceRectCollide` (axis-aligned boxes + a gap). Option
//     `homeLinks`: every link's rest length is the distance between its two packed homes and there is no charge, so
//     the packed topic cards are the resting state; links still pull neighbours along while a node is dragged. Nodes
//     start at their homes (no compressed fly-in, which jammed rectangles behind one another).
//     On release the dropped node stays pinned there and every node's current place becomes its home (rest lengths
//     re-read), so neither links nor collisions push it back; rectangles in its way give way instead.
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).

/**
 * Live force simulation for the force-layout graph.
 *
 * `layout.ts` computes a settled, packed layout up front. This hook then keeps
 * a d3-force simulation *running* on top of it so the graph behaves like
 * WebVOWL's: nodes spring into place on load, and dragging a node pins it and
 * re-heats the simulation so its neighbours follow instead of stretching
 * rubber-band edges. Weak "home" forces pull every node back toward its packed
 * position, so the cluster arrangement survives the physics.
 */
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { componentScale, connectedComponents } from './layout.mjs';

/** Fraction of the distance from cluster centroid nodes start at (fly-in). */
const START_COMPRESSION = 0.35;
/** Gap kept between two node rectangles by forceRectCollide. */
export const RECT_GAP = 10;

/**
 * (ours) Collision for axis-aligned rectangles: overlapping pairs (plus `gap`) are pushed apart along the axis of the
 * smaller overlap. O(n²) per tick — fine for the few hundred nodes a course graph shows.
 */
export function forceRectCollide(boxOf, gap = RECT_GAP, strength = 0.7) {
  let nodes = [];
  function force() {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i], ba = boxOf(a.id);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j], bb = boxOf(b.id);
        const dx = (b.x + b.vx) - (a.x + a.vx), dy = (b.y + b.vy) - (a.y + a.vy);
        const ox = (ba.w + bb.w) / 2 + gap - Math.abs(dx), oy = (ba.h + bb.h) / 2 + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        // a pinned node (being dragged, or dropped) does not give way: the other one takes the whole push
        const pa = a.fx != null, pb = b.fx != null;
        if (pa && pb) continue;
        const wa = pa ? 0 : pb ? 2 : 1, wb = pb ? 0 : pa ? 2 : 1;
        if (ox < oy) { const m = (ox / 2) * strength * (dx < 0 ? -1 : 1); a.vx -= m * wa; b.vx += m * wb; }
        else { const m = (oy / 2) * strength * (dy < 0 ? -1 : 1); a.vy -= m * wa; b.vy += m * wb; }
      }
    }
  }
  force.initialize = (ns) => { nodes = ns; };
  return force;
}
/** Sub-pixel jitter below this is not worth a React re-render. */
const MOVE_EPSILON = 0.4;
/** Pull toward the packed position: firm at rest, almost off while dragging so
 *  a dragged node's neighbours follow it instead of snapping back. */
export const HOME_STRENGTH_REST = 0.06;
export const HOME_STRENGTH_DRAG = 0.004;

/**
 * @param {Array<{id: string, position: {x: number, y: number}}>} initialNodes React Flow nodes (top-left positions)
 * @param {Array<{source: string, target: string}>} edges
 * @param {(updater: (prev: any[]) => any[]) => void} setNodes
 * @param {{nodeSize: number, linkDistance: number, nodeRadius?: (id: string) => number,
 *          nodeSizeOf?: (id: string) => number, startPositions?: Map<string, {x: number, y: number}>}} opts
 */
export function createLiveForceSimulation(initialNodes, edges, setNodes, { nodeSize, linkDistance, nodeRadius, nodeSizeOf, boxOf, homeLinks = false, startPositions }) {
  const box = (id) => boxOf?.(id) ?? { w: nodeSizeOf?.(id) ?? nodeSize, h: nodeSizeOf?.(id) ?? nodeSize };
  const halfW = (id) => box(id).w / 2;
  const halfH = (id) => box(id).h / 2;
  const ids = initialNodes.map((n) => n.id);
  const home = new Map(initialNodes.map((n) => [n.id, { x: n.position.x + halfW(n.id), y: n.position.y + halfH(n.id) }]));

  // Start each cluster compressed toward its own centroid so nodes visibly
  // spring out to their places, without flying through other clusters.
  const start = new Map();
  for (const component of connectedComponents(ids, edges)) {
    let cx = 0;
    let cy = 0;
    for (const id of component) {
      const h = home.get(id);
      if (h) {
        cx += h.x;
        cy += h.y;
      }
    }
    cx /= component.length;
    cy /= component.length;
    for (const id of component) {
      const h = home.get(id);
      if (h) {
        // homeLinks (packed rectangles): start at home — a compressed fly-in jams rectangles behind each other
        const k = homeLinks ? 1 : START_COMPRESSION;
        start.set(id, startPositions?.get(id) ?? { x: cx + (h.x - cx) * k, y: cy + (h.y - cy) * k });
      }
    }
  }

  const simNodes = ids.map((id) => {
    const h = home.get(id) ?? { x: 0, y: 0 };
    const s = start.get(id) ?? h;
    return { id, x: s.x, y: s.y, homeX: h.x, homeY: h.y };
  });
  const idSet = new Set(ids);
  const links = edges.filter((e) => idSet.has(e.source) && idSet.has(e.target)).map((e) => ({ source: e.source, target: e.target }));

  const byId = new Map(simNodes.map((n) => [n.id, n]));

  // Per-connected-component spacing scale: a subgraph with a popular hub
  // gets its own larger linkDistance; a 3-node side cluster stays at the
  // baseline. Shared helper so static homes (layout.ts) and this live link
  // force never disagree about preferred edge length.
  const linkScaleByNode = new Map();
  for (const component of connectedComponents(ids, edges)) {
    const compSet = new Set(component);
    const degree = new Map();
    for (const e of edges) {
      if (!compSet.has(e.source) || !compSet.has(e.target)) continue;
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    let compMaxDeg = 0;
    for (const d of degree.values()) if (d > compMaxDeg) compMaxDeg = d;
    const scale = componentScale(compMaxDeg);
    for (const id of component) linkScaleByNode.set(id, scale);
  }

  // Push positions into React state — but only for nodes that actually
  // moved. Re-creating all node objects every tick makes React Flow re-render
  // every node and edge ~60×/s during a drag; reusing the unchanged objects
  // confines re-renders to the cluster that is moving.
  const applyPositions = () => {
    let moved = false;
    setNodes((prev) => {
      const next = prev.map((n) => {
        const s = byId.get(n.id);
        if (!s || s.x === undefined || s.y === undefined) return n;
        const x = s.x - halfW(n.id);
        const y = s.y - halfH(n.id);
        if (Math.abs(x - n.position.x) < MOVE_EPSILON && Math.abs(y - n.position.y) < MOVE_EPSILON) {
          return n;
        }
        moved = true;
        return { ...n, position: { x, y } };
      });
      return moved ? next : prev;
    });
  };

  const simulation = forceSimulation(simNodes)
    .force(
      'link',
      forceLink(links)
        .id((n) => n.id)
        .distance((link) => {
          const src = link.source;
          const sId = typeof src === 'object' ? src.id : String(src);
          if (homeLinks && typeof src === 'object' && typeof link.target === 'object') {
            // rest length = distance between the two homes (re-read after a drag moved the homes)
            return Math.max(40, Math.hypot(src.homeX - link.target.homeX, src.homeY - link.target.homeY));
          }
          return linkDistance * (linkScaleByNode.get(sId) ?? 1);
        })
        .strength(0.6),
    )
    // distanceMax keeps repulsion local so clusters don't push each other
    // across the canvas; the home forces hold the packed arrangement.
    .force('charge', homeLinks ? null : forceManyBody().strength(-linkDistance * 4).distanceMax(linkDistance * 2.5))
    .force('collide', boxOf ? forceRectCollide(box) : forceCollide((n) => (nodeRadius?.(n.id) ?? halfW(n.id)) + 16).iterations(2))
    .force('x', forceX((n) => n.homeX).strength(HOME_STRENGTH_REST))
    .force('y', forceY((n) => n.homeY).strength(HOME_STRENGTH_REST))
    .alpha(1)
    .alphaDecay(0.035)
    .velocityDecay(0.4)
    .on('tick', applyPositions);

  applyPositions(); // show the compressed start before the first tick

  const setHomeStrength = (strength) => {
    simulation.force('x')?.strength(strength);
    simulation.force('y')?.strength(strength);
  };

  return {
    simulation,
    byId,
    stop() { simulation.stop(); },
    /** Run `n` ticks synchronously (tests; d3 does not fire 'tick' for manual ticks, so apply once at the end). */
    step(n = 1) { simulation.stop(); simulation.tick(n); applyPositions(); },
    /** Pin the dragged node to the pointer and re-heat so neighbours follow. */
    onDragStart(nodeId, position) {
      const s = byId.get(nodeId);
      if (!s) return;
      s.fx = position.x + halfW(nodeId);
      s.fy = position.y + halfH(nodeId);
      setHomeStrength(HOME_STRENGTH_DRAG);
      simulation.alphaTarget(0.2).restart();
    },
    onDrag(nodeId, position) {
      const s = byId.get(nodeId);
      if (!s) return;
      s.fx = position.x + halfW(nodeId);
      s.fy = position.y + halfH(nodeId);
    },
    /**
     * Release the node. Only the dragged node adopts its current position as
     * its new home — leaving neighbours' homes untouched so a hover-expanded
     * layout does not get baked in by every drag.
     */
    onDragStop(nodeId) {
      const s = byId.get(nodeId);
      if (!s) return;
      if (!homeLinks) { s.fx = null; s.fy = null; } // packed rectangles: a dropped node stays pinned where it was dropped
      if (homeLinks) {
        // packed rectangles: where everything is now (the dragged node and the neighbours it pulled along) becomes
        // the new resting layout, rest lengths included — otherwise the links pull the node back toward its old place
        for (const n of simNodes) { if (n.x !== undefined) n.homeX = n.x; if (n.y !== undefined) n.homeY = n.y; }
        const link = simulation.force('link');
        link?.distance(link.distance());
      } else {
        if (s.x !== undefined) s.homeX = s.x;
        if (s.y !== undefined) s.homeY = s.y;
      }
      setHomeStrength(HOME_STRENGTH_REST);
      simulation.alphaTarget(0);
    },
    /**
     * Re-invoke `forceCollide`'s radius accessor against every node, so a
     * recently changed per-node radius (e.g. the hover-expansion ref) actually
     * reaches the running simulation. d3-force caches radii at `initialize()`
     * time and never re-reads them per tick; calling `.radius(...)` with the
     * current accessor forces a re-initialize.
     */
    refreshCollide() {
      const collide = simulation.force('collide');
      if (!collide?.radius) return; // forceRectCollide reads boxOf every tick
      collide.radius(collide.radius());
    },
    /** Pin a node at its current simulation position (`fx`/`fy`), so forces cannot move it (hover). */
    pinNode(nodeId) {
      const s = byId.get(nodeId);
      if (!s) return;
      if (s.x !== undefined) s.fx = s.x;
      if (s.y !== undefined) s.fy = s.y;
    },
    /** Release a previously pinned node. No-op for ids the sim does not know. */
    unpinNode(nodeId) {
      const s = byId.get(nodeId);
      if (!s) return;
      s.fx = null;
      s.fy = null;
    },
    /**
     * One-shot alpha boost — gives the sim a burst of energy that decays
     * naturally (via `alphaDecay`), without holding `alphaTarget` above
     * `alphaMin`. Does not touch `alphaTarget`, so a parallel drag keeps ownership of it.
     */
    kickAlpha(value) {
      if (simulation.alpha() < value) simulation.alpha(value);
      simulation.restart();
    },
  };
}
