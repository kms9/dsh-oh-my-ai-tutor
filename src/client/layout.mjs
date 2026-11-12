/** Pure layout + formatting helpers for the workbench (no DOM; unit-testable in Node). */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;
export function textWidth(text, fontSize = 12) {
  let w = 0;
  for (const ch of String(text ?? '')) w += CJK.test(ch) ? fontSize : ch === ' ' ? fontSize * 0.3 : fontSize * 0.58;
  return w;
}
/** Greedy wrap by measured width; last line gets an ellipsis when truncated. */
export function wrapLabel(text, maxWidth, fontSize = 12, maxLines = 2) {
  const chars = [...String(text ?? '')];
  const lines = [];
  let line = '';
  for (let i = 0; i < chars.length; i++) {
    const next = line + chars[i];
    if (textWidth(next, fontSize) > maxWidth && line) {
      lines.push(line); line = chars[i];
      if (lines.length === maxLines) {
        let last = lines[maxLines - 1];
        while (last && textWidth(last + '…', fontSize) > maxWidth) last = last.slice(0, -1);
        lines[maxLines - 1] = last + '…';
        return lines;
      }
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Horizontal tidy tree: root → topics → subtopics. Collapsed topics occupy one row. */
export function mindmapLayout(hierarchy, collapsed = new Set(), opts = {}) {
  const fs = opts.fontSize ?? 12, rowH = opts.rowHeight ?? 34, padX = 14, nodeH = 26;
  const measure = (t, bold, max) => Math.min(max, Math.max(56, textWidth(t, fs) + padX * 2 + (bold ? 6 : 0)));
  const topics = hierarchy?.children ?? [];
  const rootW = Math.min(220, textWidth(hierarchy?.title ?? '', 13) + 40);
  const topicW = Math.max(80, ...topics.map((t) => measure(t.title, true, 210)));
  const x0 = 12, x1 = x0 + rootW + 56, x2 = x1 + topicW + 48;
  const nodes = [], links = [];
  let row = 0;
  const topicNodes = topics.map((t, ti) => {
    const kids = collapsed.has(t.id) ? [] : t.children;
    const childNodes = kids.map((s, si) => {
      const n = { id: s.id, kind: 'sub', title: s.title, conceptId: s.conceptId, parentId: t.id, index: si,
        x: x2, y: 16 + (row++) * rowH, w: measure(s.title, false, 240), h: nodeH };
      return n;
    });
    if (!kids.length) row++;
    const y = childNodes.length ? (childNodes[0].y + childNodes.at(-1).y) / 2 : 16 + (row - 1) * rowH;
    const tn = { id: t.id, kind: 'topic', title: t.title, parentId: hierarchy.id, index: ti, count: t.children.length,
      collapsed: collapsed.has(t.id), x: x1, y, w: measure(t.title, true, 210), h: nodeH + 4 };
    nodes.push(tn, ...childNodes);
    for (const c of childNodes) links.push({ from: tn, to: c });
    return tn;
  });
  const ry = topicNodes.length ? (topicNodes[0].y + topicNodes.at(-1).y) / 2 : 16;
  if (opts.availableWidth && opts.availableWidth > 0 && opts.mode !== 'horizontal') {
    const horizontalWidth = Math.max(...nodes.map((n) => n.x + n.w), x0 + rootW) + 16;
    if (opts.mode === 'indent' || horizontalWidth > opts.availableWidth) return indentLayout(hierarchy, collapsed, opts.availableWidth, fs, measure);
  }
  const root = { id: hierarchy?.id ?? 'root', kind: 'root', title: hierarchy?.title ?? '', x: x0, y: ry - 4, w: rootW, h: nodeH + 12 };
  nodes.unshift(root);
  for (const t of topicNodes) links.unshift({ from: root, to: t });
  const width = Math.max(...nodes.map((n) => n.x + n.w)) + 16;
  const height = Math.max(...nodes.map((n) => n.y + n.h)) + 16;
  return { nodes, links, width, height, mode: 'horizontal' };
}

/** Narrow-column mind map: root on top, topics and knowledge points as an indented tree with elbow connectors. */
function indentLayout(hierarchy, collapsed, avail, fs, measure) {
  const rowH = 36, nodeH = 26, nodes = [], links = [];
  let row = 0;
  const root = { id: hierarchy?.id ?? 'root', kind: 'root', title: hierarchy?.title ?? '', x: 8, y: 8, w: Math.min(avail - 16, textWidth(hierarchy?.title ?? '', 13) + 40), h: nodeH + 6 };
  nodes.push(root); row = 1;
  (hierarchy?.children ?? []).forEach((t, ti) => {
    const tn = { id: t.id, kind: 'topic', title: t.title, parentId: root.id, index: ti, count: t.children.length, collapsed: collapsed.has(t.id),
      x: 34, y: 8 + row * rowH + 4, w: Math.min(avail - 60, measure(t.title, true, 420)), h: nodeH + 2 };
    row++; nodes.push(tn); links.push({ from: root, to: tn });
    if (!collapsed.has(t.id)) t.children.forEach((sub, si) => {
      const n = { id: sub.id, kind: 'sub', title: sub.title, conceptId: sub.conceptId, parentId: t.id, index: si,
        x: 66, y: 8 + row * rowH + 4, w: Math.min(avail - 76, measure(sub.title, false, 420)), h: nodeH };
      row++; nodes.push(n); links.push({ from: tn, to: n });
    });
  });
  const width = Math.max(avail - 2, ...nodes.map((n) => n.x + n.w + 26));
  return { nodes, links, width, height: 8 + row * rowH + 12, mode: 'indent' };
}

/** Grid layout in syllabus order for the semantic graph; columns adapt to node count. */
export function graphLayout(nodes, opts = {}) {
  const n = nodes.length;
  const cols = opts.cols ?? (n <= 4 ? 2 : n <= 30 ? 3 : 4);
  const w = opts.nodeWidth ?? 136, h = opts.nodeHeight ?? 46, gapX = opts.gapX ?? 20, gapY = opts.gapY ?? 34;
  const ox = 12, oy = 18;
  const pos = new Map(nodes.map((node, i) => [node.id, { x: ox + (i % cols) * (w + gapX), y: oy + Math.floor(i / cols) * (h + gapY), w, h }]));
  return { pos, cols, width: ox * 2 + cols * w + (cols - 1) * gapX, height: oy * 2 + Math.ceil(n / cols) * (h + gapY) - gapY };
}

/** Point where the segment from rect centre a to rect centre b leaves rect a. */
export function rectExit(a, b) {
  const cx = a.x + a.w / 2, cy = a.y + a.h / 2, tx = b.x + b.w / 2, ty = b.y + b.h / 2;
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const sx = dx ? (a.w / 2) / Math.abs(dx) : Infinity, sy = dy ? (a.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function boardBounds(elements) {
  const cards = elements.filter((e) => e.type !== 'arrow');
  if (!cards.length) return { x: 0, y: 0, width: 400, height: 300 };
  const minX = Math.min(...cards.map((e) => e.x)), minY = Math.min(...cards.map((e) => e.y));
  const maxX = Math.max(...cards.map((e) => e.x + e.width)), maxY = Math.max(...cards.map((e) => e.y + e.height));
  return { x: Math.min(0, minX), y: Math.min(0, minY), width: Math.max(400, maxX + 24), height: Math.max(300, maxY + 24) };
}

/** Only plain hex colours reach inline CSS (defence in depth; the core rejects anything else). */
export const safeColor = (c) => (typeof c === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c) ? c : undefined);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}
/** Small, escaping Markdown renderer for lesson bodies (headings, lists, quotes, tables, code, rules). */
export function markdownToHtml(md) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`); continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { const level = Math.min(6, Math.max(4, h[1].length + 2)); out.push(`<h${level}>${inline(h[2])}</h${level}>`); i++; continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push('<hr/>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<div class="quote">${buf.map(inline).join('<br/>')}</div>`); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      if (!body.length) continue; // separator-only table: render nothing instead of crashing the lesson pane
      const [head, ...rest] = body;
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const buf = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) buf.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${buf.map((b) => `<li>${inline(b)}</li>`).join('')}</${tag}>`); continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*\|.*\|\s*$|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${buf.map(inline).join('<br/>')}</p>`);
  }
  return out.join('\n');
}

