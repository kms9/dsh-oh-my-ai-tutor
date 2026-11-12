// Clickable resources (host + browser, no Node imports).
//
// DSH web renders assistant Markdown links itself: only http(s) / mailto URLs become <a> (a plain click opens the
// right-Sidebar browser tab or a new browser tab, per Settings → General), and scheme-less paths become file links
// (document preview). Custom schemes are rendered as plain text and there is no plugin hook for link schemes.
// So:
//   - an external source links to its registered URI, with the locator folded in where the URL format allows
//     (PDF `#page=12`, YouTube / Bilibili `t=`, other media `#t=`);
//   - an internal object (knowledge point, board card, note, lesson, outline row) links to a reserved https address
//     under TUTOR_LINK_ORIGIN (`.invalid` never resolves, RFC 2606). The tutor's browser plugin intercepts clicks on
//     those links (capture phase, before DSH's own handler) and opens the AI 学习工作台 at that object.
export const TUTOR_LINK_ORIGIN = 'https://tutor.invalid';
export const LINK_KINDS = Object.freeze(['concept', 'card', 'note', 'lesson', 'topic', 'outline', 'source']);
const KIND_LABEL = { concept: '知识点', card: '白板卡片', note: '笔记', lesson: '课时', topic: '主题', outline: '大纲', source: '资料' };
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

/** https://tutor.invalid/<kind>/<id>?course=<courseId>[&part=<n>] */
export function internalHref(kind, id, courseId, extra = {}) {
  if (!LINK_KINDS.includes(kind) || !ID_RE.test(String(id ?? ''))) return null;
  const q = new URLSearchParams();
  if (courseId && ID_RE.test(courseId)) q.set('course', courseId);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const qs = q.toString();
  return `${TUTOR_LINK_ORIGIN}/${kind}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`;
}
/** Inverse of internalHref; null for anything else (so ordinary links keep DSH's behaviour). */
export function parseTutorHref(href) {
  if (typeof href !== 'string' || !href.startsWith(`${TUTOR_LINK_ORIGIN}/`)) return null;
  let u;
  try { u = new URL(href); } catch { return null; }
  const [kind, raw] = u.pathname.split('/').filter(Boolean);
  let id;
  try { id = decodeURIComponent(raw ?? ''); } catch { return null; }
  if (!LINK_KINDS.includes(kind) || !ID_RE.test(id)) return null;
  const out = { kind, id };
  const course = u.searchParams.get('course'); if (course && ID_RE.test(course)) out.courseId = course;
  const part = u.searchParams.get('part'); if (part !== null && /^\d{1,2}$/.test(part)) out.partIndex = Number(part);
  return out;
}

// ---------- source locators ----------
/**
 * Free-text locator → structured. "p.12" / "第12页" / "page 12" / "12" → {page:12}; "01:30" / "1:02:03" / "90s" / "t=90"
 * → {seconds}; a range keeps its first point; anything else stays text only.
 */
