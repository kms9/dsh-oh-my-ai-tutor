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
// Licensed under the Apache License, Version 2.0 (see THIRD_PARTY_NOTICES.md).
import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Panel, BaseEdge, EdgeLabelRenderer, MarkerType, Handle, Position,
  applyNodeChanges, useInternalNode, useReactFlow, useStore } from '@xyflow/react';
import { buildGraph, visibleGraph, neighbours, shortestPath, searchNodes } from './graph-model.mjs';
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
const KgContext = createContext({ lit: null, hits: null, ends: [], sel: null, setHoveredEdgeId: () => {} });

function KgNode({ data }) {
  const n = data.n;
  const { lit, hits, ends, sel } = useContext(KgContext);
  const cls = [lit && !lit.has(n.id) ? 'dim' : '', hits?.has(n.id) ? 'hit' : '', n.id === sel ? 'sel' : '', ends.includes(n.id) ? 'end' : ''].filter(Boolean).join(' ');
  const topic = n.kind === 'topic';
  const size = sizeOfKind(n.kind);
  const title = topic ? `${n.label} — 主题（类别），双击${n.collapsed ? '展开' : '收起'}它的 ${n.count} 个知识点` : `${n.label} · ${MASTERY_LABEL[n.mastery] ?? ''}（双击展开它关系所在的主题）`;
  return (
    <div className={`kg-node kg-dot kg-${n.kind} ${n.mastery ?? ''} ${cls}`} style={{ '--c': data.color, width: size, height: size }} data-node-id={n.id} data-kind={n.kind}
      data-collapsed={topic ? String(!!n.collapsed) : undefined} title={title}>
      <Handle type="target" position={Position.Top} isConnectable={false} className="kg-anchor" />
      <div className="kg-label">{n.label}</div>
      {topic && n.count > 0 && <span className="kg-badge" data-testid="kg-badge">{n.collapsed ? `+${n.count}` : '−'}</span>}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="kg-anchor" />
    </div>
  );
}
const nodeTypes = { topic: KgNode, concept: KgNode };

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
  query = '', pathMode = false, collapsed, setCollapsed, onPath }, ref) {
  const rf = useReactFlow();
  const wrapRef = useRef(null);
  const isForce = layout === 'force';
  const graph = useMemo(() => buildGraph(view, topics), [view, topics]);
  const vis = useMemo(() => visibleGraph(graph, collapsed), [graph, collapsed]);
  const tIndex = useMemo(() => new Map(topics.map((t, i) => [t.id, i])), [topics]);
  const shown = useMemo(() => new Map(vis.nodes.map((n) => [n.id, n])), [vis]);

  // Layout depends on topology only (upstream: structural inputs), so renames / mastery changes never re-run it.
  const structure = `${layout}|${vis.nodes.map((n) => n.id).join(',')}|${vis.edges.map((e) => `${e.id}:${e.source}>${e.target}`).join(',')}`;
  const structuralEdges = useMemo(() => vis.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })), [structure]); // eslint-disable-line react-hooks/exhaustive-deps
  const [size, setSize] = useState({ w: 0, h: 0 });
  // the packed layout is chosen for the canvas shape (bucketed so small resizes do not re-pack)
  const aspect = size.w && size.h ? `${Math.round(size.w / 80)}x${Math.round(size.h / 80)}` : '';
  const homes = useMemo(() => layoutGraph(vis.nodes, structuralEdges, layout, { canvas: { w: size.w, h: size.h } }), [structure, aspect]); // eslint-disable-line react-hooks/exhaustive-deps
  const sizeOfId = useCallback((id) => sizeOfKind(id.startsWith('topic:') ? 'topic' : 'concept'), []);
  // Every graph node stays in the controlled list; collapsed knowledge points are `hidden` at their topic's place.
  const initialNodes = useMemo(() => graph.nodes.map((g0) => {
    const n = shown.get(g0.id) ?? g0, hidden = !shown.has(g0.id);
    const p = homes.get(n.id) ?? homes.get(`topic:${n.topicId}`) ?? { x: 0, y: 0 };
    const size = sizeOfKind(n.kind);
    return { id: n.id, type: n.kind, hidden, position: p, width: size, height: size, zIndex: 2, data: { n, color: colorAt(tIndex.get(n.topicId)) } };
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
  useEffect(() => { if (!pathMode) setPathEnds([]); }, [pathMode]);
  const path = useMemo(() => (pathEnds.length === 2 ? shortestPath(vis.edges, pathEnds[0], pathEnds[1]) : null), [pathEnds, vis.edges]);
  useEffect(() => { onPath?.(pathEnds.length === 2 ? { ends: pathEnds, path, labels: (path?.nodes ?? []).map((id) => shown.get(id)?.label ?? id) } : pathEnds.length ? { ends: pathEnds } : null); },
    [pathEnds, path]); // eslint-disable-line react-hooks/exhaustive-deps
  const matches = useMemo(() => new Set(searchNodes(vis.nodes, query)), [vis.nodes, query]);
  const sel = selectedId && shown.has(selectedId) ? selectedId : clickFocus;
  const focus = clickFocus && shown.has(clickFocus) ? clickFocus : null;
  const oneHop = (id) => ({ nodes: new Set([id, ...neighbours(vis.edges, id)]), edges: new Set(vis.edges.filter((e) => e.source === id || e.target === id).map((e) => e.id)) });
  let lit = null, hotEdges = null, mode = '';
  if (path) { lit = new Set(path.nodes); hotEdges = new Set(path.edges); mode = 'path'; }
  else if (query.trim()) { lit = matches; hotEdges = new Set(); mode = 'search'; }
  else if (hoveredId && shown.has(hoveredId)) { ({ nodes: lit, edges: hotEdges } = oneHop(hoveredId)); mode = 'hover'; }
  else if (hoveredEdgeId) { const e = vis.edges.find((x) => x.id === hoveredEdgeId); if (e) { lit = new Set([e.source, e.target]); hotEdges = new Set([e.id]); mode = 'hover'; } }
  else if (focus) { ({ nodes: lit, edges: hotEdges } = oneHop(focus)); mode = 'focus'; }
  const ctx = useMemo(() => ({ lit, hits: mode === 'search' || mode === 'path' ? lit : null, ends: pathEnds, sel, setHoveredEdgeId }),
    [lit && [...lit].join(','), mode, pathEnds, sel]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const fittedKey = useRef('');
  useEffect(() => {
    const key = `${structure}|${aspect}`;
    fit({ live: fittedKey.current === key }); // new layout → its final positions; same layout, new size → what is on screen
    fittedKey.current = key;
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
    if (pathMode) { setPathEnds((p) => (p.length >= 2 ? [n.id] : p.includes(n.id) ? p : [...p, n.id])); return; }
    setClickFocus(n.id);
    if (n.kind !== 'topic') onSelect?.(n.id);
  };
  const onNodeDoubleClick = (_e, node) => {
    const n = node.data.n;
    if (pathMode) return;
    if (n.kind === 'topic') { toggleTopic(n.topicId); return; }
    // lazy expand: reveal every collapsed topic one of this knowledge point's relations leads into
    const far = graph.edges.filter((e) => e.kind === 'relation' && (e.source === n.id || e.target === n.id))
      .map((e) => graph.nodes.find((x) => x.id === (e.source === n.id ? e.target : e.source))?.topicId).filter((t) => t && collapsed.has(t));
    if (far.length) setCollapsed((s) => { const next = new Set(s); far.forEach((t) => next.delete(t)); return next; });
  };
  const onNodesChange = useCallback((changes) => setLiveNodes((nds) => applyNodeChanges(changes.filter((c) => c.type === 'position' || c.type === 'dimensions'), nds)), []);

  return (
    <KgContext.Provider value={ctx}>
      <div className={`rf-wrap rf-graph kg${mode ? ` kg-${mode}` : ''}${pathMode ? ' kg-picking' : ''}`} ref={wrapRef} style={{ height }} data-testid="graph-flow"
        data-scale={fitState.zoom.toFixed(2)} data-overflow={String(fitState.overflow)} data-layout={layout} data-mode={mode}>
        <ReactFlow nodes={displayNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
          onNodeClick={onNodeClick} onNodeDoubleClick={onNodeDoubleClick}
          onNodeDragStart={(_e, node) => simulation.onDragStart(node.id, node.position)}
          onNodeDrag={(_e, node) => simulation.onDrag(node.id, node.position)}
          onNodeDragStop={(_e, node) => simulation.onDragStop(node.id)}
          onNodeMouseEnter={(_e, node) => setHoveredId(node.id)} onNodeMouseLeave={() => setHoveredId(null)}
          onEdgeMouseEnter={(_e, edge) => setHoveredEdgeId(edge.id)} onEdgeMouseLeave={() => setHoveredEdgeId(null)}
          onPaneClick={() => { setClickFocus(null); if (!pathMode) onSelect?.(null); }}
          nodesDraggable nodesConnectable={false} elementsSelectable={false} deleteKeyCode={null} disableKeyboardA11y zoomOnDoubleClick={false}
          panOnScroll zoomOnScroll={false} zoomOnPinch minZoom={0.15} maxZoom={2.5} nodeDragThreshold={3} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#dbe1ee" />
          {minimap && <MiniMap pannable zoomable nodeColor={(n) => n.data?.color ?? '#9aa6c4'} nodeStrokeWidth={0} maskColor="rgba(240,243,250,.7)" style={{ width: 150, height: 96 }} />}
          <Panel position="bottom-left">
            <div className="kg-legend" data-testid="graph-legend">
              <div><span className="kg-lg-dot big" />主题（类别）· 双击收起</div>
              <div><span className="kg-lg-dot" />知识点（实例）</div>
              <div><span className="kg-lg-line contains" />包含</div>
              <div><span className="kg-lg-line rel" />关系</div>
              <div><span className="kg-lg-line cand" />候选关系</div>
            </div>
          </Panel>
        </ReactFlow>
      </div>
    </KgContext.Provider>
  );
});
export const GraphFlow = forwardRef(function GraphFlow(props, ref) {
  return <ReactFlowProvider><GraphFlowInner {...props} ref={ref} /></ReactFlowProvider>;
});
