import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataEditor, GridCellKind } from '@glideapps/glide-data-grid';

/**
 * Read-only table over rows from the SQLite data queries (Glide Data Grid 6, MIT, canvas-rendered).
 * Columns: { id, title, width, kind?: 'text'|'number'|'link'|'muted', value(row) → string|number|null, sortValue?(row),
 *            link?(row) → { label, action } | null }  — a link cell calls onAction(action, row).
 * Header click sorts (asc → desc → off). The wrapper exposes column geometry as data attributes for tests.
 *
 * Copying text (the canvas has no DOM text to drag-select):
 *  - double-click (or Enter on) a plain cell opens Glide's read-only overlay: a real text box where part of the text
 *    can be selected and copied with the mouse / Ctrl+C;
 *  - Ctrl/⌘+C copies the selected cell or range (Glide's built-in copy, tab-separated);
 *  - right-click copies the whole cell at once and says 已复制.
 * Glide renders its overlay into a #portal element; the host page may not have one, so it is created on demand.
 */
const LINK = '#2f5bd3';
const HEADER_H = 34;
const ROW_H = 32;
export const COPY_HINT = '双击单元格可拖选其中文字复制；选中单元格（可拖选多格）按 Ctrl/⌘+C 复制整格；右键单元格直接复制。';
function ensurePortal() {
  if (typeof document === 'undefined' || document.getElementById('portal')) return;
  const el = document.createElement('div');
  el.id = 'portal';
  el.style.cssText = 'position:fixed;left:0;top:0;z-index:9999';
  document.body.appendChild(el);
}
/** Clipboard write that also works where navigator.clipboard is unavailable (non-secure origin). */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove(); return ok;
}
/**
 * Read-only overlay for double-click / Enter: Glide's own text editor shows read-only cells *disabled* (no text
 * selection), so we provide a read-only textarea instead — the whole text pre-selected, part of it selectable.
 */
function CopyEditor({ value, onFinishedEditing }) {
  const text = value.copyData ?? String(value.displayData ?? value.data ?? '');
  const [done, setDone] = useState(false);
  return (
    <div className="dgcopy" data-testid="grid-copy-editor" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', minWidth: 220, maxWidth: 420, font: '13px/1.5 system-ui, sans-serif', color: '#1d2433' }}>
      <textarea readOnly value={text} autoFocus rows={Math.min(6, Math.max(1, Math.ceil(text.length / 26)))}
        onFocus={(e) => e.currentTarget.select()} onKeyDown={(e) => { if (e.key === 'Escape') onFinishedEditing(undefined, [0, 0]); }}
        style={{ resize: 'none', border: '1px solid #c9d2f3', borderRadius: 6, padding: '4px 6px', font: 'inherit', color: 'inherit', background: '#fff', userSelect: 'text', outline: 'none' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: '#5b6476' }}>
        <span style={{ flex: 1 }}>可拖选部分文字，Ctrl/⌘+C 复制；Esc 关闭</span>
        <button type="button" data-testid="grid-copy-all" style={{ font: 'inherit', fontSize: 11.5, border: '1px solid #c9d2f3', background: '#f2f5fd', color: '#2f5bd3', borderRadius: 5, padding: '1px 8px', cursor: 'pointer' }}
          onClick={async () => setDone(await copyText(text))}>{done ? '已复制' : '复制全部'}</button>
      </div>
    </div>
  );
}
const provideEditor = (cell) => ((cell.kind === GridCellKind.Text || cell.kind === GridCellKind.Number) && cell.readonly
  ? { editor: CopyEditor, disablePadding: true, disableStyling: false } : undefined);
