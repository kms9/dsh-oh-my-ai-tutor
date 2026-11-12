# Third-party notices

dsh-oh-my-ai-tutor is MIT-licensed (see `LICENSE`). It contains code ported from, and bundles, the third-party
software listed below.

## Ported source code (Apache License 2.0)

**Context Ontology Accelerator** — https://github.com/aws/context-ontology-accelerator
(commit `d28c001cfcc0460cbd1ec1b356a63dcad272790e`, 2026-11-09)

```
Context Ontology Accelerator
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
```

Licensed under the Apache License, Version 2.0; the full text is in `LICENSES/Apache-2.0.txt`
(also at http://www.apache.org/licenses/LICENSE-2.0). Every ported file keeps the upstream copyright line and
SPDX identifier in its header and lists what was changed:

| Our file | Upstream file (`packages/web-app/src/components/graph/`) | Changes |
|---|---|---|
| `src/client/coa/layout.mjs` | `layout.ts` | TypeScript → JavaScript, no behavioural change |
| `src/client/coa/labelProjection.mjs` | `labelProjection.ts` | TypeScript → JavaScript, no behavioural change |
| `src/client/coa/liveForceSimulation.mjs` | `useLiveForceSimulation.ts` | hook body split into a testable factory; `startPositions` (no fly-in replay on live refresh); per-node sizes; `step()` for tests |
| `src/client/coa/graphLayout.mjs` | `OntologyGraphFlow.tsx` (radialPositions, layoutGraph, parallelEdgeCurves) | moved to a pure module; Map output; per-node sizes; dagre left → right; shorter link distance, canvas aspect |
| `src/client/graph-flow.jsx` | `OntologyGraphFlow.tsx` (+ hook wrapper) | course data (topics = classes, knowledge points = instances); collapse via React Flow `hidden`; click-sticky highlight; search + path highlight; no attribute ring / standalone toggle / fullscreen button; see file header |
| `src/client/workbench.css` (`.kg-*` graph rules) | `graph.css` | adapted selectors, colours per topic |
| `test/coa/layout.test.mjs`, `test/coa/labelProjection.test.mjs` | `layout.test.ts`, `labelProjection.test.ts` | vitest → node:test shim, types removed |
| `test/coa/graphLayout.test.mjs` | `OntologyGraphFlow.test.tsx` | pure-function cases only |
| `test/coa/liveForceSimulation.test.mjs` | `useLiveForceSimulation.test.ts` | factory instead of renderHook, + one case for `startPositions` |

No React Flow Pro code (xyflow Pro examples are under the xyflow Pro License) was read or used.

## Bundled libraries (in `lib/client*.js`)

| Package | Version | License |
|---|---|---|
| @xyflow/react, @xyflow/system | 12.12.1, 0.0.84 | MIT — Copyright (c) 2019-2025 webkid GmbH |
| zustand, classcat, use-sync-external-store | 4.5.7, 5.0.5, 1.7.0 | MIT |
| d3-force, d3-dispatch, d3-quadtree, d3-timer, d3-selection, d3-zoom, d3-drag, d3-interpolate, d3-color, d3-transition | 3.x | ISC — Copyright Mike Bostock |
| @glideapps/glide-data-grid (in `lib/client.grid.js`) | 6.0.3 | MIT — Copyright (c) 2020 Glide |
| lodash, marked, react-responsive-carousel, react-number-format, react-easy-swipe, canvas-hypertxt, @linaria/core, @linaria/react, @emotion/is-prop-valid, @emotion/memoize, prop-types, classnames (Glide Data Grid dependencies) | 4.17.21, 4.3.0, 3.2.23, 5.4.5, 0.0.21, 1.0.3, 4.5.4, 4.5.4, 1.4.0, 0.9.0, 15.8.1, 2.5.1 | MIT |
| @fullcalendar/core, @fullcalendar/react, @fullcalendar/daygrid, @fullcalendar/timegrid, @fullcalendar/interaction (in `lib/client.calendar.js`; Standard plugins only, no Premium) | 6.1.22 | MIT — Copyright (c) 2021 Adam Shaw |
| preact (FullCalendar's internal renderer) | 10.12.1 | MIT — Copyright (c) 2015-present Jason Miller |
| d3-ease | 3.0.2 | BSD-3-Clause — Copyright Mike Bostock |
| @dagrejs/dagre, @dagrejs/graphlib | 3.1.3, 4.0.6 | MIT — Copyright (c) 2012-2014 Chris Pettitt |
| mind-elixir | 6.0.0 | MIT — Copyright (c) 2019 DjZhou (SSShooter) |

React and React DOM are not bundled: the DSH host provides them.
