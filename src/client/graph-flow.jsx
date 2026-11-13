// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Knowledge graph view — ported from aws/context-ontology-accelerator
//   packages/web-app/src/components/graph/OntologyGraphFlow.tsx @ d28c001cfcc0460cbd1ec1b356a63dcad272790e
//   (and the hook wrapper of useLiveForceSimulation.ts, whose body lives in ./coa/liveForceSimulation.mjs).
// Modifications (dsh-oh-my-ai-tutor, 2026-11-11):
//   - TypeScript → JavaScript; host React (shared by DSH) instead of a bundled copy; no Cloudscape / i18n deps.
//   - Data: syllabus topics are the "class" nodes and knowledge points the "instance" nodes (one colour per topic);
//     `contains` edges play the role of subClassOf (dashed, hollow arrow); course relations are the labelled
//     object-property edges (candidate relations dashed amber). Built by ./graph-model.mjs.
//   - Expand / collapse: double-click a topic toggles its knowledge points with React Flow's `hidden` attribute (they
//     stay in the controlled node list); their relations are re-attached to the topic while hidden. Large courses
//     (> 60 knowledge points) start collapsed and are revealed lazily. Double-click a knowledge point reveals the
//     collapsed topics its relations lead into.
//   - One-hop neighbour highlight on hover (as upstream) AND on click (sticky until the pane is clicked); plus our
//     search highlight and shortest-path highlight between two nodes (graph-model.mjs), with precedence
//     path > search > hover > click.
//   - Layout helpers live in ./coa/graphLayout.mjs (hierarchical = dagre left → right; force = upstream's packed
//     layoutForceGraph with a shorter link distance and the canvas aspect ratio, so a course fits the column).
//   - No attribute (datatype-property) ring, standalone-class toggle, Controls panel or fullscreen button: the
//     workbench already has 放大 / 整个工作台 / 还原 and its own fit (automatic fits ≥ 0.8 so text stays readable, 「适配」 ≥ 0.3 so every node is on screen).
//   - Simulation ticks only update view state (positions); nothing in this file writes application data.
//   (2026-11-12) Extension nodes get their own registered node type (they used to fall back to React Flow's empty
//     default box); a `local` view (focus on one node / learning path, built by ./graph-focus.mjs) replaces the
//     whole-course graph with a dagre top → bottom layout, folded topic groups and dotted skipped links; the two-node
//     path is a directed 前置 learning path (no undirected fallback) with the target and weak points marked.
//   (2026-11-12, later) Clicking a topic selects it too (the workbench keeps a graph selection of its own, so extension
//     and topic nodes stay selected); long labels get a slightly larger circle and a smaller font (sizeOfNode); local
//     views (all edges are candidate 前置) label an edge only while it is lit (hover), the whole-course view labels one
//     edge per (target, type); 「适配」 may zoom out to FIT_MIN_ZOOM so every node is on screen, reserves the floating
//     side panel's width and keeps nodes out from under the in-graph key / minimap.
//   (2026-11-12, rect nodes) Nodes are rounded rectangles sized by nodeBox (clamped width, label wrapping to 4 lines):
//     topic = filled topic-colour block, knowledge point = tinted card with a topic-colour border and a mastery stripe
//     on its left edge, extension = dashed border, fold = stacked card. Floating edges end on the rectangle border.
//     The whole-course homes are topic cards packed to the canvas (graphLayout.layoutTopicClusters); the live
//     simulation uses rectangle collision and rest lengths = packed distances. A fold card has one merged arrow.
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel, BaseEdge, EdgeLabelRenderer, MarkerType, Handle, Position,
  applyNodeChanges, useInternalNode, useReactFlow, useStore } from '@xyflow/react';
import { buildGraph, visibleGraph, neighbours, searchNodes, NODE_KINDS } from './graph-model.mjs';
import { learningPath, weakIds } from './graph-focus.mjs';
import { NODE_SIZE, FORCE_LINK_DISTANCE, nodeBox, layoutGraph, parallelEdgeCurves, placeEdgeLabels } from './coa/graphLayout.mjs';
import { projectEdgeLabel } from './coa/labelProjection.mjs';
import { createLiveForceSimulation } from './coa/liveForceSimulation.mjs';
import { fitViewport, unionBounds, RELATION_LABEL } from './flow-layout.mjs';
import { MASTERY_LABEL } from './layout.mjs';
import { TOPIC_COLORS } from './flow.jsx';

const colorAt = (i) => TOPIC_COLORS[((i ?? 0) % TOPIC_COLORS.length + TOPIC_COLORS.length) % TOPIC_COLORS.length];
/** Edge labels are hidden below this zoom — they are unreadable confetti there. */
export const EDGE_LABEL_MIN_ZOOM = 0.55;
const ARROW_SIZE = 14;
const ARROW_GAP = 3;
/** Arrows shorter than this (flow px, border to border) are labelled only while lit. */
const SHORT_EDGE = 64;
const RELATION = '#64748b';
const CANDIDATE = '#b8860b';
/** Automatic fits (new layout / resize) stay readable; the 「适配」 button may go down to FIT_MIN_ZOOM to show every node. */
export const AUTO_FIT_MIN_ZOOM = 0.8;
export const FIT_MIN_ZOOM = 0.3;
const FIT_PAD = 24;
/** Height of the bottom strip the in-graph key and the minimap cover (the force packing leaves it free). */
const PANEL_STRIP = 110;
/** …and the strip under the folded one-line key (narrow canvas, no minimap). */
const PANEL_STRIP_MIN = 34;
/** Below this canvas width the whole-course key starts folded. */
const LEGEND_COMPACT_W = 720;
/** Courses bigger than this start with every topic collapsed (lazy reveal by double-click). */
export const LAZY_THRESHOLD = 60;

