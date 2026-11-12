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
//     workbench already has 放大 / 整个工作台 / 还原 and a readable-zoom fit (never below 0.8 unless asked).
//   - Simulation ticks only update view state (positions); nothing in this file writes application data.
//   (2026-11-12) Extension nodes get their own registered node type (they used to fall back to React Flow's empty
//     default box); a `local` view (focus on one node / learning path, built by ./graph-focus.mjs) replaces the
//     whole-course graph with a dagre top → bottom layout, folded topic groups and dotted skipped links; the two-node
//     path is a directed 前置 learning path (no undirected fallback) with the target and weak points marked.
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel, BaseEdge, EdgeLabelRenderer, MarkerType, Handle, Position,
  applyNodeChanges, useInternalNode, useReactFlow, useStore } from '@xyflow/react';
import { buildGraph, visibleGraph, neighbours, searchNodes, NODE_KINDS } from './graph-model.mjs';
import { learningPath, weakIds } from './graph-focus.mjs';
import { NODE_SIZE, FORCE_LINK_DISTANCE, sizeOfKind, layoutGraph, parallelEdgeCurves } from './coa/graphLayout.mjs';
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
const RELATION = '#64748b';
const CANDIDATE = '#b8860b';
const MIN_READABLE_ZOOM = 0.8;
/** Courses bigger than this start with every topic collapsed (lazy reveal by double-click). */
export const LAZY_THRESHOLD = 60;

/* ─── Highlight state via context (upstream HoverContext): hovering never re-creates node objects ─── */
const KgContext = createContext({ lit: null, hits: null, ends: [], sel: null, target: null, weak: null, focusId: null, local: null, setHoveredEdgeId: () => {} });

function nodeTitle(n, local) {
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
    n.id === target ? 'target' : '', weak?.has(n.id) ? 'weak' : '', n.id === focusId ? 'focus' : ''].filter(Boolean).join(' ');
  const topic = n.kind === 'topic', fold = n.kind === 'fold';
  const size = sizeOfKind(n.kind);
  // mastery ring only on knowledge points (extensions have no mastery; folds and topics are groups)
  const mastery = n.kind === 'concept' ? (n.mastery ?? '') : '';
  return (
    <div className={`kg-node kg-dot kg-${n.kind} ${mastery} ${cls}`} style={{ '--c': data.color, width: size, height: size }} data-node-id={n.id} data-kind={n.kind}
      data-collapsed={topic ? String(!!n.collapsed) : undefined} data-weak={weak?.has(n.id) ? 'true' : undefined} title={nodeTitle(n, local)}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="kg-anchor" />
      <div className="kg-label">{fold ? <>{n.title}<br /><small>{n.count} 个前置</small></> : n.label}</div>
      {topic && n.count > 0 && <span className="kg-badge" data-testid="kg-badge">{n.collapsed ? `+${n.count}` : '−'}</span>}
      {fold && <span className="kg-badge" data-testid="kg-fold-badge">+{n.count}</span>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="kg-anchor" />
    </div>
  );
}
/** One renderer, four registered kinds: every `kind` buildGraph / graph-focus can emit must be listed here. */
export const nodeTypes = Object.fromEntries(NODE_KINDS.map((k) => [k, KgNode]));

