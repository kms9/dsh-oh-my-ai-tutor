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
export function createLiveForceSimulation(initialNodes, edges, setNodes, { nodeSize, linkDistance, nodeRadius, nodeSizeOf, startPositions }) {
  const halfOf = (id) => (nodeSizeOf?.(id) ?? nodeSize) / 2;
  const ids = initialNodes.map((n) => n.id);
  const home = new Map(initialNodes.map((n) => [n.id, { x: n.position.x + halfOf(n.id), y: n.position.y + halfOf(n.id) }]));

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
        start.set(id, startPositions?.get(id) ?? { x: cx + (h.x - cx) * START_COMPRESSION, y: cy + (h.y - cy) * START_COMPRESSION });
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
        const half = halfOf(n.id);
        const x = s.x - half;
        const y = s.y - half;
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
          return linkDistance * (linkScaleByNode.get(sId) ?? 1);
        })
        .strength(0.6),
    )
    // distanceMax keeps repulsion local so clusters don't push each other
    // across the canvas; the home forces hold the packed arrangement.
    .force('charge', forceManyBody().strength(-linkDistance * 4).distanceMax(linkDistance * 2.5))
    .force('collide', forceCollide((n) => (nodeRadius?.(n.id) ?? halfOf(n.id)) + 16).iterations(2))
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
      s.fx = position.x + halfOf(nodeId);
      s.fy = position.y + halfOf(nodeId);
      setHomeStrength(HOME_STRENGTH_DRAG);
      simulation.alphaTarget(0.2).restart();
    },
    onDrag(nodeId, position) {
      const s = byId.get(nodeId);
      if (!s) return;
      s.fx = position.x + halfOf(nodeId);
      s.fy = position.y + halfOf(nodeId);
    },
    /**
     * Release the node. Only the dragged node adopts its current position as
     * its new home — leaving neighbours' homes untouched so a hover-expanded
     * layout does not get baked in by every drag.
     */
    onDragStop(nodeId) {
      const s = byId.get(nodeId);
      if (!s) return;
      s.fx = null;
      s.fy = null;
      if (s.x !== undefined) s.homeX = s.x;
      if (s.y !== undefined) s.homeY = s.y;
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
      if (!collide) return;
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
