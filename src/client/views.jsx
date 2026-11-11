import React, { useEffect, useMemo, useRef, useState } from 'react';
import { mindmapLayout, graphLayout, wrapLabel, rectExit, edgeRoute, boardBounds, MASTERY_LABEL } from './layout.mjs';

export const TOPIC_COLORS = ['#6273dd', '#3f9d8f', '#d0883a', '#b0569a', '#5b8ed6', '#7d8a3c', '#c0564b', '#4e6a8a'];
const MASTERY_STROKE = { unverified: '#bbc6df', developing: '#e3a63b', demonstrated: '#47a36a' };

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint(); pt.x = clientX; pt.y = clientY;
  const m = svg.getScreenCTM();
  return m ? pt.matrixTransform(m.inverse()) : { x: clientX, y: clientY };
}

/** Course mind map (syllabus hierarchy) as an SVG tree. Editable: select, drag to reorder / re-parent, collapse. */
export function MindmapSvg({ hierarchy, editable = false, selectedId, onSelect, onDrop, collapsed, onToggle, maxWidth, availableWidth }) {
  const layout = useMemo(() => mindmapLayout(hierarchy, collapsed ?? new Set(), { availableWidth }), [hierarchy, collapsed, availableWidth]);
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const topicIndex = new Map((hierarchy?.children ?? []).map((t, i) => [t.id, i]));
  const colorOf = (n) => TOPIC_COLORS[(n.kind === 'topic' ? n.index : topicIndex.get(n.parentId) ?? 0) % TOPIC_COLORS.length];
  const hit = (p, except) => layout.nodes.find((n) => n.id !== except && p.x >= n.x - 6 && p.x <= n.x + n.w + 6 && p.y >= n.y - 5 && p.y <= n.y + n.h + 5);
  function down(e, n) {
    if (!editable || n.kind === 'root' || e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ id: n.id, node: n, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false });
  }
  function move(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    const moved = drag.moved || Math.hypot(dx, dy) > 5;
    const p = svgPoint(svgRef.current, e.clientX, e.clientY);
    const over = moved ? hit(p, drag.id) : null;
    setDrag({ ...drag, dx, dy, moved, over: over?.id });
  }
  function up(e, n) {
    if (!drag) { onSelect?.(n); return; }
    const d = drag; setDrag(null);
    if (!d.moved) { onSelect?.(d.node); return; }
    const p = svgPoint(svgRef.current, e.clientX, e.clientY);
    const target = hit(p, d.id);
    if (target && target.kind !== 'root') onDrop?.(d.node, target);
  }
  const W = layout.width, H = layout.height;
  return (
    <svg ref={svgRef} width={maxWidth ? Math.min(W, maxWidth) : W} height={maxWidth ? H * Math.min(1, maxWidth / W) : H} viewBox={`0 0 ${W} ${H}`}
      onPointerMove={move} onPointerLeave={() => drag && setDrag(null)} data-testid="mindmap-svg" role="tree" aria-label="课程思维导图">
      {layout.links.map(({ from, to }) => {
        let d;
        if (layout.mode === 'indent') {
          const px = from.x + 14, py = from.y + from.h, cy = to.y + to.h / 2;
          d = `M${px},${py} L${px},${cy - 8} Q${px},${cy} ${px + 8},${cy} L${to.x},${cy}`;
        } else {
          const x1 = from.x + from.w, y1 = from.y + from.h / 2, x2 = to.x, y2 = to.y + to.h / 2, mx = (x1 + x2) / 2;
          d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
        }
        return <path key={`${from.id}-${to.id}`} d={d} fill="none" stroke={to.kind === 'topic' ? '#b6c0dd' : colorOf(to)} strokeOpacity={to.kind === 'topic' ? 1 : 0.45} strokeWidth={to.kind === 'topic' ? 1.8 : 1.4} />;
      })}
      {layout.nodes.map((n) => {
        const sel = selectedId === n.id, dragging = drag?.moved && drag.id === n.id, over = drag?.over === n.id;
        const c = colorOf(n);
        const tx = dragging ? drag.dx : 0, ty = dragging ? drag.dy : 0;
        const fill = n.kind === 'root' ? '#5467c7' : n.kind === 'topic' ? '#f3f5ff' : sel ? '#e3e8fc' : '#fff';
        return (
          <g key={n.id} className={`mnode${dragging ? ' dragging' : ''}`} transform={`translate(${tx},${ty})`} data-node-id={n.id} data-kind={n.kind}
            role="treeitem" aria-selected={sel} onPointerDown={(e) => down(e, n)} onPointerUp={(e) => up(e, n)}>
            <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={n.kind === 'sub' ? 8 : 11} fill={fill}
              stroke={over ? '#d07a2e' : sel ? '#4256c4' : n.kind === 'root' ? '#5467c7' : n.kind === 'topic' ? c : '#c9d2e8'} strokeWidth={over || sel ? 2.2 : n.kind === 'topic' ? 1.6 : 1.1} />
            {n.kind === 'sub' && <rect x={n.x} y={n.y + 5} width={3} height={n.h - 10} rx={1.5} fill={c} />}
            <text x={n.x + n.w / 2} y={n.y + n.h / 2 + 4} textAnchor="middle" fontSize={n.kind === 'root' ? 13 : 12} fontWeight={n.kind === 'sub' ? 500 : 700}
              fill={n.kind === 'root' ? '#fff' : '#2a3755'} pointerEvents="none">{wrapLabel(n.title, n.w - 22, n.kind === 'root' ? 13 : 12, 1)[0]}</text>
            {n.kind === 'topic' && onToggle && (
              <g onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => { e.stopPropagation(); onToggle(n.id); }} style={{ cursor: 'pointer' }} data-toggle={n.id}>
                <circle cx={n.x + n.w + 9} cy={n.y + n.h / 2} r={7} fill="#fff" stroke={c} />
                <text x={n.x + n.w + 9} y={n.y + n.h / 2 + 3.5} textAnchor="middle" fontSize={10} fill={c} pointerEvents="none">{n.collapsed ? n.count : '−'}</text>
              </g>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** Semantic knowledge graph; every node visible (adaptive columns, two-line labels, viewBox sized to content). */
export function GraphSvg({ nodes, edges, topicOrder = [], selectedId, onSelect, width }) {
  const layout = useMemo(() => graphLayout(nodes), [nodes]);
  const tIndex = new Map(topicOrder.map((t, i) => [t, i]));
  const routes = useMemo(() => new Map(edges.map((e) => {
    const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
    return [e.id, a && b ? edgeRoute(a, b, [...layout.pos.values()]) : null];
  })), [edges, layout]);
  // Grow the viewBox so curved edges routed around nodes are never clipped.
  let minY = 0, maxY = layout.height;
  for (const r of routes.values()) if (r?.curved) { minY = Math.min(minY, r.ly - 14); maxY = Math.max(maxY, r.ly + 14); }
  const vbH = maxY - minY;
  const scale = width ? Math.min(1.25, width / layout.width) : 1;
  return (
    <svg viewBox={`0 ${minY} ${layout.width} ${vbH}`} width={layout.width * scale} height={vbH * scale} data-testid="graph-svg" role="img" aria-label="知识语义图谱">
      <defs>
        <marker id="omt-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0 0 L7 3 L0 6Z" fill="#8f9ed6" /></marker>
      </defs>
      {edges.map((e) => {
        const r = routes.get(e.id);
        if (!r) return null;
        return (
          <g key={e.id} data-edge-id={e.id}>
            <path d={r.d} fill="none" stroke="#8f9ed6" strokeWidth="1.7" strokeDasharray={e.status === 'candidate' ? '5 4' : undefined} markerEnd="url(#omt-arrow)" />
            <text x={r.lx} y={r.ly - 5} textAnchor="middle" fontSize="10" fill="#66759d" style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>{e.type}</text>
          </g>
        );
      })}
      {nodes.map((n) => {
        const p = layout.pos.get(n.id), sel = selectedId === n.id;
        const lines = wrapLabel(n.label, p.w - 18, 11, 2);
        const c = TOPIC_COLORS[(tIndex.get(n.topicId) ?? 0) % TOPIC_COLORS.length];
        return (
          <g key={n.id} className="node" data-node-id={n.id} onClick={() => onSelect?.(n.id)}>
            <rect x={p.x} y={p.y} width={p.w} height={p.h} rx="10" fill={sel ? '#e7ebff' : '#fff'} stroke={sel ? '#6274c9' : MASTERY_STROKE[n.mastery] ?? '#bbc6df'} strokeWidth={sel ? 2 : 1.3} />
            <rect x={p.x + 6} y={p.y + p.h - 5} width={p.w - 12} height={2} rx={1} fill={c} opacity={0.55} />
            {lines.map((l, i) => <text key={i} x={p.x + p.w / 2} y={p.y + p.h / 2 + 4 + (i - (lines.length - 1) / 2) * 14} fontSize="11" textAnchor="middle" fill="#2a3755">{l}</text>)}
          </g>
        );
      })}
    </svg>
  );
}

/** Course board. Editable: drag to move, click to select, link mode (click source then target), double-click note to edit. */
export function BoardCanvas({ elements, editable = false, selectedId, onSelect, onMove, linkMode = false, onLink, onEditNote, scale = 1, height, testId = 'board' }) {
  const [local, setLocal] = useState({});
  const [linkFrom, setLinkFrom] = useState(null);
  const [editing, setEditing] = useState(null);
  const dragRef = useRef(null);
  useEffect(() => { setLocal({}); }, [elements]);
  useEffect(() => { if (!linkMode) setLinkFrom(null); }, [linkMode]);
  const cards = elements.filter((e) => e.type !== 'arrow').map((e) => (local[e.id] ? { ...e, ...local[e.id] } : e));
  const byId = new Map(cards.map((c) => [c.id, c]));
  const arrows = elements.filter((e) => e.type === 'arrow' && byId.has(e.from) && byId.has(e.to));
  const rects = cards.map((c) => ({ x: c.x, y: c.y, w: c.width, h: c.height }));
  const b = boardBounds(cards);
  function down(e, c) {
    if (!editable || e.button !== 0 || editing === c.id) return;
    e.stopPropagation();
    if (linkMode) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { id: c.id, sx: e.clientX, sy: e.clientY, ox: c.x, oy: c.y, moved: false };
  }
  function move(e, c) {
    const d = dragRef.current;
    if (!d || d.id !== c.id) return;
    const dx = (e.clientX - d.sx) / scale, dy = (e.clientY - d.sy) / scale;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    d.moved = true; d.x = Math.max(0, Math.round(d.ox + dx)); d.y = Math.max(0, Math.round(d.oy + dy));
    setLocal((s) => ({ ...s, [c.id]: { x: d.x, y: d.y } }));
  }
  function up(e, c) {
    const d = dragRef.current;
    dragRef.current = null;
    if (linkMode && editable) {
      e.stopPropagation();
      if (!linkFrom) { setLinkFrom(c.id); return; }
      if (linkFrom !== c.id) onLink?.(linkFrom, c.id);
      setLinkFrom(null); return;
    }
    if (d && d.moved) { onMove?.(c.id, d.x, d.y); return; }
    onSelect?.(c.id);
  }
  return (
    <div className={`board${linkMode ? ' linking' : ''}`} style={height ? { height } : undefined} data-testid={testId} onPointerDown={() => editable && !linkMode && onSelect?.(null)}>
      <div className="boardlayer" style={{ width: b.width * scale, height: b.height * scale }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: b.width, height: b.height, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
          <svg className="edges" width={b.width} height={b.height}>
            <defs><marker id={`omt-barrow-${testId}`} markerWidth="9" markerHeight="9" refX="8" refY="3.5" orient="auto"><path d="M0 0 L8 3.5 L0 7Z" fill="#8a9cd8" /></marker></defs>
            {arrows.map((a) => {
              const s = byId.get(a.from), t = byId.get(a.to);
              const A = { x: s.x, y: s.y, w: s.width, h: s.height }, B = { x: t.x, y: t.y, w: t.width, h: t.height };
              const r = edgeRoute(A, B, rects), sel = selectedId === a.id;
              return (
                <g key={a.id} data-arrow-id={a.id}>
                  <path d={r.d} fill="none" stroke={sel ? '#4256c4' : '#9daedf'} strokeWidth={sel ? 2.6 : 2} strokeDasharray={a.relationId ? '6 4' : undefined} markerEnd={`url(#omt-barrow-${testId})`} />
                  {a.label ? <text x={r.lx} y={r.ly - 6} textAnchor="middle" fontSize="10" fill="#66759d" style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>{a.label}</text> : null}
                  {editable && <path className="hit" d={r.d} fill="none" onPointerDown={(e) => { e.stopPropagation(); onSelect?.(a.id); }} />}
                </g>
              );
            })}
          </svg>
          {cards.map((c) => (
            <div key={c.id} data-element={c.id} data-type={c.type} data-concept={c.conceptId ?? ''}
              className={`boardnode${c.type === 'note' ? ' note' : ''}${selectedId === c.id ? ' sel' : ''}${linkFrom === c.id ? ' linksrc' : ''}${c.stale ? ' stale' : ''}${c.mastery && c.mastery !== 'unverified' ? ' ' + c.mastery : ''}`}
              style={{ left: c.x, top: c.y, width: c.width, height: c.height, background: c.color || undefined }}
              title={c.type === 'concept' ? `${c.text} · ${MASTERY_LABEL[c.mastery] ?? ''}` : c.text}
              onPointerDown={(e) => down(e, c)} onPointerMove={(e) => move(e, c)} onPointerUp={(e) => up(e, c)}
              onDoubleClick={() => editable && c.type === 'note' && setEditing(c.id)}>
              {editing === c.id
                ? <textarea autoFocus defaultValue={c.text} style={{ width: '100%', height: '100%', border: 0, background: 'transparent', font: 'inherit', resize: 'none', textAlign: 'center' }}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => { setEditing(null); const v = e.target.value.trim(); if (v && v !== c.text) onEditNote?.(c.id, v); }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } if (e.key === 'Escape') setEditing(null); }} />
                : c.text}
              {c.updatedBy && editable ? <span className="by">{c.updatedBy === 'learner' ? '你' : 'AI'}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