const strip = (label) => String(label).replace(/\s*›$/, '');
export function DataGrid({ columns, rows, rowKey, onAction, height = 320, highlightKey = null, testId = 'data-grid' }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(600);
  const [sort, setSort] = useState(null); // { id, dir }
  const [hover, setHover] = useState(null);
  const [copied, setCopied] = useState(null); // { text, at }
  useEffect(() => { ensurePortal(); }, []);
  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id); if (!col) return rows;
    const key = col.sortValue ?? col.value;
    const out = rows.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN')) * (sort.dir === 'asc' ? 1 : -1);
    });
    return out;
  }, [rows, columns, sort]);
  const gridColumns = useMemo(() => columns.map((c) => ({ id: c.id, width: c.width ?? 110,
    title: sort?.id === c.id ? `${c.title} ${sort.dir === 'asc' ? '↑' : '↓'}` : c.title })), [columns, sort]);
  const getCellContent = useCallback(([col, row]) => {
    const c = columns[col], r = sorted[row];
    if (!c || !r) return { kind: GridCellKind.Text, data: '', displayData: '', allowOverlay: false };
    if (c.link) {
      const l = c.link(r);
      if (l) return { kind: GridCellKind.Text, data: l.label, displayData: l.label, copyData: strip(l.label), allowOverlay: false, cursor: 'pointer',
        themeOverride: { textDark: LINK, baseFontStyle: hover && hover[0] === col && hover[1] === row ? '600 13px' : '13px' } };
      const empty = c.empty?.(r) ?? '—';
      return { kind: GridCellKind.Text, data: empty, displayData: empty, copyData: empty === '—' ? '' : empty, allowOverlay: false, themeOverride: { textDark: '#9aa3b5' } };
    }
    const v = c.value(r);
    if (typeof v === 'number') return { kind: GridCellKind.Number, data: v, displayData: c.format ? c.format(v, r) : String(v), allowOverlay: true, readonly: true, contentAlign: 'right' };
    const text = v == null || v === '' ? '—' : String(v);
    return { kind: GridCellKind.Text, data: text, displayData: text, copyData: text === '—' ? '' : text, allowOverlay: true, readonly: true,
      ...(c.kind === 'muted' || text === '—' ? { themeOverride: { textDark: '#8a93a6' } } : {}) };
  }, [columns, sorted, hover]);
  const onCellClicked = useCallback(([col, row]) => {
    const c = columns[col], r = sorted[row];
    const l = c?.link?.(r);
    if (l) onAction?.(l.action, r);
  }, [columns, sorted, onAction]);
  /** Right-click: copy the whole cell (the text a learner sees, without the link arrow). */
  const onCellContextMenu = useCallback(async ([col, row], e) => {
    e.preventDefault?.();
    const cell = getCellContent([col, row]);
    const text = cell.copyData ?? String(cell.displayData ?? cell.data ?? '');
    const ok = await copyText(text);
    setCopied({ text: ok ? text : null, at: Date.now() });
  }, [getCellContent]);
  useEffect(() => { if (!copied) return undefined; const t = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(t); }, [copied]);
  const getRowThemeOverride = useCallback((row) => (highlightKey && sorted[row] && rowKey(sorted[row]) === highlightKey ? { bgCell: '#fff6dd' } : undefined), [sorted, highlightKey, rowKey]);
  const h = Math.min(height, HEADER_H + ROW_H * Math.max(sorted.length, 1) + 2);
  const geometry = useMemo(() => JSON.stringify(columns.map((c) => ({ id: c.id, w: c.width ?? 110 }))), [columns]);
  return (
    <div ref={wrapRef} className="dgwrap" data-testid={testId} data-rows={sorted.length} data-header-h={HEADER_H} data-row-h={ROW_H}
      data-cols={geometry} data-row-keys={JSON.stringify(sorted.map(rowKey))} data-sort={sort ? `${sort.id}:${sort.dir}` : ''}>
      {sorted.length ? (
        <DataEditor columns={gridColumns} rows={sorted.length} getCellContent={getCellContent} width={width} height={h}
          headerHeight={HEADER_H} rowHeight={ROW_H} rowMarkers="none" freezeColumns={1} smoothScrollX smoothScrollY
          getCellsForSelection onCellClicked={onCellClicked} onCellContextMenu={onCellContextMenu} provideEditor={provideEditor} getRowThemeOverride={getRowThemeOverride}
          onItemHovered={(e) => setHover(e.kind === 'cell' ? e.location : null)}
          onHeaderClicked={(col) => { const id = columns[col].id; setSort((s) => (s?.id !== id ? { id, dir: 'asc' } : s.dir === 'asc' ? { id, dir: 'desc' } : null)); }}
          theme={{ accentColor: '#2f5bd3', accentLight: 'rgba(47,91,211,.10)', textDark: '#1d2433', textMedium: '#5b6476', textHeader: '#4a5366',
            bgHeader: '#f4f6fb', bgHeaderHovered: '#e9edf7', borderColor: 'rgba(30,40,70,.10)', fontFamily: 'inherit', baseFontStyle: '13px', headerFontStyle: '600 12px' }} />
      ) : <div className="empty" style={{ padding: 18 }}>没有符合条件的行。</div>}
      {sorted.length > 0 && (
        <div className="dghint small muted" data-testid={`${testId}-hint`}>
          {copied ? <span className="dgcopied" data-testid="grid-copied">{copied.text == null ? '复制失败，请双击单元格后手动选中文字复制' : `已复制：${copied.text.length > 24 ? `${copied.text.slice(0, 24)}…` : copied.text || '（空）'}`}</span> : COPY_HINT}
        </div>
      )}
    </div>
  );
}
