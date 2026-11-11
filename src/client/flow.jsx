import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, MiniMap, Handle, Position, MarkerType, ConnectionMode, applyNodeChanges, useReactFlow } from '@xyflow/react';
import { packSections, framesAround, NOTE_NEAR } from '../board-layout.mjs';
import { edgeSides, fitViewport, unionBounds, RELATION_LABEL } from './flow-layout.mjs';
import { MASTERY_LABEL, safeColor } from './layout.mjs';

export const TOPIC_COLORS = ['#6273dd', '#3f9d8f', '#d0883a', '#b0569a', '#5b8ed6', '#7d8a3c', '#c0564b', '#4e6a8a'];
const colorAt = (i) => TOPIC_COLORS[((i ?? 0) % TOPIC_COLORS.length + TOPIC_COLORS.length) % TOPIC_COLORS.length];
const FREE = '#8a94a8';
const HANDLES = [['r', Position.Right], ['l', Position.Left], ['t', Position.Top], ['b', Position.Bottom]];
const AI_EDGE = '#5a6bc9', LEARNER_EDGE = '#2f8a63', RELATION_EDGE = '#b8860b';
const MIN_READABLE_ZOOM = 0.8;

/** Connection points on every side; ConnectionMode.Loose lets any of them start or end an arrow. */
function SideHandles({ connectable }) {
  return HANDLES.map(([id, pos]) => <Handle key={id} id={id} type="source" position={pos} isConnectable={connectable} className="omt-h" />);
}

const BoardCtx = createContext(null);

function ActorBadge({ el }) {
  const ai = el.createdBy === 'ai';
  const edited = el.updatedBy && el.updatedBy !== el.createdBy;
  return (
    <span className={`rf-by ${ai ? 'ai' : 'me'}`} title={`${ai ? 'AI 创建' : '你创建'}${edited ? `，${el.updatedBy === 'ai' ? 'AI' : '你'}最后修改` : ''}`}>
      {ai ? 'AI' : '你'}{edited ? <i>·{el.updatedBy === 'ai' ? 'AI改' : '你改'}</i> : null}
    </span>
  );
}

function CardEditor({ el, ctx }) {
  const ed = ctx.editing;
  return (
    <textarea className="rf-edit nodrag nopan nowheel" autoFocus defaultValue={ed.draft} data-testid="board-card-editor"
      onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => ctx.commitEdit(el, e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); ctx.cancelEdit(); }
      }} />
  );
}

/** Knowledge-point card / note: custom HTML node. Actor (AI / 你) and mastery are always visible. */
function BoardCardNode({ data, selected }) {
  const ctx = useContext(BoardCtx);
  const el = data.el;
  const editing = ctx.editing?.id === el.id;
  const note = el.type === 'note';
  const ai = el.createdBy === 'ai';
  const cls = ['rf-card', note ? `note ${ai ? 'note-ai' : 'note-me'}` : 'concept', selected ? 'sel' : '', el.stale ? 'stale' : '',
    ctx.linkFrom === el.id ? 'linksrc' : '', ctx.fresh.has(el.id) ? 'fresh' : '', el.mastery && el.mastery !== 'unverified' ? el.mastery : ''].filter(Boolean).join(' ');
  const custom = safeColor(el.color);
  return (
    <div className={cls} data-element={el.id} data-type={el.type} data-concept={el.conceptId ?? ''} data-actor={el.createdBy ?? ''}
      style={{ '--accent': data.color, ...(custom ? { background: custom } : {}) }}
      title={note ? el.text : `${el.text} · ${MASTERY_LABEL[el.mastery] ?? ''}（双击改名，改的是课程大纲）`}>
      <SideHandles connectable={ctx.editable && !editing} />
      {editing ? <CardEditor el={el} ctx={ctx} /> : <div className="rf-title">{el.text}</div>}
      <div className="rf-foot">
        {note ? <span className="rf-kind">{ai ? 'AI 便签' : '我的便签'}</span>
          : <span className={`rf-mastery ${el.mastery ?? ''}`}><i />{el.stale ? '已不在大纲' : MASTERY_LABEL[el.mastery] ?? '未验证'}</span>}
        <ActorBadge el={el} />
      </div>
      {ctx.fresh.has(el.id) ? <span className="rf-fresh">AI 刚改</span> : null}
    </div>
  );
}

/** Topic section (view-only grouping; not stored, follows where the cards are). */
function SectionNode({ data }) {
  return (
    <div className="rf-section" style={{ '--accent': data.color }} data-section={data.id}>
      <div className="rf-section-title"><span>{data.title}</span><em>{data.count}</em></div>
    </div>
  );
}