export const MASTERY_LABEL = { unverified: '未验证', developing: '发展中', demonstrated: '已展示' };
export const ACTION_LABEL = {
  'goal.create': '创建学习目标', 'source.register': '登记资料', 'course.create': '创建课程', 'course.linkSource': '关联资料',
  'course.plan': '写入大纲', 'course.editOutline': '编辑大纲', 'course.approve': '批准大纲', 'lesson.create': '创建课时计划',
  'lesson.approve': '批准课时计划', 'lesson.partWrite': '写入讲解', 'lesson.cover': '完成一段讲解', 'assessment.record': '记录作答',
  'lesson.reviewEnd': '结束复习', 'note.add': '添加笔记', 'lesson.finish': '结课', 'relation.propose': '提出候选关系',
  'board.seed': '生成白板', 'board.patch': '编辑白板', 'todo.create': '添加待办', 'todo.update': '更新待办',
};
export function relTime(iso, now = Date.now()) {
  const d = Math.max(0, now - Date.parse(iso));
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

/**
 * Route an edge between two rects. Straight when nothing is in the way; otherwise a quadratic curve
 * bent to whichever side clears the other nodes (so arrows never run through an unrelated card).
 */
export function edgeRoute(a, b, obstacles = [], pad = 4) {
  const others = obstacles.filter((o) => o !== a && o !== b && !(o.x === a.x && o.y === a.y) && !(o.x === b.x && o.y === b.y));
  const blocked = (pt) => others.some((o) => pt.x > o.x - pad && pt.x < o.x + o.w + pad && pt.y > o.y - pad && pt.y < o.y + o.h + pad);
  const quad = (p1, c, p2, t) => ({ x: (1 - t) ** 2 * p1.x + 2 * (1 - t) * t * c.x + t * t * p2.x, y: (1 - t) ** 2 * p1.y + 2 * (1 - t) * t * c.y + t * t * p2.y });
  const s1 = rectExit(a, b), s2 = rectExit(b, a);
  const clear = (p1, c, p2) => { for (let i = 1; i < 24; i++) if (blocked(quad(p1, c, p2, i / 24))) return false; return true; };
  const mid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
  if (clear(s1, mid, s2)) return { d: `M${s1.x},${s1.y} L${s2.x},${s2.y}`, lx: mid.x, ly: mid.y, curved: false };
  const len = Math.hypot(s2.x - s1.x, s2.y - s1.y) || 1;
  const nx = -(s2.y - s1.y) / len, ny = (s2.x - s1.x) / len;
  let best = null;
  for (const k of [0.25, 0.4, 0.6, 0.85]) for (const side of [1, -1]) {
    const off = Math.max(36, len * k) * side;
    const c = { x: mid.x + nx * off * 2, y: mid.y + ny * off * 2 }; // control point (curve apex sits at half the offset)
    const cr = { x: c.x, y: c.y, w: 0, h: 0 };
    const p1 = rectExit(a, cr), p2 = rectExit(b, cr);
    best = { p1, c, p2 };
    if (clear(p1, c, p2)) { const m = quad(p1, c, p2, 0.5); return { d: `M${p1.x},${p1.y} Q${c.x},${c.y} ${p2.x},${p2.y}`, lx: m.x, ly: m.y, curved: true }; }
  }
  const m = quad(best.p1, best.c, best.p2, 0.5);
  return { d: `M${best.p1.x},${best.p1.y} Q${best.c.x},${best.c.y} ${best.p2.x},${best.p2.y}`, lx: m.x, ly: m.y, curved: true };
}
