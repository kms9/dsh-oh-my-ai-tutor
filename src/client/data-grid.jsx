import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DataEditor, GridCellKind } from '@glideapps/glide-data-grid';

/**
 * Read-only table over rows from the SQLite data queries (Glide Data Grid 6, MIT, canvas-rendered).
 * Columns: { id, title, width, kind?: 'text'|'number'|'link'|'muted', value(row) → string|number|null, sortValue?(row),
 *            link?(row) → { label, action } | null }  — a link cell calls onAction(action, row).
 * Header click sorts (asc → desc → off). The wrapper exposes column geometry as data attributes for tests.
 */
const LINK = '#2f5bd3';
const HEADER_H = 34;
const ROW_H = 32;
export function DataGrid({ columns, rows, rowKey, onAction, height = 320, highlightKey = null, testId = 'data-grid' }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(600);
  const [sort, setSort] = useState(null); // { id, dir }
  const [hover, setHover] = useState(null);
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
      if (l) return { kind: GridCellKind.Text, data: l.label, displayData: l.label, allowOverlay: false, cursor: 'pointer',
        themeOverride: { textDark: LINK, baseFontStyle: hover && hover[0] === col && hover[1] === row ? '600 13px' : '13px' } };
      const empty = c.empty?.(r) ?? '—';
      return { kind: GridCellKind.Text, data: empty, displayData: empty, allowOverlay: false, themeOverride: { textDark: '#9aa3b5' } };
    }
    const v = c.value(r);
    if (typeof v === 'number') return { kind: GridCellKind.Number, data: v, displayData: c.format ? c.format(v, r) : String(v), allowOverlay: false, contentAlign: 'right' };
    const text = v == null || v === '' ? '—' : String(v);
    return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false,
      ...(c.kind === 'muted' || text === '—' ? { themeOverride: { textDark: '#8a93a6' } } : {}) };
  }, [columns, sorted, hover]);
  const onCellClicked = useCallback(([col, row]) => {
    const c = columns[col], r = sorted[row];
    const l = c?.link?.(r);
    if (l) onAction?.(l.action, r);
  }, [columns, sorted, onAction]);
  const getRowThemeOverride = useCallback((row) => (highlightKey && sorted[row] && rowKey(sorted[row]) === highlightKey ? { bgCell: '#fff6dd' } : undefined), [sorted, highlightKey, rowKey]);
  const h = Math.min(height, HEADER_H + ROW_H * Math.max(sorted.length, 1) + 2);
  const geometry = useMemo(() => JSON.stringify(columns.map((c) => ({ id: c.id, w: c.width ?? 110 }))), [columns]);
  return (
    <div ref={wrapRef} className="dgwrap" data-testid={testId} data-rows={sorted.length} data-header-h={HEADER_H} data-row-h={ROW_H}
      data-cols={geometry} data-row-keys={JSON.stringify(sorted.map(rowKey))} data-sort={sort ? `${sort.id}:${sort.dir}` : ''}>
      {sorted.length ? (
        <DataEditor columns={gridColumns} rows={sorted.length} getCellContent={getCellContent} width={width} height={h}
          headerHeight={HEADER_H} rowHeight={ROW_H} rowMarkers="none" freezeColumns={1} smoothScrollX smoothScrollY
          getCellsForSelection onCellClicked={onCellClicked} getRowThemeOverride={getRowThemeOverride}
          onItemHovered={(e) => setHover(e.kind === 'cell' ? e.location : null)}
          onHeaderClicked={(col) => { const id = columns[col].id; setSort((s) => (s?.id !== id ? { id, dir: 'asc' } : s.dir === 'asc' ? { id, dir: 'desc' } : null)); }}
          theme={{ accentColor: '#2f5bd3', accentLight: 'rgba(47,91,211,.10)', textDark: '#1d2433', textMedium: '#5b6476', textHeader: '#4a5366',
            bgHeader: '#f4f6fb', bgHeaderHovered: '#e9edf7', borderColor: 'rgba(30,40,70,.10)', fontFamily: 'inherit', baseFontStyle: '13px', headerFontStyle: '600 12px' }} />
      ) : <div className="empty" style={{ padding: 18 }}>没有符合条件的行。</div>}
    </div>
  );
}