const boardNodeTypes = { card: BoardCardNode, section: SectionNode };

const clampCoord = (v) => Math.min(20000, Math.max(0, Math.round(v)));
const sig = (e) => `${e.updatedAt ?? ''}|${e.x}|${e.y}|${e.text ?? ''}|${e.label ?? ''}`;

/**
 * Controlled React Flow board. React Flow only collects gestures; every change is translated into a board.patch
 * (or, for a concept card title, a course.editOutline rename) against the revision on screen when the gesture began.
 * Store elements are the only source of truth: what is drawn is always the last polled board plus the position of
 * cards the learner is dragging (or whose save is still in flight).
 */
const BoardFlowInner = forwardRef(function BoardFlowInner(props, ref) {
  const { elements, revision, topics, concepts, height, editable = true, linkMode = false, onLinkModeDone, onPatch, onRenameConcept,
    syllabusRevision, onSelectConcept, onSelectionChange, onFit, minimap = false } = props;
  const rf = useReactFlow();
  const wrapRef = useRef(null);
  const [nodes, setNodes] = useState([]);
  const [edgeSel, setEdgeSel] = useState(() => new Set());
  const [editing, setEditingState] = useState(null); // { id, draft, rev, concept?, saving? }
  const editingRef = useRef(null);
  const setEditing = useCallback((v) => { editingRef.current = v; setEditingState(v); }, []);
  const freshTimer = useRef(null);
  const [linkFrom, setLinkFrom] = useState(null);
  const [fresh, setFresh] = useState(() => new Set());
  const pending = useRef(new Map()); // id -> { x, y } kept on screen while dragging / saving
  const dragRef = useRef(null); // { rev, ids }
  const connectRev = useRef(revision);
  const elementsRef = useRef(elements); elementsRef.current = elements;
  const revRef = useRef(revision); revRef.current = revision;
  const seen = useRef(null);

  // Sections are packed for display (never overlapping); a card is drawn at stored + its section offset.
  const layout = useMemo(() => packSections(elements, topics, concepts), [elements, topics, concepts]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const assignment = layout.assignment;
  const topicIndex = useMemo(() => new Map(topics.map((t, i) => [t.id, i])), [topics]);
  const colorOf = useCallback((id) => { const t = assignment.get(id); return t ? colorAt(topicIndex.get(t)) : FREE; }, [assignment, topicIndex]);

  const build = useCallback((els, prev) => {
    const prevById = new Map(prev.map((n) => [n.id, n]));
    return els.filter((e) => e.type !== 'arrow').map((e) => {
      const p = prevById.get(e.id), keep = pending.current.get(e.id);
      const o = layout.offsetOf(e.id);
      return { id: e.id, type: 'card', position: keep ?? { x: e.x + o.dx, y: e.y + o.dy }, width: e.width, height: e.height,
        data: { el: e, color: colorOf(e.id) }, selected: p?.selected ?? false, zIndex: 2, ...(p?.measured ? { measured: p.measured } : {}),
        draggable: editable && editing?.id !== e.id, connectable: editable };
    });
  }, [colorOf, editable, editing, layout]);
  useEffect(() => { setNodes((prev) => build(elements, prev)); }, [elements, build]);

  // AI changes that arrive by polling get a short highlight, so the learner sees what moved.
  useEffect(() => {
    const now = new Map(elements.map((e) => [e.id, sig(e)]));
    if (seen.current) {
      const changed = elements.filter((e) => e.updatedBy === 'ai' && seen.current.get(e.id) !== now.get(e.id)).map((e) => e.id);
      if (changed.length) {
        setFresh(new Set(changed));
        clearTimeout(freshTimer.current);
        freshTimer.current = setTimeout(() => setFresh(new Set()), 4000);
      }
    }
    seen.current = now;
  }, [elements]);
  useEffect(() => () => clearTimeout(freshTimer.current), []);

  // Section frames: the packed layout at rest; while a drag (or its save) is in flight they follow the cards on screen
  // with offsets frozen, and are packed again once the board has the new positions.
  const live = useMemo(() => nodes.map((n) => ({ ...n.data.el, x: n.position.x, y: n.position.y })), [nodes]);
  const moving = nodes.some((n) => pending.current.has(n.id));
  const frames = useMemo(() => (moving ? framesAround(live, topics, assignment) : layout.frames), [moving, live, topics, assignment, layout]);
  const allNodes = useMemo(() => [
    ...frames.map((f) => ({ id: `section:${f.id}`, type: 'section', position: { x: f.x, y: f.y }, width: f.width, height: f.height,
      data: { id: f.id, title: f.title, count: f.count, color: colorAt(f.index) }, draggable: false, selectable: false, connectable: false,
      focusable: false, zIndex: 0, style: { pointerEvents: 'none' } })),
    ...nodes,
  ], [frames, nodes]);

  const posOf = useMemo(() => new Map(live.map((c) => [c.id, c])), [live]);
  const edges = useMemo(() => elements.filter((e) => e.type === 'arrow' && posOf.has(e.from) && posOf.has(e.to)).map((a) => {
    const [sh, th] = edgeSides(posOf.get(a.from), posOf.get(a.to));
    const color = a.relationId ? RELATION_EDGE : a.createdBy === 'ai' ? AI_EDGE : LEARNER_EDGE;
    const sel = edgeSel.has(a.id);
    return { id: a.id, source: a.from, target: a.to, sourceHandle: sh, targetHandle: th, type: 'default', selected: sel,
      label: a.relationId ? `${RELATION_LABEL[a.label] ?? a.label ?? '关系'} · 候选` : a.label || undefined, className: `rf-arrow ${a.createdBy === 'ai' ? 'by-ai' : 'by-me'}${fresh.has(a.id) ? ' fresh' : ''}`,
      data: { arrowId: a.id }, zIndex: 1,
      style: { stroke: sel ? '#3346b8' : color, strokeWidth: sel ? 3 : 2, strokeDasharray: a.relationId ? '6 4' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color: sel ? '#3346b8' : color, width: 18, height: 18 },
      labelStyle: { fontSize: 12, fill: '#4a5670', fontWeight: 600 }, labelBgStyle: { fill: '#fff', fillOpacity: 0.92 }, labelBgPadding: [5, 3], labelBgBorderRadius: 5 };
  }), [elements, posOf, edgeSel, fresh]);

  const selectedIds = useMemo(() => [...nodes.filter((n) => n.selected).map((n) => n.id), ...edgeSel], [nodes, edgeSel]);
  useEffect(() => { onSelectionChange?.(selectedIds); }, [selectedIds.join(','), onSelectionChange]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = useCallback((changes) => {
    // React Flow never deletes on its own (deleteKeyCode=null); keyboard nudges are disabled too.
    const ok = changes.filter((c) => c.type !== 'remove' && !(c.id ?? '').startsWith('section:'));
    for (const c of ok) if (c.type === 'position' && c.position && dragRef.current?.ids.includes(c.id)) pending.current.set(c.id, c.position);
    if (ok.some((c) => c.type === 'select' && c.selected)) setEdgeSel(new Set());
    setNodes((ns) => applyNodeChanges(ok, ns));
  }, []);
  const onEdgesChange = useCallback((changes) => {
    setEdgeSel((s) => {
      const next = new Set(s);
      for (const c of changes) if (c.type === 'select') { if (c.selected) next.add(c.id); else next.delete(c.id); }
      return next;
    });
  }, []);

  const label = (id) => elementsRef.current.find((e) => e.id === id)?.text ?? id;
  /** Offset of the section a point (drawn coordinates) belongs to: a connected note keeps its card's section. */
  const dropOffset = useCallback((p, el) => {
    const L = layoutRef.current;
    if (el && L.assignment.get(el.id) && elementsRef.current.some((a) => a.type === 'arrow' && (a.from === el.id || a.to === el.id))) return L.offsetOf(el.id);
    const hit = L.frames.find((f) => p.x >= f.x && p.x <= f.x + f.width && p.y >= f.y && p.y <= f.y + f.height);
    if (hit) return L.groupOffset(hit.id);
    let best = null, bd = NOTE_NEAR;
    for (const f of L.frames) {
      const d = Math.hypot(Math.max(f.x - p.x, 0, p.x - f.x - f.width), Math.max(f.y - p.y, 0, p.y - f.y - f.height));
      if (d <= bd) { bd = d; best = f; }
    }
    return L.groupOffset(best ? best.id : null);
  }, []);
  const onNodeDragStart = useCallback((_e, _n, dragged) => {
    dragRef.current = { rev: revRef.current, ids: dragged.map((n) => n.id) };
    for (const n of dragged) pending.current.set(n.id, n.position);
  }, []);
  const onNodeDragStop = useCallback(async (_e, _n, dragged) => {
    const d = dragRef.current; dragRef.current = null;
    if (!d) return;
    const byId = new Map(elementsRef.current.map((e) => [e.id, e]));
    const ops = [];
    for (const n of dragged) {
      const e = byId.get(n.id); if (!e) continue;
      // stored = drawn − section offset. Concept cards stay in their syllabus topic; an unconnected note joins the
      // section it is dropped on (or the nearest one within NOTE_NEAR), otherwise it becomes a free note.
      const o = e.type === 'concept' ? layoutRef.current.offsetOf(e.id) : dropOffset({ x: n.position.x + e.width / 2, y: n.position.y + e.height / 2 }, e);
      const x = clampCoord(n.position.x - o.dx), y = clampCoord(n.position.y - o.dy);
      pending.current.set(n.id, { x: n.position.x, y: n.position.y });
      if (x !== e.x || y !== e.y) ops.push({ op: 'update', id: n.id, x, y });
    }
    if (ops.length) await onPatch(ops, ops.length === 1 ? `白板：移动「${label(ops[0].id)}」` : `白板：移动 ${ops.length} 张卡片`, undefined, d.rev);
    for (const n of dragged) pending.current.delete(n.id);
    setNodes((prev) => build(elementsRef.current, prev));
  }, [onPatch, build, dropOffset]);

  const link = useCallback(async (from, to, rev) => {
    if (!from || !to || from === to) return;
    await onPatch([{ op: 'add', type: 'arrow', from, to }], `白板：连线「${label(from)}」→「${label(to)}」`, '已连线', rev);
  }, [onPatch]);

  const startEdit = useCallback((el) => {
    if (!editable) return;
    if (el.type === 'note') setEditing({ id: el.id, draft: el.text, rev: revRef.current });
    else if (el.type === 'concept' && !el.stale) setEditing({ id: el.id, draft: el.text, rev: syllabusRevision, concept: el.conceptId });
  }, [editable, syllabusRevision, setEditing]);
  const commitEdit = useCallback(async (el, value) => {
    const ed = editingRef.current; if (!ed || ed.id !== el.id || ed.saving) return;
    const v = value.trim();
    if (!v || v === el.text) { setEditing(null); return; }
    setEditing({ ...ed, saving: true, draft: v });
    const ok = ed.concept
      ? await onRenameConcept(ed.concept, v, ed.rev)
      : await onPatch([{ op: 'update', id: el.id, text: v }], '白板：编辑便签', '便签已保存', ed.rev, { draft: true });
    // conflict: reopen with the learner's draft against what is now on screen (an explicit retry, never automatic)
    setEditing(ok ? null : { id: el.id, draft: v, rev: undefined, concept: ed.concept });
  }, [onPatch, onRenameConcept, setEditing]);
  const cancelEdit = useCallback(() => setEditing(null), [setEditing]);
  const ctx = useMemo(() => ({ editing, startEdit, commitEdit, cancelEdit, linkFrom, editable, fresh }), [editing, startEdit, commitEdit, cancelEdit, linkFrom, editable, fresh]);

  useEffect(() => { if (!linkMode) setLinkFrom(null); }, [linkMode]);
  const linkRev = useRef(revision);
  const onNodeClick = useCallback((e, node) => {
    const el = node.data?.el; if (!el) return;
    wrapRef.current?.focus({ preventScroll: true });
    if (linkMode && editable) {
      if (!linkFrom) { setLinkFrom(el.id); linkRev.current = revRef.current; return; }
      const from = linkFrom; setLinkFrom(null); onLinkModeDone?.();
      link(from, el.id, linkRev.current);
      return;
    }
    if (el.conceptId) onSelectConcept?.(el.conceptId);
  }, [linkMode, linkFrom, editable, link, onLinkModeDone, onSelectConcept]);

  const deleteSelected = useCallback(() => {
    const ids = [...nodes.filter((n) => n.selected).map((n) => n.id), ...edgeSel];
    if (!ids.length) return;
    // arrows first: an arrow that also cascades away with its card is then not reported as unknown
    const els = elementsRef.current;
    const ordered = ids.sort((a, b) => (els.find((e) => e.id === a)?.type === 'arrow' ? 0 : 1) - (els.find((e) => e.id === b)?.type === 'arrow' ? 0 : 1));
    const name = ids.length === 1 ? (els.find((e) => e.id === ids[0])?.text ?? '连线') : `${ids.length} 个元素`;
    setEdgeSel(new Set());
    return onPatch(ordered.map((id) => ({ op: 'delete', id })), `白板：删除「${name}」`, '已从白板删除', revRef.current);
  }, [nodes, edgeSel, onPatch]);

  // Delete key only (never Backspace), and only while focus is inside this board and not in a text field.
  const onKeyDown = (e) => {
    if (e.key !== 'Delete' || !editable) return;
    if (!wrapRef.current?.contains(e.target) || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    e.preventDefault(); deleteSelected();
  };

  const addNoteAt = useCallback((p, text = '新便签') => {
    const o = dropOffset({ x: p.x + 98, y: p.y + 36 });
    return onPatch([{ op: 'add', type: 'note', text, x: clampCoord(p.x - o.dx), y: clampCoord(p.y - o.dy) }], '白板：添加便签', '已添加便签（双击可编辑）', revRef.current);
  }, [onPatch, dropOffset]);
  const onDoubleClick = (e) => {
    if (!editable || !e.target.classList?.contains('react-flow__pane')) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNoteAt({ x: p.x - 98, y: p.y - 36 });
  };

  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([en]) => setSize({ w: Math.round(en.contentRect.width), h: Math.round(en.contentRect.height) }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const framesRef = useRef(frames); framesRef.current = frames;
  const liveRef = useRef(live); liveRef.current = live;
  const [fitState, setFitState] = useState({ overflow: false, zoom: 1 });
  const fit = useCallback(() => {
    const b = unionBounds([...framesRef.current, ...liveRef.current]);
    const v = fitViewport(b, size.w, size.h, { minZoom: MIN_READABLE_ZOOM });
    rf.setViewport({ x: v.x, y: v.y, zoom: v.zoom });
    setFitState({ overflow: v.overflow, zoom: v.zoom });
    onFit?.({ overflow: v.overflow, zoom: v.zoom });
  }, [rf, size.w, size.h, onFit]);
  const hasCards = live.length > 0;
  useEffect(() => { if (size.w && size.h && hasCards) fit(); }, [size.w, size.h, hasCards]); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(ref, () => ({
    fit, deleteSelected,
    addNote() { const r = wrapRef.current.getBoundingClientRect(); const p = rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); return addNoteAt({ x: p.x - 98, y: p.y - 36 }); },
    zoomBy(f) { const v = rf.getViewport(); rf.setViewport({ ...v, zoom: Math.min(1.8, Math.max(0.3, v.zoom * f)) }, { duration: 120 }); },
  }), [fit, deleteSelected, addNoteAt, rf]);

  return (
    <BoardCtx.Provider value={ctx}>
      <div className={`rf-wrap rf-board${linkMode ? ' linking' : ''}`} ref={wrapRef} style={{ height }} tabIndex={-1} onKeyDown={onKeyDown} onDoubleClick={onDoubleClick} data-testid="board"
        data-scale={fitState.zoom.toFixed(2)} data-overflow={String(fitState.overflow)} data-revision={revision}>
        <ReactFlow nodes={allNodes} edges={edges} nodeTypes={boardNodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onNodeDragStart={onNodeDragStart} onNodeDragStop={onNodeDragStop} onNodeClick={onNodeClick}
          onNodeDoubleClick={(_e, n) => n.data?.el && startEdit(n.data.el)}
          onConnectStart={() => { connectRev.current = revRef.current; }} onConnect={(c) => link(c.source, c.target, connectRev.current)}
          isValidConnection={(c) => c.source !== c.target && !String(c.target).startsWith('section:')}
          connectionMode={ConnectionMode.Loose} deleteKeyCode={null} disableKeyboardA11y zoomOnDoubleClick={false}
          panOnScroll zoomOnScroll={false} zoomOnPinch minZoom={0.3} maxZoom={1.8} nodesConnectable={editable} nodesDraggable={editable}
          elementsSelectable selectNodesOnDrag={false} nodeDragThreshold={3} onlyRenderVisibleElements={false}
          proOptions={{ hideAttribution: false }} defaultViewport={{ x: 0, y: 0, zoom: 1 }}>
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="#d6dceb" />
          {minimap && <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'section' ? `${n.data.color}22` : n.data?.color ?? '#9aa6c4')} nodeStrokeWidth={0} maskColor="rgba(240,243,250,.7)" style={{ width: 168, height: 110 }} />}
        </ReactFlow>
      </div>
    </BoardCtx.Provider>
  );
});

export const BoardFlow = forwardRef(function BoardFlow(props, ref) {
  return <ReactFlowProvider><BoardFlowInner {...props} ref={ref} /></ReactFlowProvider>;
});
