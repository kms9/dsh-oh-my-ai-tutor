// Readable outline diff (host + browser, pure). Ids are stable across edits (rename / move keep them), so the diff
// is by id: added, removed (= retired knowledge point), renamed, re-described, moved. Moves are the minimal set:
// items outside a longest common subsequence of the surviving order, so one drag never reads as "everything moved".

function lcsKeep(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const keep = new Set();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) { keep.add(a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return keep;
}

/**
 * entries: { op, kind: 'topic'|'subtopic', id, conceptId?, title, from?, to?, fromTopic?, toTopic?, index? }
 * op ∈ add | remove | rename | describe | move
 */
export function diffOutline(before = [], after = []) {
  const entries = [];
  const oldT = new Map(before.map((t, i) => [t.id, { ...t, index: i }]));
  const newT = new Map(after.map((t, i) => [t.id, { ...t, index: i }]));
  for (const t of after) {
    const o = oldT.get(t.id);
    if (!o) { entries.push({ op: 'add', kind: 'topic', id: t.id, title: t.title, index: newT.get(t.id).index, subtopics: t.subtopics.map((s) => s.title) }); continue; }
    if (o.title !== t.title) entries.push({ op: 'rename', kind: 'topic', id: t.id, from: o.title, to: t.title, title: t.title });
    if ((o.description ?? '') !== (t.description ?? '')) entries.push({ op: 'describe', kind: 'topic', id: t.id, title: t.title });
  }
  const survivesSub = new Set(after.flatMap((t) => t.subtopics.map((s) => s.id)));
  for (const o of before) if (!newT.has(o.id)) entries.push({ op: 'remove', kind: 'topic', id: o.id, title: o.title, subtopics: o.subtopics.filter((s) => !survivesSub.has(s.id)).map((s) => s.title) });
  const surviving = (list, other) => list.filter((t) => other.has(t.id)).map((t) => t.id);
  const keptOrder = lcsKeep(surviving(before, newT), surviving(after, oldT));
  for (const t of after) if (oldT.has(t.id) && !keptOrder.has(t.id)) entries.push({ op: 'move', kind: 'topic', id: t.id, title: t.title, index: newT.get(t.id).index });

  const oldS = new Map(), newS = new Map();
  for (const t of before) t.subtopics.forEach((s, i) => oldS.set(s.id, { ...s, topicId: t.id, topicTitle: t.title, index: i }));
  for (const t of after) t.subtopics.forEach((s, i) => newS.set(s.id, { ...s, topicId: t.id, topicTitle: t.title, index: i }));
  const addedTopics = new Set(after.filter((t) => !oldT.has(t.id)).map((t) => t.id));
  const removedTopics = new Set(before.filter((t) => !newT.has(t.id)).map((t) => t.id));
  for (const [id, s] of newS) {
    const o = oldS.get(id);
    if (!o) { if (!addedTopics.has(s.topicId)) entries.push({ op: 'add', kind: 'subtopic', id, conceptId: s.conceptId, title: s.title, toTopic: s.topicTitle, index: s.index }); continue; }
    if (o.title !== s.title) entries.push({ op: 'rename', kind: 'subtopic', id, conceptId: s.conceptId, from: o.title, to: s.title, title: s.title });
    if ((o.description ?? '') !== (s.description ?? '')) entries.push({ op: 'describe', kind: 'subtopic', id, conceptId: s.conceptId, title: s.title });
    if (o.topicId !== s.topicId) entries.push({ op: 'move', kind: 'subtopic', id, conceptId: s.conceptId, title: s.title, fromTopic: o.topicTitle, toTopic: s.topicTitle, index: s.index });
  }
  for (const [id, o] of oldS) if (!newS.has(id) && !removedTopics.has(o.topicId)) entries.push({ op: 'remove', kind: 'subtopic', id, conceptId: o.conceptId, title: o.title, fromTopic: o.topicTitle });
  // removed topic: its knowledge points are retired with it (listed on the topic entry); same for added topics
  for (const t of after) {
    if (!oldT.has(t.id)) continue;
    const before_ = (before.find((x) => x.id === t.id)?.subtopics ?? []).filter((s) => newS.get(s.id)?.topicId === t.id).map((s) => s.id);
    const after_ = t.subtopics.filter((s) => oldS.get(s.id)?.topicId === t.id).map((s) => s.id);
    const keep = lcsKeep(before_, after_);
    for (const id of after_) if (!keep.has(id)) { const s = newS.get(id); entries.push({ op: 'move', kind: 'subtopic', id, conceptId: s.conceptId, title: s.title, fromTopic: s.topicTitle, toTopic: s.topicTitle, index: s.index }); }
  }
  return entries;
}

const q = (s) => `「${s}」`;
/** One Chinese line per entry (the workbench, the chat card and the tool receipt all show these). */
export function diffLines(entries, max = 60) {
  const lines = entries.map((e) => {
    const what = e.kind === 'topic' ? '主题' : '知识点';
    switch (e.op) {
      case 'add': return e.kind === 'topic' ? `＋ 新增主题${q(e.title)}（${e.subtopics.length} 个知识点：${e.subtopics.slice(0, 6).join('、')}${e.subtopics.length > 6 ? '…' : ''}）` : `＋ 在${q(e.toTopic)}新增知识点${q(e.title)}`;
      case 'remove': return e.kind === 'topic' ? `－ 删除主题${q(e.title)}${e.subtopics.length ? `（其中 ${e.subtopics.length} 个知识点退役，作答记录保留）` : ''}` : `－ 删除知识点${q(e.title)}（退役，作答记录保留）`;
      case 'rename': return `✎ ${what}${q(e.from)}改名为${q(e.to)}`;
      case 'describe': return `✎ 修改了${what}${q(e.title)}的说明`;
      case 'move': return e.kind === 'topic' ? `↕ 主题${q(e.title)}移到第 ${e.index + 1} 位` : e.fromTopic !== e.toTopic ? `↕ 知识点${q(e.title)}从${q(e.fromTopic)}移到${q(e.toTopic)}` : `↕ 知识点${q(e.title)}在${q(e.toTopic)}内移到第 ${e.index + 1} 位`;
      default: return `${e.op} ${e.title}`;
    }
  });
  return lines.length > max ? [...lines.slice(0, max), `…另有 ${lines.length - max} 项改动`] : lines;
}