/* ─── Highlight state via context (upstream HoverContext): hovering never re-creates node objects ─── */
const KgContext = createContext({ lit: null, hits: null, ends: [], sel: null, target: null, weak: null, focusId: null, local: null, setHoveredEdgeId: () => {} });

/** Text of a relation edge's label chip (also used to size it for placeEdgeLabels). */
const relText = (e) => `${RELATION_LABEL[e.label] ?? e.label}${e.status === 'candidate' ? ' · 候选' : ''}${e.members.length > 1 ? ` ×${e.members.length}` : ''}${e.bus ? `（折叠汇总，指向 ${e.via.length} 个节点）` : ''}`;
function nodeTitle(n, local) {
  if (n.ghost) return `${n.label} · 其他主题的节点，和本主题有候选关系（点击：切换到它的主题）`;
  if (n.kind === 'topic') return `${n.label} — 主题（类别），双击${n.collapsed ? '展开' : '收起'}它的 ${n.count} 个知识点`;
  if (n.kind === 'fold') return `${n.title}：${n.count} 个较远的前置被折叠，点击展开全部`;
  const more = local ? '（点击：聚焦到它）' : '（双击展开它关系所在的主题）';
  if (n.kind === 'extension') return `${n.label} · 扩展节点（尚未升格为知识点，没有掌握状态）${local === 'focus' ? more : local ? '' : more}`;
  return `${n.label} · ${MASTERY_LABEL[n.mastery] ?? ''}${local === 'focus' ? more : local ? '' : more}`;
}