/* ─── Floating edge: circle boundary to circle boundary, HTML label (upstream FloatingEdge) ─── */
function FloatingEdge({ id, source, target, data, markerEnd, style, label }) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const { setHoveredEdgeId } = useContext(KgContext);
  if (!sourceNode || !targetNode) return null;
  const sizeOf = (n) => n.measured?.width ?? n.width ?? NODE_SIZE.concept;
  const centre = (n) => ({ x: n.internals.positionAbsolute.x + sizeOf(n) / 2, y: n.internals.positionAbsolute.y + (n.measured?.height ?? sizeOf(n)) / 2 });
  const s = centre(sourceNode);
  const t = centre(targetNode);
  const rSource = sizeOf(sourceNode) / 2;
  const rTarget = sizeOf(targetNode) / 2;
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
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
      {label ? (
        <EdgeLabelRenderer>
          <div className={`kg-elabel ${data?.cls ?? ''}`} style={{ transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)`, opacity: style?.opacity }}
            onMouseEnter={() => setHoveredEdgeId(id)} onMouseLeave={() => setHoveredEdgeId(null)}>{label}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
const edgeTypes = { floating: FloatingEdge };

/** Thin hook over the ported factory (upstream useLiveForceSimulation). */
function useLiveForceSimulation(initialNodes, edges, setNodes, { enabled, nodeSize, linkDistance, nodeSizeOf, startRef }) {
  const simRef = useRef(null);
  useEffect(() => {
    if (!enabled || initialNodes.length === 0) return undefined;
    const sim = createLiveForceSimulation(initialNodes, edges, setNodes, { nodeSize, linkDistance, nodeSizeOf, startPositions: startRef?.current?.() ?? undefined });
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
  query = '', pathMode = false, collapsed, setCollapsed, onPath, local = null, onLocalClick, onUnfold }, ref) {
  const rf = useReactFlow();
  const wrapRef = useRef(null);
  // `local` (graph-focus.mjs): a focus view or a learning path replaces the whole-course graph; no topic collapse there
  const fullGraph = useMemo(() => buildGraph(view, topics), [view, topics]);
  const graph = local ? local.graph : fullGraph;
  const vis = useMemo(() => (local ? local.graph : visibleGraph(fullGraph, collapsed)), [local, fullGraph, collapsed]);
  const effLayout = local ? 'tb' : layout;
  const isForce = effLayout === 'force';
  const tIndex = useMemo(() => new Map(topics.map((t, i) => [t.id, i])), [topics]);
  const shown = useMemo(() => new Map(vis.nodes.map((n) => [n.id, n])), [vis]);

  // Layout depends on topology only (upstream: structural inputs), so renames / mastery changes never re-run it.
  const structure = `${effLayout}|${vis.nodes.map((n) => n.id).join(',')}|${vis.edges.map((e) => `${e.id}:${e.source}>${e.target}`).join(',')}`;
  const structuralEdges = useMemo(() => vis.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })), [structure]); // eslint-disable-line react-hooks/exhaustive-deps
  const [size, setSize] = useState({ w: 0, h: 0 });
  // the packed layout is chosen for the canvas shape (bucketed so small resizes do not re-pack)
  const aspect = size.w && size.h ? `${Math.round(size.w / 80)}x${Math.round(size.h / 80)}` : '';
  const homes = useMemo(() => layoutGraph(vis.nodes, structuralEdges, effLayout, { canvas: { w: size.w, h: size.h } }), [structure, aspect]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizeOfId = useCallback((id) => sizeOfKind(id.startsWith('topic:') ? 'topic' : id.startsWith('fold:') ? 'fold' : 'concept'), []);
  // Every graph node stays in the controlled list; collapsed knowledge points are `hidden` at their topic's place.
  const initialNodes = useMemo(() => graph.nodes.map((g0) => {
    const n = shown.get(g0.id) ?? g0, hidden = !shown.has(g0.id);
    const p = homes.get(n.id) ?? homes.get(`topic:${n.topicId}`) ?? { x: 0, y: 0 };
    const size = sizeOfKind(n.kind);
    // Declared handles (centre anchors): React Flow then has handle bounds without measuring the DOM, so edges never
    // drop out while nodes are re-measured after a container change (seen in DSH after 放大 → 整个工作台).
    return { id: n.id, type: n.kind, hidden, position: p, width: size, height: size, zIndex: 2, data: { n, color: colorAt(tIndex.get(n.topicId)) },
      handles: [{ type: 'source', position: Position.Bottom, x: size / 2, y: size / 2, width: 1, height: 1 }, { type: 'target', position: Position.Top, x: size / 2, y: size / 2, width: 1, height: 1 }] };
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
      out.set(n.id, { x: n.position.x + sizeOfId(n.id) / 2, y: n.position.y + sizeOfId(n.id) / 2 });
    }
    prevHomesRef.current = homes;
    return out;
  };
  useEffect(() => { setLiveNodes(initialNodes); }, [initialNodes]);
  const simulation = useLiveForceSimulation(simNodes, structuralEdges, setLiveNodes, { enabled: isForce, nodeSize: NODE_SIZE.concept, linkDistance: FORCE_LINK_DISTANCE, nodeSizeOf: sizeOfId, startRef });

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
  const oneHop = (id) => ({ nodes: new Set([id, ...neighbours(vis.edges, id)]), edges: new Set(vis.edges.filter((e) => e.source === id || e.target === id).map((e) => e.id)) });
  let lit = null, hotEdges = null, mode = local ? `local-${local.kind}` : '';
  if (path) { lit = new Set(path.nodes); hotEdges = new Set(path.edges); mode = 'path'; }
  else if (query.trim()) { lit = matches; hotEdges = new Set(); mode = 'search'; }
  else if (hoveredId && shown.has(hoveredId)) { ({ nodes: lit, edges: hotEdges } = oneHop(hoveredId)); mode = 'hover'; }
  else if (hoveredEdgeId) { const e = vis.edges.find((x) => x.id === hoveredEdgeId); if (e) { lit = new Set([e.source, e.target]); hotEdges = new Set([e.id]); mode = 'hover'; } }
  else if (focus) { ({ nodes: lit, edges: hotEdges } = oneHop(focus)); mode = 'focus'; }
  const target = local ? (local.target ?? null) : (path?.to ?? null);
  const weak = local ? (local.weak ?? null) : pathWeak;
  const focusId = local?.focusId ?? null;
  const ctx = useMemo(() => ({ lit, hits: mode === 'search' ? lit : null, ends: pathEnds, sel, target, weak, focusId, local: local?.kind ?? null, setHoveredEdgeId }),
    [lit && [...lit].join(','), mode, pathEnds, sel, target, weak && [...weak].join(','), focusId, local?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const showEdgeLabels = useStore((s) => s.transform[2] >= EDGE_LABEL_MIN_ZOOM);
  const curves = useMemo(() => { const m = new Map(); const cs = parallelEdgeCurves(vis.edges); vis.edges.forEach((e, i) => m.set(e.id, cs[i])); return m; }, [vis.edges]);
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
      const text = `${RELATION_LABEL[e.label] ?? e.label}${candidate ? ' · 候选' : ''}${e.members.length > 1 ? ` ×${e.members.length}` : ''}`;
      return { id: e.id, source: e.source, target: e.target, type: 'floating', zIndex: hot ? 1 : 0,
        className: `kg-rel${dim ? ' dim' : ''}${hot ? ' hot' : ''}${e.aggregated ? ' agg' : ''}`, label: showEdgeLabels || hot ? text : undefined,
        style: { stroke, strokeWidth: hot ? 2.8 : 1.8, strokeDasharray: candidate ? '6 4' : undefined, opacity: dim ? 0.12 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: ARROW_SIZE, height: ARROW_SIZE, markerUnits: 'userSpaceOnUse', strokeWidth: 1.5 },
        data: { curve: curves.get(e.id) ?? 0, cls: dim ? 'dim' : hot ? 'hot' : '' } };
    });
    for (const e of graph.edges) if (!shown.has(e.source) || !shown.has(e.target)) out.push({ id: `hidden:${e.id}`, source: e.source, target: e.target, type: 'floating', hidden: true, data: {} });
    return out;
  }, [vis.edges, graph.edges, shown, hotEdges && [...hotEdges].join(','), showEdgeLabels, curves, tIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── readable fit (our workbench rule): never below 0.8 unless asked; keep the selection in view when it overflows ───
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([en]) => setSize({ w: Math.round(en.contentRect.width), h: Math.round(en.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const focusRef = useRef(sel); focusRef.current = sel;
  const homesRef = useRef(simNodes); homesRef.current = simNodes;
  const [fitState, setFitState] = useState({ overflow: false, zoom: 1 });
  const fit = useCallback(({ live = true } = {}) => {
    // after a structure change fit the FINAL layout (upstream: do not wait for the settle animation); otherwise fit
    // what is on screen (a dragged node may have left its packed home)
    const ns = live ? liveRef.current.filter((n) => !n.hidden) : homesRef.current;
    const b = unionBounds(ns.map((n) => ({ x: n.position.x, y: n.position.y, width: n.width, height: n.height })));
    if (!b || !size.w || !size.h) return;
    const v = fitViewport(b, size.w, size.h, { minZoom: MIN_READABLE_ZOOM, maxZoom: 1.2 });
    const f = v.overflow && ns.find((n) => n.id === focusRef.current);
    if (f) rf.setViewport({ x: size.w / 2 - (f.position.x + f.width / 2) * v.zoom, y: size.h / 2 - (f.position.y + f.height / 2) * v.zoom, zoom: v.zoom });
    else rf.setViewport({ x: v.x, y: v.y, zoom: v.zoom });
    setFitState({ overflow: v.overflow, zoom: v.zoom });
    onFit?.({ overflow: v.overflow, zoom: v.zoom });
  }, [rf, size.w, size.h, onFit]);
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
  useImperativeHandle(ref, () => ({ fit: () => fit(), centreOn, zoomBy(f) { const v = rf.getViewport(); rf.setViewport({ ...v, zoom: Math.min(1.8, Math.max(0.3, v.zoom * f)) }, { duration: 120 }); } }), [fit, centreOn, rf]);

  // ─── interaction ───
  const toggleTopic = (topicId) => setCollapsed((s) => { const next = new Set(s); if (next.has(topicId)) next.delete(topicId); else next.add(topicId); return next; });
  const onNodeClick = (_e, node) => {
    const n = node.data.n;
    if (local) { if (n.kind === 'fold') onUnfold?.(); else onLocalClick?.(n.id); return; }
    if (pathMode) { setPathEnds((p) => (p.length >= 2 ? [n.id] : p.includes(n.id) ? p : [...p, n.id])); return; }
    setClickFocus(n.id);
    if (n.kind !== 'topic') onSelect?.(n.id);
  };
  const onNodeDoubleClick = (_e, node) => {
    const n = node.data.n;
    if (pathMode || local) return;
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
          onNodeDragStart={(_e, node) => simulation.onDragStart(node.id, node.position)}
          onNodeDrag={(_e, node) => simulation.onDrag(node.id, node.position)}
          onNodeDragStop={(_e, node) => simulation.onDragStop(node.id)}
          onNodeMouseEnter={(_e, node) => setHoveredId(node.id)} onNodeMouseLeave={() => setHoveredId(null)}
          onEdgeMouseEnter={(_e, edge) => setHoveredEdgeId(edge.id)} onEdgeMouseLeave={() => setHoveredEdgeId(null)}
          onPaneClick={() => { setClickFocus(null); if (!pathMode && !local) onSelect?.(null); }}
          nodesDraggable nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} disableKeyboardA11y zoomOnDoubleClick={false}
          panOnScroll zoomOnScroll={false} zoomOnPinch minZoom={0.15} maxZoom={2.5} nodeDragThreshold={3} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#dbe1ee" />
          {minimap && <MiniMap pannable zoomable nodeColor={(n) => n.data?.color ?? '#9aa6c4'} nodeStrokeWidth={0} maskColor="rgba(240,243,250,.7)" style={{ width: 150, height: 96 }} />}
          <Panel position="bottom-left">
            <GraphLegend local={local} path={path} />
          </Panel>
        </ReactFlow>
      </div>
    </KgContext.Provider>
  );
});
/** In-graph legend: matches the strokes actually drawn (dashed = 虚线, dotted = 点线). */
function GraphLegend({ local, path }) {
  const dot = (cls, text, k) => <div key={k}><span className={`kg-lg-dot ${cls}`} />{text}</div>;
  const line = (cls, text, k) => <div key={k}><span className={`kg-lg-line ${cls}`} />{text}</div>;
  let rows;
  if (local?.kind === 'focus') {
    rows = [dot('focus', '聚焦节点', 'f'), dot('', '知识点', 'c'), dot('ext', '扩展节点', 'e'), line('cand', '前置（候选，金色虚线）', 'p'),
      local.folds?.length ? dot('fold', '折叠：主题 · N个', 'fo') : null];
  } else if (local?.kind === 'path') {
    rows = [dot('target', '目标', 't'), dot('weak', '薄弱点（未展示掌握）', 'w'), line('cand', '前置（候选）', 'p'),
      local.omitted ? line('skip', '点线 = 省略了中间环节', 's') : null];
  } else {
    rows = [dot('big', '主题（类别）· 双击收起', 't'), dot('', '知识点（实例）', 'c'), dot('ext', '扩展节点（虚线圆）', 'e'),
      line('contains', '包含（主题色虚线）', 'in'), line('rel', '关系', 'r'), line('cand', '候选关系（金色虚线）', 'cand'),
      path ? dot('target', '目标', 'pt') : null, path ? dot('weak', '薄弱点', 'pw') : null];
  }
  return (
    <div className="kg-legend" data-testid="graph-legend">
      {rows.filter(Boolean)}
      {(local || path) && <div className="kg-lg-note" data-testid="graph-legend-note">箭头都是候选关系，不把这些箭头当成已验证知识</div>}
    </div>
  );
}

export const GraphFlow = forwardRef(function GraphFlow(props, ref) {
  return <ReactFlowProvider><GraphFlowInner {...props} ref={ref} /></ReactFlowProvider>;
});
