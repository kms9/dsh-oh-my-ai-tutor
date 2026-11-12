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

/** Horizontal tidy tree of arbitrary depth. Collapsed nodes occupy one row and hide their descendants. */
export function mindmapLayout(hierarchy, collapsed = new Set(), opts = {}) {
  const fs = opts.fontSize ?? 12, rowH = opts.rowHeight ?? 34, padX = 14, nodeH = 26;
  const measure = (t, bold, max) => Math.min(max, Math.max(56, textWidth(t, fs) + padX * 2 + (bold ? 6 : 0)));
  const kindOf = (node, depth) => node?.kind ?? (depth === 0 ? 'root' : depth === 1 ? 'topic' : (node?.conceptId || node?.refersTo ? 'sub' : 'node'));
  const widthOf = (node, depth) => {
    if (depth === 0) return Math.min(220, textWidth(node?.title ?? '', 13) + 40);
    return measure(node?.title ?? '', depth === 1, depth <= 1 ? 210 : 240);
  };
  const heightOf = (depth) => (depth === 0 ? nodeH + 12 : depth === 1 ? nodeH + 4 : nodeH);
  const gapAfter = (depth) => (depth === 0 ? 56 : 48);

  const colW = [];
  const walkMeasure = (node, depth) => {
    colW[depth] = Math.max(colW[depth] ?? (depth === 1 ? 80 : 56), widthOf(node, depth));
    if (!collapsed.has(node?.id)) for (const c of node?.children ?? []) walkMeasure(c, depth + 1);
  };
  walkMeasure(hierarchy ?? { id: 'root', title: '', children: [] }, 0);
  const xOf = [12];
  for (let d = 0; d < colW.length; d++) xOf[d + 1] = xOf[d] + (colW[d] ?? 56) + gapAfter(d);

  const nodes = [], links = [];
  let row = 0;
  const layoutNode = (node, depth, parent, index, branch) => {
    const kids = collapsed.has(node.id) ? [] : (node.children ?? []);
    const kind = kindOf(node, depth);
    const w = widthOf(node, depth), h = heightOf(depth);
    const childLayouts = [];
    const startRow = row;
    kids.forEach((c, i) => childLayouts.push(layoutNode(c, depth + 1, node.id, i, depth === 0 ? i : branch)));
    if (!childLayouts.length) row++;
    const y = childLayouts.length
      ? (childLayouts[0].y + childLayouts.at(-1).y) / 2
      : 16 + (Math.max(startRow, row - 1)) * rowH;
    const n = {
      id: node.id, kind, title: node.title ?? '', conceptId: node.conceptId ?? node.refersTo ?? null,
      parentId: parent, index, count: (node.children ?? []).length, collapsed: collapsed.has(node.id),
      depth, branch: branch ?? 0, x: xOf[depth], y: depth === 0 ? y - 4 : y, w, h,
    };
    nodes.push(n);
    for (const c of childLayouts) links.push({ from: n, to: c });
    return n;
  };
  const root = layoutNode(hierarchy ?? { id: 'root', title: '', children: [] }, 0, null, 0, 0);
  if (!nodes.length) nodes.push(root);
  const width = Math.max(...nodes.map((n) => n.x + n.w), xOf[0] + (colW[0] ?? 56)) + 16;
  const height = Math.max(...nodes.map((n) => n.y + n.h)) + 16;
  if (opts.availableWidth && opts.availableWidth > 0 && opts.mode !== 'horizontal') {
    if (opts.mode === 'indent' || width > opts.availableWidth) return indentLayout(hierarchy, collapsed, opts.availableWidth, fs, measure);
  }
  return { nodes, links, width, height, mode: 'horizontal' };
}

/** Narrow-column mind map: root on top, then an indented tree of arbitrary depth with elbow connectors. */
function indentLayout(hierarchy, collapsed, avail, fs, measure) {
  const rowH = 36, nodeH = 26, nodes = [], links = [];
  let row = 0;
  const kindOf = (node, depth) => node?.kind ?? (depth === 0 ? 'root' : depth === 1 ? 'topic' : (node?.conceptId || node?.refersTo ? 'sub' : 'node'));
  const walk = (node, depth, parent, index, branch) => {
    const kind = kindOf(node, depth);
    const x = depth === 0 ? 8 : 8 + 26 + (depth - 1) * 32;
    const wMax = Math.max(72, (avail ?? 360) - x - 16);
    const w = depth === 0
      ? Math.min(wMax, textWidth(node?.title ?? '', 13) + 40)
      : Math.min(wMax, measure(node?.title ?? '', depth === 1, 420));
    const n = {
      id: node?.id ?? 'root', kind, title: node?.title ?? '', conceptId: node?.conceptId ?? node?.refersTo ?? null,
      parentId: parent, index, count: (node?.children ?? []).length, collapsed: collapsed.has(node?.id),
      depth, branch: branch ?? 0,
      x, y: depth === 0 ? 8 : 8 + row * rowH + 4,
      w, h: depth === 0 ? nodeH + 6 : depth === 1 ? nodeH + 2 : nodeH,
    };
    nodes.push(n);
    if (parent) {
      const from = nodes.find((x) => x.id === parent);
      if (from) links.push({ from, to: n });
    }
    row++;
    if (!collapsed.has(node?.id)) (node?.children ?? []).forEach((c, i) => walk(c, depth + 1, n.id, i, depth === 0 ? i : branch));
    return n;
  };
  walk(hierarchy ?? { id: 'root', title: '', children: [] }, 0, null, 0, 0);
  const width = Math.max((avail ?? 0) - 2, ...nodes.map((n) => n.x + n.w + 26));
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
  'lesson.updatePlan': '修改课时计划', 'lesson.link': '关联课时知识点', 'lesson.approve': '批准课时计划',
  'lesson.partWrite': '写入讲解', 'lesson.cover': '完成一段讲解', 'lesson.ask': '出题', 'lesson.hint': '给出提示',
  'lesson.dropQuestion': '收回题目', 'lesson.checkpoint': '记下要点', 'assessment.record': '记录作答',
  'lesson.reviewEnd': '结束复习', 'note.add': '添加笔记', 'note.link': '关联笔记知识点', 'lesson.finish': '结课',
  'lesson.feedback': '课末反馈', 'lesson.adjustDone': '完成大纲调整', 'course.setApproval': '设置批准方式',
  'relation.propose': '提出候选关系',
  'mindmap.ensure': '生成思维导图', 'mindmap.edit': '编辑思维导图',
  'graphNode.add': '添加图谱节点', 'graphNode.rename': '重命名图谱节点', 'graphNode.remove': '删除图谱节点',
  'concept.create': '新增知识点', 'concept.promote': '升格为知识点', 'concept.rename': '重命名知识点',
  'board.seed': '生成白板', 'board.patch': '编辑白板', 'todo.create': '添加待办', 'todo.update': '更新待办', 'review.rate': '复习评分',
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
