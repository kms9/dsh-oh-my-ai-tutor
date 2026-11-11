// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Ported from aws/context-ontology-accelerator
//   packages/web-app/src/components/graph/OntologyGraphFlow.test.tsx @ d28c001cfcc0460cbd1ec1b356a63dcad272790e
// Modifications (dsh-oh-my-ai-tutor, 2026-11-11): only the pure-function cases (radialPositions, parallelEdgeCurves)
//   are ported, via ./vitest-shim.mjs; the render / click / double-click cases are covered by our Playwright e2e
//   (test/e2e/workbench.e2e.mjs) instead of @testing-library. Test bodies of the ported cases are unchanged.
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import { describe, it, expect } from './vitest-shim.mjs';
import { parallelEdgeCurves, radialPositions } from '../../src/client/coa/graphLayout.mjs';

describe('OntologyGraphFlow (pure helpers)', () => {
  it('lays out edge-less nodes on a circle (not a single row)', () => {
    const pts = radialPositions(6);
    // A flat row collapses to one y; a circle uses many distinct y values.
    expect(new Set(pts.map((p) => Math.round(p.y))).size).toBeGreaterThan(1);
    // All points are roughly equidistant from the centre (on a circle).
    const radii = pts.map((p) => Math.hypot(p.x, p.y));
    const maxR = Math.max(...radii);
    const minR = Math.min(...radii);
    expect(maxR - minR).toBeLessThan(1);
  });

  it('places a single node at the origin', () => {
    expect(radialPositions(1)).toEqual([{ x: 0, y: 0 }]);
  });
});

describe('parallelEdgeCurves', () => {
  it('fans edges sharing a node pair symmetrically and leaves lone edges straight', () => {
    const edges = [
      { id: '1', source: 'colour', target: 'hero' },
      { id: '2', source: 'colour', target: 'hero' },
      { id: '3', source: 'colour', target: 'hero' },
      { id: '4', source: 'colour', target: 'gender' },
    ];
    // Lone edge is straight; the triple fans out 44px apart around zero.
    expect(parallelEdgeCurves(edges).map((c) => c + 0)).toEqual([-44, 0, 44, 0]);
  });

  it('puts a reversed edge on the opposite side of its forward twin', () => {
    const edges = [
      { id: '1', source: 'a', target: 'b' },
      { id: '2', source: 'b', target: 'a' },
    ];
    const [forward, reverse] = parallelEdgeCurves(edges);
    // Each edge's normal is derived from its own direction, so equal-signed
    // offsets would land on the same side; the sign flip separates them.
    expect(forward).toBe(-22);
    expect(reverse).toBe(-22);
  });
});
