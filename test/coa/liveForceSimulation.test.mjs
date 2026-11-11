// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ported from aws/context-ontology-accelerator
//   packages/web-app/src/components/graph/useLiveForceSimulation.test.ts @ d28c001cfcc0460cbd1ec1b356a63dcad272790e
// Modifications (dsh-oh-my-ai-tutor, 2026-11-11): the hook's body is the factory createLiveForceSimulation here, so
//   renderHook/act are replaced by direct factory calls (unmount → stop(), rerender with a new node set → a new
//   factory call); requestAnimationFrame stubbing is unnecessary because every case stops the d3 timer right after
//   setup. Assertions are otherwise the upstream ones, plus one case for our `startPositions` option.
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import { describe, it, expect, fn } from './vitest-shim.mjs';
import { createLiveForceSimulation } from '../../src/client/coa/liveForceSimulation.mjs';

function nodes() {
  return [
    { id: 'a', type: 'ontology', position: { x: 0, y: 0 }, data: { id: 'a', label: 'A', kind: 'class' } },
    { id: 'b', type: 'ontology', position: { x: 200, y: 0 }, data: { id: 'b', label: 'B', kind: 'class' } },
  ];
}
const edges = [{ id: 'e', source: 'a', target: 'b' }];
const opts = { nodeSize: 80, linkDistance: 170 };
const make = (ns, setNodes, o = opts) => { const sim = createLiveForceSimulation(ns, edges, setNodes, o); sim.stop(); return sim; };

describe('useLiveForceSimulation (factory)', () => {
  it('paints node positions into React state on setup', () => {
    const setNodes = fn();
    make(nodes(), setNodes);
    // The hook applies positions once synchronously ("paint the compressed start before the first tick").
    expect(setNodes).toHaveBeenCalled();
    // It updates via the functional form so it never clobbers concurrent state.
    expect(typeof setNodes.mock.calls[0][0]).toBe('function');
  });

  it('drag start / drag / stop run without throwing and reheat the sim', () => {
    const sim = make(nodes(), fn());
    sim.onDragStart('a', { x: 10, y: 10 });
    expect(sim.simulation.alphaTarget()).toBe(0.2);
    sim.onDrag('a', { x: 40, y: 20 });
    expect(sim.byId.get('a').fx).toBe(80);
    sim.onDragStop('a');
    expect(sim.simulation.alphaTarget()).toBe(0);
    expect(sim.byId.get('a').fx).toBeNull();
    sim.stop();
  });

  it('ignores drag callbacks for an unknown node id', () => {
    const sim = make(nodes(), fn());
    sim.onDragStart('ghost', { x: 0, y: 0 });
    sim.onDragStop('ghost');
    expect(sim.simulation.alphaTarget()).toBe(0);
  });

  it('cleans up without throwing', () => {
    const sim = make(nodes(), fn());
    sim.stop();
    sim.stop();
  });

  it('exposes refreshCollide and kickAlpha and both are safe to call', () => {
    const sim = make(nodes(), fn());
    expect(typeof sim.refreshCollide).toBe('function');
    expect(typeof sim.kickAlpha).toBe('function');
    sim.refreshCollide();
    sim.kickAlpha(0.25);
    sim.stop();
  });

  it('refreshCollide re-invokes the per-node radius accessor (hover fix)', () => {
    let fatRadius = false;
    const nodeRadius = (id) => (id === 'a' && fatRadius ? 200 : 40);
    const seen = [];
    const tracingRadius = (id) => { const r = nodeRadius(id); seen.push(r); return r; };
    const sim = make(nodes(), fn(), { ...opts, nodeRadius: tracingRadius });
    const seenAtMount = seen.length;
    // Flip the ref so a refresh must see the new radius for 'a'.
    fatRadius = true;
    sim.refreshCollide();
    expect(seen.length).toBeGreaterThan(seenAtMount);
    // The last pass sampled the inflated radius.
    expect(seen.slice(seenAtMount)).toContain(200);
  });

  it('exposes pinNode / unpinNode and both are safe to call', () => {
    const sim = make(nodes(), fn());
    sim.pinNode('a');
    expect(sim.byId.get('a').fx).toBe(sim.byId.get('a').x);
    sim.unpinNode('a');
    expect(sim.byId.get('a').fx).toBeNull();
    // Unknown ids are silently ignored.
    sim.pinNode('ghost');
    sim.unpinNode('ghost');
  });

  it('re-applies positions when the node set changes', () => {
    const setNodes = fn();
    make(nodes(), setNodes);
    const callsAfterMount = setNodes.mock.calls.length;
    const extended = [...nodes(), { id: 'c', type: 'ontology', position: { x: 400, y: 0 }, data: { id: 'c', label: 'C', kind: 'class' } }];
    make(extended, setNodes);
    expect(setNodes.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it('(ours) startPositions: nodes already on screen restart where they are instead of flying in', () => {
    let view = nodes();
    const sim = make(view, (u) => { view = u(view); }, { ...opts, startPositions: new Map([['a', { x: 40, y: 40 }], ['b', { x: 240, y: 40 }]]) });
    expect(view[0].position).toEqual({ x: 0, y: 0 });
    expect(view[1].position).toEqual({ x: 200, y: 0 });
    sim.stop();
  });
});