export function parseLocator(text) {
  if (text === undefined || text === null || text === '') return {};
  const raw = String(text).trim().slice(0, 120);
  const s = raw.replace(/\s+/g, ' ');
  let m = /^(?:p{1,2}\.?\s*|page\s*|第\s*)?(\d{1,5})(?:\s*[-–~]\s*\d{1,5})?\s*(?:页)?$/i.exec(s);
  if (m) return { locator: raw, page: Number(m[1]) };
  m = /^(?:t\s*=\s*)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\s*[-–~].*)?$/i.exec(s);
  if (m) return { locator: raw, seconds: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) };
  m = /^(?:t\s*=\s*)?(\d{1,6})\s*s?$/i.exec(s);
  if (m && /^(?:t\s*=|\d+\s*s$)/i.test(s)) return { locator: raw, seconds: Number(m[1]) };
  return { locator: raw };
}
export function formatLocator(ref) {
  if (!ref) return '';
  if (Number.isInteger(ref.page)) return `第 ${ref.page} 页`;
  if (Number.isInteger(ref.seconds)) {
    const h = Math.floor(ref.seconds / 3600), m = Math.floor((ref.seconds % 3600) / 60), s = ref.seconds % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
  return ref.locator ?? '';
}
const isHttp = (uri) => /^https?:\/\//i.test(uri ?? '');
const isPath = (uri) => typeof uri === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(uri) && !uri.includes('?') && uri.length > 0 && !/^[\\/]{2}/.test(uri);
/**
 * Where a click on this source (+ locator) should go. http(s): the URI with the locator folded in when the format
 * allows it. A workspace / absolute path: the path itself (DSH opens it in the document preview; a page cannot be
 * addressed there). Anything else: null (not clickable; shown as text).
 */
export function sourceHref(source, ref = {}) {
  const uri = source?.uri;
  if (!uri) return null;
  if (isPath(uri)) return uri;
  if (!isHttp(uri)) return null;
  let u;
  try { u = new URL(uri); } catch { return null; }
  const pdf = /\.pdf$/i.test(u.pathname);
  if (Number.isInteger(ref.page) && (pdf || source.kind === 'file' || source.kind === 'web')) { u.hash = `page=${ref.page}`; return u.toString(); }
  if (Number.isInteger(ref.seconds)) {
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtube.com' || host === 'youtu.be') { u.searchParams.set('t', `${ref.seconds}s`); return u.toString(); }
    if (host.endsWith('bilibili.com')) { u.searchParams.set('t', String(ref.seconds)); return u.toString(); }
    u.hash = `t=${ref.seconds}`; return u.toString();
  }
  return u.toString();
}

// ---------- link objects for tool receipts ----------
const md = (label, href) => (href ? `[${String(label).replace(/[[\]]/g, '')}](${href})` : String(label));
function link(kind, id, label, href, extra = {}) {
  return { kind, id, label, href, markdown: md(label, href), ...extra };
}
/** Read model of one stored reference (structured or a legacy free-text string). */
export function refView(state, ref) {
  if (typeof ref === 'string') return { legacy: true, text: ref, label: ref, href: null, markdown: ref };
  const source = state.sources?.[ref?.sourceId];
  const where = formatLocator(ref);
  const label = `${source?.title ?? '(未登记的资料)'}${where ? ` · ${where}` : ''}`;
  const href = source ? sourceHref(source, ref) : null;
  return { sourceId: ref.sourceId, locator: ref.locator ?? null, ...(Number.isInteger(ref.page) ? { page: ref.page } : {}),
    ...(Number.isInteger(ref.seconds) ? { seconds: ref.seconds } : {}), ...(ref.quote ? { quote: ref.quote } : {}),
    label, href, markdown: md(label, href), registered: Boolean(source) };
}
/**
 * Clickable links for the named objects of one course. `want`: { conceptIds, noteIds, lessonIds, elementIds, topicIds,
 * sourceIds, sourceRefs, outline }. Unknown ids are skipped (never invented).
 */
export function linksFor(state, courseId, want = {}) {
  const course = state.courses?.[courseId];
  const out = [];
  const seen = new Set();
  const push = (l) => { if (!l || seen.has(`${l.kind}:${l.id}:${l.href}`)) return; seen.add(`${l.kind}:${l.id}:${l.href}`); out.push(l); };
  for (const id of want.conceptIds ?? []) {
    const c = state.concepts?.[id]; if (!c || c.courseId !== courseId) continue;
    push(link('concept', id, `知识点：${c.title}`, internalHref('concept', id, courseId), c.status !== 'active' ? { retired: true } : {}));
  }
  for (const id of want.topicIds ?? []) {
    const t = course?.syllabus?.topics?.find((x) => x.id === id); if (!t) continue;
    push(link('topic', id, `主题：${t.title}`, internalHref('topic', id, courseId)));
  }
  for (const id of want.lessonIds ?? []) {
    const l = state.lessons?.[id]; if (!l || l.courseId !== courseId) continue;
    push(link('lesson', id, `课时：${l.title}`, internalHref('lesson', id, courseId)));
  }
  for (const id of want.noteIds ?? []) {
    const n = state.notes?.[id]; if (!n || n.courseId !== courseId) continue;
    push(link('note', id, `笔记：${n.title}`, internalHref('note', id, courseId)));
  }
  const board = state.boards?.[courseId];
  for (const id of want.elementIds ?? []) {
    const e = board?.elements?.find((x) => x.id === id && !x.deleted); if (!e || e.type === 'arrow') continue;
    const title = e.type === 'concept' ? state.concepts?.[e.conceptId]?.title : e.noteId ? state.notes?.[e.noteId]?.title : e.text;
    push(link('card', id, `白板卡片：${String(title ?? '').slice(0, 40)}`, internalHref('card', id, courseId)));
  }
  for (const id of want.sourceIds ?? []) {
    const s = state.sources?.[id]; if (!s) continue;
    const href = sourceHref(s);
    push(link('source', id, `资料：${s.title}`, href, { external: true }));
  }
  for (const ref of want.sourceRefs ?? []) {
    const v = refView(state, ref); if (v.legacy || !v.registered) continue;
    push(link('source', v.sourceId, `资料：${v.label}`, v.href, { external: true, locator: v.locator }));
  }
  if (want.outline && course) push(link('outline', courseId, `大纲（第 ${course.syllabus.revision} 版）`, internalHref('outline', courseId, courseId)));
  return out;
}
export { KIND_LABEL };