function KgNode({ data }) {
  const n = data.n;
  const { lit, hits, ends, sel, target, weak, focusId, local } = useContext(KgContext);
  const cls = [lit && !lit.has(n.id) ? 'dim' : '', hits?.has(n.id) ? 'hit' : '', n.id === sel ? 'sel' : '', ends.includes(n.id) ? 'end' : '',
    n.id === target ? 'target' : '', weak?.has(n.id) ? 'weak' : '', n.id === focusId ? 'focus' : '', n.ghost ? 'ghost' : ''].filter(Boolean).join(' ');
  const topic = n.kind === 'topic', fold = n.kind === 'fold';
  const box = nodeBox(n);
  // mastery stripe only on knowledge points (extensions have no mastery; folds and topics are groups)
  const mastery = n.kind === 'concept' ? (n.mastery || 'unverified') : '';
  return (
    <div className={`kg-node kg-rect kg-${n.kind} ${mastery} ${cls}`} style={{ '--c': data.color, width: box.w, height: box.h }} data-node-id={n.id} data-kind={n.kind}
      data-collapsed={topic ? String(!!n.collapsed) : undefined} data-weak={weak?.has(n.id) ? 'true' : undefined} data-mastery={mastery || undefined} title={nodeTitle(n, local)}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="kg-anchor" />
      {mastery && <span className="kg-stripe" aria-hidden="true" />}
      {fold ? <div className="kg-label kg-foldlabel"><span>{n.title}</span><small>{n.count} 个前置</small></div>
        : <div className="kg-label">{n.label}</div>}
      {topic && n.count > 0 && <span className="kg-badge" data-testid="kg-badge">{n.collapsed ? `+${n.count}` : '−'}</span>}
      {fold && <span className="kg-badge" data-testid="kg-fold-badge">+{n.count}</span>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="kg-anchor" />
    </div>
  );
}
/** One renderer, four registered kinds: every `kind` buildGraph / graph-focus can emit must be listed here. */
export const nodeTypes = Object.fromEntries(NODE_KINDS.map((k) => [k, KgNode]));

/** Distance from a rectangle's centre to its border along the unit direction (ux, uy). */
export const rectReach = (w, h, ux, uy) => Math.min(Math.abs(ux) > 1e-6 ? w / 2 / Math.abs(ux) : Infinity, Math.abs(uy) > 1e-6 ? h / 2 / Math.abs(uy) : Infinity);
/* ─── Floating edge: rectangle border to rectangle border, HTML label (upstream FloatingEdge, circles there) ─── */
function FloatingEdge({ id, source, target, data, markerEnd, style, label }) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const { setHoveredEdgeId } = useContext(KgContext);
  if (!sourceNode || !targetNode) return null;
  const wOf = (n) => n.measured?.width ?? n.width ?? NODE_SIZE.concept.w;
  const hOf = (n) => n.measured?.height ?? n.height ?? NODE_SIZE.concept.h;
  const centre = (n) => ({ x: n.internals.positionAbsolute.x + wOf(n) / 2, y: n.internals.positionAbsolute.y + hOf(n) / 2 });
  const s = centre(sourceNode);
  const t = centre(targetNode);
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const rSource = rectReach(wOf(sourceNode), hOf(sourceNode), ux, uy);
  const rTarget = rectReach(wOf(targetNode), hOf(targetNode), ux, uy);
  const curve = data?.curve ?? 0;
  const nx = -uy;
  const ny = ux;
  const sx = s.x + ux * rSource + nx * curve * 0.3;
  const sy = s.y + uy * rSource + ny * curve * 0.3;
  const tx = t.x - ux * (rTarget + ARROW_GAP) + nx * curve * 0.3;
  const ty = t.y - uy * (rTarget + ARROW_GAP) + ny * curve * 0.3;
  const labelPoint = projectEdgeLabel(sx, sy, tx, ty, curve, data?.labelT ?? 0.5);
  let path;
  if (curve === 0) path = `M ${sx} ${sy} L ${tx} ${ty}`;
  else path = `M ${sx} ${sy} Q ${(sx + tx) / 2 + nx * curve} ${(sy + ty) / 2 + ny * curve} ${tx} ${ty}`;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} interactionWidth={14} />
      {/* a label chip on a very short arrow would sit on the nodes it joins: only while the arrow is lit (hover) */}
      {label && (Math.hypot(tx - sx, ty - sy) > SHORT_EDGE || /\bhot\b/.test(data?.cls ?? '')) ? (
        <EdgeLabelRenderer>
          <div className={`kg-elabel ${data?.cls ?? ''}`} title={data?.title} style={{ transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)`, opacity: style?.opacity }}
            onMouseEnter={() => setHoveredEdgeId(id)} onMouseLeave={() => setHoveredEdgeId(null)}>{label}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
/* ─── Bus edge (ours): one fold card → several nodes. A stem from the card down to a rail just above the nodes it
   feeds, then a short arrow down to each (graph-focus mergeFoldEdges `via`). `data.lane` staggers two rails. ─── */
function BusEdge({ id, source, data, markerEnd, style, label }) {
  const src = useInternalNode(source);
  const via = data?.via ?? [];
  const key = useStore(useCallback((st) => via.map((t) => {
    const n = st.nodeLookup.get(t);
    return n ? [n.internals.positionAbsolute.x, n.internals.positionAbsolute.y, n.measured?.width ?? n.width ?? 0, n.measured?.height ?? n.height ?? 0].map((v) => Math.round(v)).join(',') : '';
  }).join('|'), [via.join('|')])); // eslint-disable-line react-hooks/exhaustive-deps
  const { setHoveredEdgeId } = useContext(KgContext);
  if (!src) return null;
  const ts = key.split('|').filter(Boolean).map((k) => { const [x, y, w] = k.split(',').map(Number); return { x: x + w / 2, y }; });
  if (!ts.length) return null;
  const sw = src.measured?.width ?? src.width ?? NODE_SIZE.fold.w, sh = src.measured?.height ?? src.height ?? NODE_SIZE.fold.h;
  const sx = src.internals.positionAbsolute.x + sw / 2, sy = src.internals.positionAbsolute.y + sh;
  const top = Math.min(...ts.map((t) => t.y));
  const railY = Math.max(sy + 8, top - 14 - 12 * (data?.lane ?? 0));
  const x0 = Math.min(sx, ...ts.map((t) => t.x)), x1 = Math.max(sx, ...ts.map((t) => t.x));
  const rail = `M ${sx} ${sy} L ${sx} ${railY} M ${x0} ${railY} L ${x1} ${railY}`;
  const tickStyle = { ...style, fill: 'none' };
  return (
    <>
      <BaseEdge id={id} path={rail} style={style} interactionWidth={14} />
      {ts.map((t, i) => <path key={i} className="react-flow__edge-path" d={`M ${t.x} ${railY} L ${t.x} ${t.y - ARROW_GAP}`} style={tickStyle} markerEnd={markerEnd} />)}
      {label ? (
        <EdgeLabelRenderer>
          <div className={`kg-elabel ${data?.cls ?? ''}`} title={data?.title} style={{ transform: `translate(-50%, -50%) translate(${sx}px, ${(sy + railY) / 2}px)`, opacity: style?.opacity }}
            onMouseEnter={() => setHoveredEdgeId(id)} onMouseLeave={() => setHoveredEdgeId(null)}>{label}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
const edgeTypes = { floating: FloatingEdge, bus: BusEdge };

/** Thin hook over the ported factory (upstream useLiveForceSimulation). */
function useLiveForceSimulation(initialNodes, edges, setNodes, { enabled, nodeSize, linkDistance, boxOf, startRef }) {
  const simRef = useRef(null);
  useEffect(() => {
    if (!enabled || initialNodes.length === 0) return undefined;
    const sim = createLiveForceSimulation(initialNodes, edges, setNodes, { nodeSize, linkDistance, boxOf, homeLinks: true, startPositions: startRef?.current?.() ?? undefined });
    simRef.current = sim;
    return () => { sim.stop(); if (simRef.current === sim) simRef.current = null; };
  }, [enabled, initialNodes, edges, setNodes, nodeSize, linkDistance]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => ({
    onDragStart: (id, p) => simRef.current?.onDragStart(id, p),
    onDrag: (id, p) => simRef.current?.onDrag(id, p),
    onDragStop: (id) => simRef.current?.onDragStop(id),
  }), []);
}

const GraphFlowInner = forwardRef(function GraphFlowInner({ view, topics, selectedId, onSelect, height, minimap = false, onFit, layout = 'force',
  query = '', pathMode = false, collapsed, setCollapsed, onPath, local = null, onLocalClick, onUnfold, reserve }, ref) {
  const rf = useReactFlow();
  const wrapRef = useRef(null);
  // `local` (graph-focus.mjs): a focus view or a learning path replaces the whole-course graph; no topic collapse there
  const fullGraph = useMemo(() => buildGraph(view, topics), [view, topics]);
  const graph = local ? local.graph : fullGraph;
  const vis = useMemo(() => (local ? local.graph : visibleGraph(fullGraph, collapsed)), [local, fullGraph, collapsed]);
  // the topic view (narrow canvas) is one topic card + ghost neighbours: the packed card layout, not dagre
  const effLayout = local?.kind === 'topic' ? 'force' : local ? 'tb' : layout;
  const isForce = effLayout === 'force';
  const tIndex = useMemo(() => new Map(topics.map((t, i) => [t.id, i])), [topics]);
  const shown = useMemo(() => new Map(vis.nodes.map((n) => [n.id, n])), [vis]);

  // Layout depends on topology only (upstream: structural inputs), so renames / mastery changes never re-run it.
  const structure = `${effLayout}|${vis.nodes.map((n) => n.id).join(',')}|${vis.edges.map((e) => `${e.id}:${e.source}>${e.target}`).join(',')}`;
  const structuralEdges = useMemo(() => vis.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })), [structure]); // eslint-disable-line react-hooks/exhaustive-deps
  const [size, setSize] = useState({ w: 0, h: 0 });
  // the packed layout is chosen for the canvas shape (bucketed so small resizes do not re-pack)
  const aspect = size.w && size.h ? `${Math.round(size.w / 80)}x${Math.round(size.h / 80)}` : '';
  // the whole-course key folds to one line on a narrow canvas; the packing then only keeps that thin strip free
  // …and in 整个工作台 (the floating side panel already takes the top right; the canvas gets the height)
  const legendCompact = (!local || local.kind === 'topic') && size.w > 0 && (size.w < LEGEND_COMPACT_W || (reserve?.right ?? 0) > 0);
  const strip = legendCompact && !minimap ? PANEL_STRIP_MIN : PANEL_STRIP;
  // pack for the area the fit can really use: minus the floating side panel and the strip under the key / minimap
  const homes = useMemo(() => layoutGraph(vis.nodes, structuralEdges, effLayout, { readableZoom: AUTO_FIT_MIN_ZOOM, canvas: { w: Math.max(200, size.w - (reserve?.right ?? 0)), h: Math.max(200, size.h - strip) } }), [structure, aspect, strip]); // eslint-disable-line react-hooks/exhaustive-deps
  const boxById = useRef(new Map());
  boxById.current = new Map(graph.nodes.map((n) => [n.id, nodeBox(n)]));
  const boxOfId = useCallback((id) => boxById.current.get(id) ?? NODE_SIZE.concept, []);
  // Every graph node stays in the controlled list; collapsed knowledge points are `hidden` at their topic's place.
  const initialNodes = useMemo(() => graph.nodes.map((g0) => {
    const n = shown.get(g0.id) ?? g0, hidden = !shown.has(g0.id);
    const p = homes.get(n.id) ?? homes.get(`topic:${n.topicId}`) ?? { x: 0, y: 0 };
    const { w, h } = nodeBox(n);
    // Declared handles (centre anchors): React Flow then has handle bounds without measuring the DOM, so edges never
    // drop out while nodes are re-measured after a container change (seen in DSH after 放大 → 整个工作台).
    return { id: n.id, type: n.kind, hidden, position: p, width: w, height: h, zIndex: 2, data: { n, color: colorAt(tIndex.get(n.topicId)) },
      handles: [{ type: 'source', position: Position.Bottom, x: w / 2, y: h / 2, width: 1, height: 1 }, { type: 'target', position: Position.Top, x: w / 2, y: h / 2, width: 1, height: 1 }] };
  }), [homes]); // eslint-disable-line react-hooks/exhaustive-deps
  const simNodes = useMemo(() => initialNodes.filter((n) => !n.hidden), [initialNodes]);

  const [liveNodes, setLiveNodes] = useState(initialNodes);
  // A node already on screen whose packed home did not move (a live refresh that only added / removed something
  // elsewhere) restarts where it is; everything else flies in as upstream does (first render, layout switch, resize
  // to another aspect, or a re-pack that moved its cluster).
  const liveRef = useRef(liveNodes); liveRef.current = liveNodes;
  const prevHomesRef = useRef(new Map());
  const startRef = useRef(null);
  startRef.current = () => {
    const prev = prevHomesRef.current, out = new Map();
    for (const n of liveRef.current) {
      const a = prev.get(n.id), b = homes.get(n.id);
      if (n.hidden || !a || !b || Math.hypot(a.x - b.x, a.y - b.y) > 24 || Math.hypot(n.position.x - b.x, n.position.y - b.y) > 160) continue;
      out.set(n.id, { x: n.position.x + boxOfId(n.id).w / 2, y: n.position.y + boxOfId(n.id).h / 2 });
    }
    prevHomesRef.current = homes;
    return out;
  };
  useEffect(() => { setLiveNodes(initialNodes); }, [initialNodes]);
  const simulation = useLiveForceSimulation(simNodes, structuralEdges, setLiveNodes, { enabled: isForce, nodeSize: NODE_SIZE.concept.w, linkDistance: FORCE_LINK_DISTANCE, boxOf: boxOfId, startRef });

  // fresh data (labels, mastery, counts) without touching positions
  const displayNodes = useMemo(() => liveNodes.map((ln) => {
    const n = shown.get(ln.id) ?? graph.nodes.find((x) => x.id === ln.id);
    if (!n) return ln;
    const color = colorAt(tIndex.get(n.topicId));
    return ln.data.n === n && ln.data.color === color ? ln : { ...ln, data: { n, color } };
  }), [liveNodes, shown, graph, tIndex]);

  // ─── highlight: path > search > hover (node / edge) > click focus ───
  const [hoveredId, setHoveredId] = useState(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState(null);
  // sticky one-hop highlight only after a click in the graph (a selection coming from the sidebar just rings the node)
  const [clickFocus, setClickFocus] = useState(null);
  const [pathEnds, setPathEnds] = useState([]);
  // a click highlight from the whole-course view must not carry into a focus / learning-path view (it would dim the
  // local graph and label every edge of that node)
  useEffect(() => { setClickFocus(null); }, [local?.kind, local?.focusId, local?.target]);
  useEffect(() => { if (!pathMode || local) setPathEnds([]); }, [pathMode, local]);
  // directed learning path along 前置 between the two picked nodes (graph-focus.mjs); never an undirected fallback
  const path = useMemo(() => (!local && pathEnds.length === 2 ? learningPath(fullGraph, pathEnds[0], pathEnds[1]) : null), [local, pathEnds, fullGraph]);
  const pathWeak = useMemo(() => (path ? weakIds(fullGraph.nodes, path.nodes) : null), [path, fullGraph]);
  useEffect(() => {
    // a path through a collapsed topic: open that topic so every step is on screen
    if (!path) return;
    const closed = path.nodes.map((id) => fullGraph.nodes.find((n) => n.id === id)?.topicId).filter((t) => t && collapsed.has(t));
    if (closed.length) setCollapsed((st) => { const next = new Set(st); closed.forEach((t) => next.delete(t)); return next; });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const label = (id) => fullGraph.nodes.find((n) => n.id === id)?.label ?? id;
    onPath?.(pathEnds.length === 2 ? { ends: pathEnds, path, labels: (path?.nodes ?? []).map(label), weak: pathWeak ? [...pathWeak] : [], endLabels: pathEnds.map(label) }
      : pathEnds.length ? { ends: pathEnds } : null);
  }, [pathEnds, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = useMemo(() => new Set(searchNodes(vis.nodes, query)), [vis.nodes, query]);
  const sel = selectedId && shown.has(selectedId) ? selectedId : clickFocus;
  const focus = clickFocus && shown.has(clickFocus) ? clickFocus : null;
  // a fold's bus edge touches every node in `via`, not only its nominal target
  const touches = (e, id) => e.source === id || e.target === id || !!e.via?.includes(id);
  const oneHop = (id) => {
    const es = vis.edges.filter((e) => touches(e, id));
    return { nodes: new Set([id, ...neighbours(vis.edges, id), ...es.flatMap((e) => [e.source, ...(e.via ?? [e.target])])]), edges: new Set(es.map((e) => e.id)) };
  };
  let lit = null, hotEdges = null, mode = local ? `local-${local.kind}` : '';
  if (path) { lit = new Set(path.nodes); hotEdges = new Set(path.edges); mode = 'path'; }
  else if (query.trim()) { lit = matches; hotEdges = new Set(); mode = 'search'; }
  else if (hoveredId && shown.has(hoveredId)) { ({ nodes: lit, edges: hotEdges } = oneHop(hoveredId)); mode = 'hover'; }
  else if (hoveredEdgeId) { const e = vis.edges.find((x) => x.id === hoveredEdgeId); if (e) { lit = new Set([e.source, e.target, ...(e.via ?? [])]); hotEdges = new Set([e.id]); mode = 'hover'; } }
  else if (focus) { ({ nodes: lit, edges: hotEdges } = oneHop(focus)); mode = 'focus'; }
  const target = local ? (local.target ?? null) : (path?.to ?? null);
  const weak = local ? (local.weak ?? null) : pathWeak;
  const focusId = local?.focusId ?? null;
  const ctx = useMemo(() => ({ lit, hits: mode === 'search' ? lit : null, ends: pathEnds, sel, target, weak, focusId, local: local?.kind ?? null, setHoveredEdgeId }),
    [lit && [...lit].join(','), mode, pathEnds, sel, target, weak && [...weak].join(','), focusId, local?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const showEdgeLabels = useStore((s) => s.transform[2] >= EDGE_LABEL_MIN_ZOOM);
  const curves = useMemo(() => { const m = new Map(); const cs = parallelEdgeCurves(vis.edges); vis.edges.forEach((e, i) => m.set(e.id, cs[i])); return m; }, [vis.edges]);
  // Label clutter: in a local view every arrow is a candidate 前置 (the legend says so), so an edge is labelled only
  // while it is lit (hover); the whole-course view labels one edge per (target, type), lit edges always — and only
  // where its chip fits without covering a node or another chip (placeEdgeLabels, on the packed homes; Map id → t).
  const labelled = useMemo(() => {
    if (local && local.kind !== 'topic') return new Map();
    const seen = new Set(), items = [];
    for (const e of vis.edges) {
      if (e.kind !== 'relation') continue;
      const k = `${e.target}|${e.label}|${e.status}`;
      if (!seen.has(k)) { seen.add(k); items.push({ id: e.id, source: e.source, target: e.target, text: relText(e) }); }
    }
    const boxes = new Map(vis.nodes.map((n) => { const p = homes.get(n.id) ?? { x: 0, y: 0 }, b = nodeBox(n); return [n.id, { x: p.x, y: p.y, w: b.w, h: b.h }]; }));
    const out = new Map();
    for (const [id, t] of placeEdgeLabels(items, boxes)) if (t != null) out.set(id, t);
    return out;
  }, [vis.edges, vis.nodes, homes, local]);
  const busLanes = useMemo(() => new Map(vis.edges.filter((e) => e.bus).map((e, i) => [e.id, i])), [vis.edges]);
  const edges = useMemo(() => {
    const out = vis.edges.map((e) => {
      const hot = hotEdges?.has(e.id), dim = hotEdges && !hot;
      if (e.kind === 'contains') {
        const col = colorAt(tIndex.get(shown.get(e.source)?.topicId));
        return { id: e.id, source: e.source, target: e.target, type: 'floating', zIndex: hot ? 1 : 0, className: `kg-contains${dim ? ' dim' : ''}${hot ? ' hot' : ''}`,
          style: { stroke: col, strokeWidth: hot ? 2.5 : 1.5, strokeDasharray: '6 4', opacity: dim ? 0.12 : 0.75 },
          markerEnd: { type: MarkerType.Arrow, color: col, width: ARROW_SIZE, height: ARROW_SIZE, markerUnits: 'userSpaceOnUse', strokeWidth: 1.5 }, data: { curve: curves.get(e.id) ?? 0 } };
      }
      if (e.kind === 'skip') {
        // learning path: kept nodes joined only through omitted intermediate steps
        return { id: e.id, source: e.source, target: e.target, type: 'floating', zIndex: 0, className: `kg-skip${dim ? ' dim' : ''}`,
          style: { stroke: CANDIDATE, strokeWidth: 1.6, strokeDasharray: '1 5', strokeLinecap: 'round', opacity: dim ? 0.12 : 0.9 },
          markerEnd: { type: MarkerType.ArrowClosed, color: CANDIDATE, width: ARROW_SIZE, height: ARROW_SIZE, markerUnits: 'userSpaceOnUse', strokeWidth: 1.5 },
          data: { curve: curves.get(e.id) ?? 0 } };
      }
      const candidate = e.status === 'candidate', stroke = candidate ? CANDIDATE : RELATION;
      const text = relText(e);
      return { id: e.id, source: e.source, target: e.target, type: e.bus ? 'bus' : 'floating', zIndex: hot ? 1 : 0,
        className: `kg-rel${dim ? ' dim' : ''}${hot ? ' hot' : ''}${e.aggregated ? ' agg' : ''}${e.bus ? ' merged bus' : ''}`, label: hot || (showEdgeLabels && labelled.has(e.id)) ? text : undefined,
        style: { stroke, strokeWidth: hot ? 2.8 : e.bus ? 2.2 : 1.8, strokeDasharray: candidate ? '6 4' : undefined, opacity: dim ? 0.12 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: ARROW_SIZE, height: ARROW_SIZE, markerUnits: 'userSpaceOnUse', strokeWidth: 1.5 },
        data: { curve: curves.get(e.id) ?? 0, labelT: labelled.get(e.id) ?? 0.5, via: e.via, lane: e.bus ? busLanes.get(e.id) : undefined, cls: `${dim ? 'dim' : hot ? 'hot' : ''}${candidate ? ' cand' : ''}`, title: `${text}${candidate ? '（候选关系，未验证）' : ''}` } };
    });
    for (const e of graph.edges) if (!shown.has(e.source) || !shown.has(e.target)) out.push({ id: `hidden:${e.id}`, source: e.source, target: e.target, type: 'floating', hidden: true, data: {} });
    return out;
  }, [vis.edges, graph.edges, shown, hotEdges && [...hotEdges].join(','), showEdgeLabels, curves, tIndex, labelled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── fit: automatic fits stay readable (≥ AUTO_FIT_MIN_ZOOM; keep the selection in view when it overflows); the 「适配」
  // button shows every node (≥ FIT_MIN_ZOOM). `reserve.right` = width of the side panel floating over the canvas. ───
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([en]) => setSize({ w: Math.round(en.contentRect.width), h: Math.round(en.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const focusRef = useRef(sel); focusRef.current = sel;
  const homesRef = useRef(simNodes); homesRef.current = simNodes;
  const [fitState, setFitState] = useState({ overflow: false, zoom: 1 });
  const reserveRight = reserve?.right ?? 0;
  const fit = useCallback(({ live = true, all = false } = {}) => {
    // after a structure change fit the FINAL layout (upstream: do not wait for the settle animation); otherwise fit
    // what is on screen (a dragged node may have left its packed home)
    const ns = live ? liveRef.current.filter((n) => !n.hidden) : homesRef.current;
    const b = unionBounds(ns.map((n) => ({ x: n.position.x, y: n.position.y, width: n.width, height: n.height })));
    if (!b || !size.w || !size.h) return;
    // selection / focus rings and the hover scale reach ~8 px past a circle: grow the bounds a little
    const g = 8, bb = { x: b.x - g, y: b.y - g, width: b.width + 2 * g, height: b.height + 2 * g };
    const w = Math.max(160, size.w - reserveRight);
    const opts = { minZoom: all ? FIT_MIN_ZOOM : AUTO_FIT_MIN_ZOOM, maxZoom: 1.2, pad: FIT_PAD };
    let h = size.h, v = fitViewport(bb, w, h, opts);
    // the in-graph key (bottom-left) and the minimap (bottom-right) sit over the canvas: when a node would land under
    // one of them, fit again into the height above them
    const wr = wrapRef.current?.getBoundingClientRect();
    const panels = [...(wrapRef.current?.querySelectorAll('.react-flow__panel.bottom') ?? [])].map((el) => {
      const r = el.getBoundingClientRect(); return { x0: r.left - (wr?.left ?? 0), x1: r.right - (wr?.left ?? 0), y0: r.top - (wr?.top ?? 0) };
    });
    const under = panels.some((p) => ns.some((n) => {
      const x0 = n.position.x * v.zoom + v.x, y1 = (n.position.y + n.height) * v.zoom + v.y, x1 = x0 + n.width * v.zoom;
      return x1 > p.x0 && x0 < p.x1 && y1 > p.y0 - 4;
    }));
    if (under) {
      h = Math.max(160, Math.min(...panels.map((p) => p.y0)) - 6);
      v = fitViewport(bb, w, h, opts);
    }
    const f = v.overflow && ns.find((n) => n.id === focusRef.current);
    // overflow: keep the selection in view, but only move along the axis that does not fit (the other stays fitted)
    if (f) rf.setViewport({ x: bb.width * v.zoom + 2 * FIT_PAD > w ? w / 2 - (f.position.x + f.width / 2) * v.zoom : v.x,
      y: bb.height * v.zoom + 2 * FIT_PAD > h ? h / 2 - (f.position.y + f.height / 2) * v.zoom : v.y, zoom: v.zoom });
    else rf.setViewport({ x: v.x, y: v.y, zoom: v.zoom });
    setFitState({ overflow: v.overflow, zoom: v.zoom });
    onFit?.({ overflow: v.overflow, zoom: v.zoom });
  }, [rf, size.w, size.h, onFit, reserveRight]);
  const fitRef = useRef(fit); fitRef.current = fit;
  const userMovedRef = useRef(false);
  const fittedKey = useRef('');
  useEffect(() => {
    const key = `${structure}|${aspect}`;
    fit({ live: fittedKey.current === key }); // new layout → its final positions; same layout, new size → what is on screen
    fittedKey.current = key;
    // The live simulation settles near, not exactly on, the packed homes (links and collision push a little), so a
    // node at the rim could end up just outside the view. Fit once more to what is on screen when it has settled,
    // unless the learner has panned or zoomed in the meantime.
    userMovedRef.current = false;
    const t = setTimeout(() => { if (!userMovedRef.current) fitRef.current?.({ live: true }); }, 1800);
    return () => clearTimeout(t);
  }, [size.w, size.h, structure, aspect]); // eslint-disable-line react-hooks/exhaustive-deps
  const centreOn = useCallback((id) => {
    const n = liveRef.current.find((x) => x.id === id && !x.hidden); if (!n) return;
    rf.setCenter(n.position.x + n.width / 2, n.position.y + n.height / 2, { zoom: Math.max(rf.getViewport().zoom, 1), duration: 200 });
  }, [rf]);
  useImperativeHandle(ref, () => ({ fit: () => { userMovedRef.current = true; fit({ all: true }); }, // 「适配」 wins over the delayed settle re-fit
    centreOn, zoomBy(f) { const v = rf.getViewport(); rf.setViewport({ ...v, zoom: Math.min(1.8, Math.max(0.3, v.zoom * f)) }, { duration: 120 }); } }), [fit, centreOn, rf]);

  // ─── interaction ───
  const toggleTopic = (topicId) => setCollapsed((s) => { const next = new Set(s); if (next.has(topicId)) next.delete(topicId); else next.add(topicId); return next; });
  const onNodeClick = (_e, node) => {
    const n = node.data.n;
    if (local && local.kind !== 'topic') { if (n.kind === 'fold') onUnfold?.(); else onLocalClick?.(n.id); return; }
    if (pathMode) { setPathEnds((p) => (p.length >= 2 ? [n.id] : p.includes(n.id) ? p : [...p, n.id])); return; }
    setClickFocus(n.id);
    onSelect?.(n.id); // topics too: the workbench keeps its own graph selection (topic / extension / knowledge point)
  };
  const onNodeDoubleClick = (_e, node) => {
    const n = node.data.n;
    if (pathMode || (local && local.kind !== 'topic') || (local && n.kind === 'topic')) return; // topic view: no collapse
    if (local) return; // topic view: there is nothing collapsed to reveal
    if (n.kind === 'topic') { toggleTopic(n.topicId); return; }
    // lazy expand: reveal every collapsed topic one of this knowledge point's relations leads into
    const far = graph.edges.filter((e) => e.kind === 'relation' && (e.source === n.id || e.target === n.id))
      .map((e) => graph.nodes.find((x) => x.id === (e.source === n.id ? e.target : e.source))?.topicId).filter((t) => t && collapsed.has(t));
    if (far.length) setCollapsed((s) => { const next = new Set(s); far.forEach((t) => next.delete(t)); return next; });
  };
  const onNodesChange = useCallback((changes) => setLiveNodes((nds) => applyNodeChanges(changes.filter((c) => c.type === 'position' || c.type === 'dimensions'), nds)), []);

  return (
    <KgContext.Provider value={ctx}>
      <div className={`rf-wrap rf-graph kg${mode ? ` kg-${mode}` : ''}${pathMode && !local ? ' kg-picking' : ''}`} ref={wrapRef} style={{ height }} data-testid="graph-flow"
        data-scale={fitState.zoom.toFixed(2)} data-overflow={String(fitState.overflow)} data-layout={effLayout} data-mode={mode} data-local={local?.kind}>
        <ReactFlow nodes={displayNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
          onMoveStart={(e) => { if (e) userMovedRef.current = true; }}
          onNodeClick={onNodeClick} onNodeDoubleClick={onNodeDoubleClick}
          onNodeDragStart={(_e, node) => { userMovedRef.current = true; simulation.onDragStart(node.id, node.position); }} // no settle re-fit after a drag
          onNodeDrag={(_e, node) => simulation.onDrag(node.id, node.position)}
          onNodeDragStop={(_e, node) => simulation.onDragStop(node.id)}
          onNodeMouseEnter={(_e, node) => setHoveredId(node.id)} onNodeMouseLeave={() => setHoveredId(null)}
          onEdgeMouseEnter={(_e, edge) => setHoveredEdgeId(edge.id)} onEdgeMouseLeave={() => setHoveredEdgeId(null)}
          onPaneClick={() => { setClickFocus(null); if (!pathMode && (!local || local.kind === 'topic')) onSelect?.(null); }}
          nodesDraggable nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} disableKeyboardA11y zoomOnDoubleClick={false}
          panOnScroll zoomOnScroll={false} zoomOnPinch minZoom={0.15} maxZoom={2.5} nodeDragThreshold={3} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#dbe1ee" />
          {minimap && <MiniMap pannable zoomable nodeColor={(n) => n.data?.color ?? '#9aa6c4'} nodeStrokeWidth={0} maskColor="rgba(240,243,250,.7)" style={{ width: 150, height: 96 }} />}
          <Panel position="bottom-left">
            <GraphLegend local={local} path={path} compact={legendCompact} />
          </Panel>
        </ReactFlow>
      </div>
    </KgContext.Provider>
  );
});
/** In-graph legend: matches the strokes actually drawn (dashed = 虚线, dotted = 点线). */
function GraphLegend({ local, path, compact = false }) {
  // narrow whole-course canvas (default 3-column view): the key starts folded to one line so the graph gets the height
  const [open, setOpen] = useState(!compact);
  useEffect(() => { setOpen(!compact); }, [compact]);
  if (!open && !path) { // a picked learning path always shows its key (目标 / 薄弱点)
    return (
      <div className="kg-legend kg-legend-min" data-testid="graph-legend">
        <button type="button" className="kg-lg-toggle" data-testid="graph-legend-toggle" onClick={() => setOpen(true)} title="展开图例">图例 ▸</button>
        <span className="kg-lg-hint">金色虚线 = 候选关系</span>
      </div>
    );
  }
  const dot = (cls, text, k) => <div key={k}><span className={`kg-lg-dot ${cls}`} />{text}</div>;
  const line = (cls, text, k) => <div key={k}><span className={`kg-lg-line ${cls}`} />{text}</div>;
  let rows;
  if (local?.kind === 'focus') {
    rows = [dot('focus', '聚焦节点', 'f'), dot('kp', '知识点', 'c'), dot('ext', '扩展节点', 'e'), line('cand', '金色虚线箭头 = 候选「前置」（悬停看标签）', 'p'),
      local.folds?.length ? dot('fold', '折叠：主题 · N个（一条汇总箭头分到各节点，悬停看 ×N）', 'fo') : null];
  } else if (local?.kind === 'path') {
    rows = [dot('target', '目标', 't'), dot('weak', '薄弱点（未展示掌握）', 'w'), line('cand', '金色虚线箭头 = 候选「前置」', 'p'),
      local.omitted ? line('skip', '点线 = 省略了中间环节', 's') : null];
  } else {
    rows = [dot('big', '主题（类别）· 双击收起', 't'), dot('kp', '知识点（左侧色条 = 掌握）', 'c'), dot('ext', '扩展节点（虚线框）', 'e'),
      line('contains', '主题色虚线 = 主题包含知识点', 'in'), line('rel', '关系', 'r'), line('cand', '金色虚线 = 候选关系', 'cand'),
      local?.kind === 'topic' ? dot('ghost', '其他主题的相关节点（淡色虚线框，点击切换主题）', 'g') : null,
      path ? dot('target', '目标', 'pt') : null, path ? dot('weak', '薄弱点', 'pw') : null];
  }
  return (
    <div className="kg-legend" data-testid="graph-legend">
      {rows.filter(Boolean)}
      {(local || path) && <div className="kg-lg-note" data-testid="graph-legend-note">箭头都是候选关系，不把这些箭头当成已验证知识</div>}
      {compact && <button type="button" className="kg-lg-toggle" data-testid="graph-legend-toggle" onClick={() => setOpen(false)} title="收起图例">收起 ◂</button>}
    </div>
  );
}

export const GraphFlow = forwardRef(function GraphFlow(props, ref) {
  return <ReactFlowProvider><GraphFlowInner {...props} ref={ref} /></ReactFlowProvider>;
});
