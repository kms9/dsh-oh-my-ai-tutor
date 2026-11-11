import React, { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
// Full ESM build (≈150 KB raw / ≈38 KB gzip before minify). The "lite" build has no node selection, which the editor needs.
import MindElixir from 'mind-elixir';
import { PALETTE, TWO_LEVELS, toMindData, indexHierarchy, gestureToOps } from './mindmap-ops.mjs';

export { toMindData, indexHierarchy, gestureToOps };

export const MM_DIRECTIONS = { side: MindElixir.SIDE, right: MindElixir.RIGHT };
const THEME = {
  name: 'omt', type: 'light', palette: PALETTE,
  cssVar: {
    '--node-gap-x': '28px', '--node-gap-y': '8px', '--main-gap-x': '56px', '--main-gap-y': '14px',
    '--main-color': '#24324f', '--main-bgcolor': '#f3f5ff', '--main-bgcolor-transparent': 'rgba(243,245,255,.85)',
    '--color': '#2a3755', '--bgcolor': '#fbfcff', '--selected': '#4256c4', '--accent-color': '#6273dd',
    '--root-color': '#ffffff', '--root-bgcolor': '#5467c7', '--root-border-color': 'transparent',
    '--root-radius': '24px', '--main-radius': '10px', '--topic-padding': '5px 10px',
    '--panel-color': '#2a3755', '--panel-bgcolor': '#ffffff', '--panel-border-color': '#e3e9f1', '--map-padding': '40px 60px',
  },
};
/**
 * mind-elixir as a pure renderer + gesture collector. The library never owns course data: every structural
 * gesture is vetoed in its `before` hooks and replayed as course.editOutline ops (actor = learner, with the
 * syllabusRevision that was on screen when the gesture began). AI edits arrive through props and are applied
 * with refresh() only when no gesture or submit is in flight, so a drag / rename is never interrupted.
 */
export const MindElixirMap = forwardRef(function MindElixirMap({ hierarchy, syllabusRevision, direction = 'side', submit, notify, onSelect, selectedId, height = 520 }, ref) {
  const elRef = useRef(null);
  const meRef = useRef(null);
  const st = useRef({ shownRev: syllabusRevision, pointer: false, editing: false, submitting: false, pending: null, expanded: new Map(), userZoomed: false, index: indexHierarchy(hierarchy), key: '' });
  const props = useRef({}); props.current = { hierarchy, syllabusRevision, submit, notify, onSelect, direction };

  const find = (id) => { try { return meRef.current?.findEle(id) ?? null; } catch { return null; } }; // findEle throws when absent
  const fit = () => {
    const me = meRef.current; if (!me) return;
    const nodes = me.nodes, box = me.container;
    if (!nodes || !box.offsetWidth) return;
    // fit the real content box (all topics) with a margin, then centre it — never clip a node
    const tpcs = nodes.querySelectorAll('.me-tpc');
    if (!tpcs.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const scale = me.scaleVal || 1;
    const nb = nodes.getBoundingClientRect();
    for (const t of tpcs) { const r = t.getBoundingClientRect(); minX = Math.min(minX, r.left); minY = Math.min(minY, r.top); maxX = Math.max(maxX, r.right); maxY = Math.max(maxY, r.bottom); }
    const w = (maxX - minX) / scale + 48, h = (maxY - minY) / scale + 48;
    const s = Math.max(0.25, Math.min(1.15, box.clientWidth / w, box.clientHeight / h));
    me.scale(s);
    const nb2 = nodes.getBoundingClientRect(), cb = box.getBoundingClientRect();
    const k = s / scale;
    const cx = nb2.left + ((minX + maxX) / 2 - nb.left) * k, cy = nb2.top + ((minY + maxY) / 2 - nb.top) * k;
    me.move(cb.left + cb.width / 2 - cx, cb.top + cb.height / 2 - cy);
    st.current.userZoomed = false;
  };

  const apply = (h, rev) => {
    const me = meRef.current; if (!me) return;
    const s = st.current;
    const key = JSON.stringify(h);
    s.index = indexHierarchy(h);
    if (key !== s.key) {
      const sel = me.currentNodes?.[0]?.nodeObj?.id;
      me.refresh(toMindData(h, s.expanded));
      s.key = key;
      const el = sel && find(sel); if (el) try { me.selectNode(el); } catch { /* node gone */ }
    }
    s.shownRev = rev;
  };
  const flush = () => {
    const s = st.current;
    if (s.pointer || s.editing || s.submitting || !s.pending) return;
    const { h, rev } = s.pending; s.pending = null; apply(h, rev);
  };
  const run = async (name, args) => {
    const s = st.current;
    const res = gestureToOps(s.index, name, args);
    if (res.refuse !== undefined) { if (res.refuse) props.current.notify?.(res.refuse, true); return false; }
    s.submitting = true;
    const lockedRev = s.shownRev; // revision the learner was looking at when the gesture began
    try { return await props.current.submit(res.ops, res.summary, lockedRev); }
    finally { s.submitting = false; flush(); }
  };

  useEffect(() => {
    const me = new MindElixir({
      el: elRef.current, direction: MM_DIRECTIONS[direction] ?? MindElixir.SIDE, editable: true, contextMenu: false, toolBar: false,
      allowUndo: false, overflowHidden: false, alignment: 'root', theme: THEME, newTopicName: '新知识点',
      keypress: { Backspace: () => {} }, // only Delete removes nodes (an accidental Backspace never deletes a topic)
      before: {
        addChild: (el) => { const pid = (el ?? me.currentNode)?.nodeObj?.id; if (pid) run('addChild', { parentId: pid }); return false; },
        insertSibling: (type, el) => { const id = (el ?? me.currentNode)?.nodeObj?.id; if (id) run('insertSibling', { id, position: type }); return false; },
        insertParent: () => { props.current.notify?.(TWO_LEVELS, true); return false; },
        copyNodes: () => false, reshapeNode: () => false, setNodeTopic: () => false, rmSubline: () => false,
        removeNodes: (tpcs) => { run('remove', { ids: (tpcs ?? []).map((t) => t.nodeObj.id) }); return false; },
        moveUpNode: (el) => { const id = (el ?? me.currentNode)?.nodeObj?.id; if (id) run('step', { id, dir: -1 }); return false; },
        moveDownNode: (el) => { const id = (el ?? me.currentNode)?.nodeObj?.id; if (id) run('step', { id, dir: 1 }); return false; },
        moveNodesBefore: (from, to) => { run('move', { where: 'before', ids: from.map((t) => t.nodeObj.id), target: to.nodeObj.id }); return false; },
        moveNodesAfter: (from, to) => { run('move', { where: 'after', ids: from.map((t) => t.nodeObj.id), target: to.nodeObj.id }); return false; },
        moveNodesIn: (from, to) => { run('move', { where: 'in', ids: from.map((t) => t.nodeObj.id), target: to.nodeObj.id }); return false; },
        beginEdit: (el) => { const n = (el ?? me.currentNode)?.nodeObj; if (n && st.current.index.get(n.id)?.kind === 'root') { props.current.notify?.('课程标题不在思维导图里修改。', true); return false; } return true; },
      },
    });
    meRef.current = me;
    const s = st.current;
    me.init(toMindData(hierarchy));
    s.key = JSON.stringify(hierarchy); s.shownRev = syllabusRevision;
    me.bus.addListener('operation', async (op) => {
      if (op.name === 'beginEdit') {
        s.editing = true;
        s.editLockRev = s.shownRev;
        const box = me.container.querySelector('#input-box');
        box?.addEventListener('blur', () => setTimeout(() => { s.editing = false; flush(); }, 0), { once: true });
      } else if (op.name === 'finishEdit') {
        const id = op.target.id, title = String(op.target.topic ?? '').trim();
        s.editing = false;
        const lock = s.editLockRev ?? s.shownRev;
        const res = gestureToOps(s.index, 'rename', { id, title });
        if (res.refuse !== undefined || !title || title.length > 160) { if (res.refuse) props.current.notify?.(res.refuse, true); s.key = ''; apply(props.current.hierarchy, props.current.syllabusRevision); return; }
        s.submitting = true;
        let ok = false;
        try { ok = await props.current.submit(res.ops, res.summary, lock, { draft: true }); }
        finally { s.submitting = false; }
        if (!ok) {
          // keep the learner's draft: show the latest outline, then reopen the editor on that node with the draft text
          s.key = ''; s.pending = null; apply(props.current.hierarchy, props.current.syllabusRevision);
          const el = find(id);
          if (el) { me.selectNode(el); me.beginEdit(el); requestAnimationFrame(() => { const box = me.container.querySelector('#input-box'); if (box) box.textContent = title; }); }
        } else flush();
      } else if (op.name === 'expandNode' || op.name === 'collapseNode') {
        s.expanded.set(op.target.id, op.target.expanded !== false);
      }
    });
    me.bus.addListener('selectNodes', (nodes) => { const n = nodes?.[0]; if (n) props.current.onSelect?.({ id: n.id, ...(s.index.get(n.id) ?? {}) }); });
    me.bus.addListener('unselectNodes', () => { if (!me.currentNodes?.length) props.current.onSelect?.(null); });
    me.bus.addListener('scale', () => { s.userZoomed = true; });
    const down = () => { s.pointer = true; };
    const up = () => { if (!s.pointer) return; s.pointer = false; setTimeout(flush, 0); };
    me.container.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    requestAnimationFrame(fit);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { if (!s.userZoomed) fit(); }) : null;
    ro?.observe(elRef.current);
    return () => {
      ro?.disconnect();
      window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      me.destroy?.(); meRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI / other-window edits: apply now, or right after the current gesture / submit.
  useEffect(() => {
    const s = st.current;
    s.pending = { h: hierarchy, rev: syllabusRevision };
    flush();
  }, [hierarchy, syllabusRevision]);

  useEffect(() => {
    const me = meRef.current; if (!me) return;
    const d = MM_DIRECTIONS[direction] ?? MindElixir.SIDE;
    if (me.direction !== d) { me.direction = d; me.refresh(); requestAnimationFrame(fit); }
  }, [direction]);

  useEffect(() => {
    const me = meRef.current; if (!me || !selectedId) return;
    if (me.currentNodes?.[0]?.nodeObj?.id === selectedId) return;
    const el = find(selectedId);
    if (el) try { me.selectNode(el); } catch { /* ignore */ }
  }, [selectedId]);

  useImperativeHandle(ref, () => ({
    fit,
    beginRename: (id) => { const me = meRef.current; const el = find(id); if (el) { me.selectNode(el); me.beginEdit(el); } },
    toggle: (id) => { const me = meRef.current; const el = find(id); if (el) me.expandNode(el); },
    run,
  }));

  return <div className="mm-elixir" ref={elRef} style={{ height }} data-testid="mindmap-elixir" data-direction={direction} data-revision={syllabusRevision} />;
});
