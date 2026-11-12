import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lazyComponent } from './chunks.jsx';
import { MASTERY_LABEL } from './layout.mjs';
import { AddToChatButton } from './AddToChat.jsx';

// heavy parts load on first use: lib/client.grid.js (Glide Data Grid), lib/client.calendar.js (FullCalendar)
const DataGrid = lazyComponent('grid', 'DataGrid', 200);
const TodoCalendar = lazyComponent('calendar', 'TodoCalendar', 420);

export const DATA_TABS = [['kp', '知识点'], ['questions', '题目'], ['attempts', '作答'], ['todos', '待办'], ['reviews', '复习'], ['calendar', '日历']];
/** FSRS grades with short Chinese labels (Again / Hard / Good / Easy). */
export const RATING = [[1, '忘了'], [2, '吃力'], [3, '想起来了'], [4, '轻松']];
const REVIEW_STATE = { new: '未开始', learning: '学习中', review: '复习中', relearning: '重新学习' };
/** "11月14日" in the learner's zone; null → 未排期 */
export function fmtDay(iso) { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${d.getMonth() + 1}月${d.getDate()}日`; }
const inDays = (days) => (days <= 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`);
const QUERY = { kp: 'knowledgePoints', questions: 'questions', attempts: 'attempts', todos: 'todos', calendar: 'todos', reviews: 'reviews' };
const STATUS = { open: '未完成', done: '已完成', dropped: '已放弃' };
const pad = (n) => String(n).padStart(2, '0');
/** local wall-clock display of an ISO instant (the learner's time zone) */
export function fmtLocal(iso, withDate = true) {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${d.getMonth() + 1}月${d.getDate()}日 ${t}` : t;
}
/** today's [start, end) in the browser's local time zone */
export function localDayBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return [start.getTime(), new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime()];
}
/** `datetime-local` value → ISO with the local offset (e.g. 2026-11-12T19:00:00-07:00) */
export function localInputToIso(v) {
  if (!v) return null;
  const d = new Date(v); if (Number.isNaN(d.getTime())) return null;
  const off = -d.getTimezoneOffset(); const sign = off >= 0 ? '+' : '-'; const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const defaultDue = () => { const d = new Date(); d.setHours(d.getHours() + 2, 0, 0, 0); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`; };

/**
 * 数据 tab: tables over the SQLite read models (never a client-side copy), a knowledge point detail drawer that links to
 * the board card / outline / graph, to-dos with due dates, 今天到期 and a calendar.
 * `focus` = { conceptId, nonce } opens the drawer for that knowledge point (from the board or the graph).
 */
export function DataView({ api, course, revision, topics, selected, onSelectConcept, nav, todoWrite, reviewRate, busy, height, zoomButtons, focus, onAddToChat }) {
  const [sub, setSub] = useState('kp');
  const [data, setData] = useState({});
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [mastery, setMastery] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [picked, setPicked] = useState(null); // to-do id picked in calendar / today list
  const want = sub === 'calendar' ? ['todos', 'reviews'] : sub === 'todos' ? ['todos', 'kp', 'reviews'] : sub === 'reviews' ? ['reviews'] : [sub];
  const load = useCallback(async (keys) => {
    try {
      const out = {};
      await Promise.all(keys.map(async (k) => { out[k] = await api.call('data', { query: QUERY[k], params: { courseId: course.id } }); }));
      setData((d) => ({ ...d, ...out })); setErr('');
    } catch (e) { setErr(e.message); }
  }, [api, course.id]);
  // reload whenever the shared revision changes (AI or another window wrote) or the sub-tab changes
  useEffect(() => { load([...new Set([...want, 'todos', 'reviews'])]); }, [load, revision, sub]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focus?.conceptId) { setDetailId(focus.conceptId); setSub((s) => (s === 'calendar' ? 'kp' : s)); }
    if (focus?.todoId) { setPicked(focus.todoId); setSub('todos'); }
    if (focus?.reviewId) { setSub('reviews'); }
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!detailId) { setDetail(null); return undefined; }
    let alive = true;
    api.call('data', { query: 'concept', params: { courseId: course.id, conceptId: detailId } })
      .then((d) => { if (alive) setDetail(d); }, (e) => { if (alive) setDetail({ error: e.message }); });
    return () => { alive = false; };
  }, [api, course.id, detailId, revision]);

  const openDetail = useCallback((conceptId) => { if (!conceptId) return; setDetailId(conceptId); onSelectConcept(conceptId); }, [onSelectConcept]);
  const onAction = useCallback((action, row) => {
    if (action === 'card') nav.toCard(row.board_cards[0], row.concept_id);
    else if (action === 'detail') openDetail(row.concept_id);
    else if (action === 'toggle') todoWrite('update', { id: row.id, baseRevision: row.revision, status: row.status === 'done' ? 'open' : 'done' });
    else if (action === 'chat-concept') onAddToChat?.({ kind: 'concept', id: row.concept_id, title: row.title ?? row.concept_title, courseId: course.id });
    else if (action === 'chat-todo') onAddToChat?.({ kind: 'todo', id: row.id, title: row.title, courseId: course.id });
    else if (action === 'chat-review') onAddToChat?.({ kind: 'review', id: row.id, title: row.concept_title, courseId: course.id });
  }, [nav, openDetail, todoWrite, onAddToChat, course.id]);

  const q = query.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q));
  const kpRows = (data.kp ?? []).filter((r) => match(r.title, r.topic_title, r.description) && (!mastery || r.mastery === mastery));
  const todos = data.todos ?? [];
  const [dayStart, dayEnd] = localDayBounds();
  const now = Date.now();
  const dueToday = todos.filter((t) => t.status === 'open' && t.due_at && Date.parse(t.due_at) >= dayStart && Date.parse(t.due_at) < dayEnd);
  const overdue = todos.filter((t) => t.status === 'open' && t.due_at && Date.parse(t.due_at) < dayStart);
  const reviews = data.reviews ?? [];
  // reviews due by the end of today (overdue included); 'new' cards are not scheduled yet
  const reviewsDue = reviews.filter((r) => r.due_at && Date.parse(r.due_at) < dayEnd);
  const rate = (r, rating) => reviewRate({ conceptId: r.concept_id, rating, baseRevision: r.revision });

  const kpCols = useMemo(() => [
    { id: 'title', title: '知识点', width: 132, value: (r) => r.title },
    { id: 'cards', title: '白板卡片', width: 118, sortValue: (r) => r.board_cards.length,
      link: (r) => (r.board_cards.length ? { label: r.board_cards.length > 1 ? `▦ 主卡片（共 ${r.board_cards.length} 张）›` : '▦ 白板卡片 ›', action: 'card' } : null),
      empty: () => '还没有白板卡片' },
    { id: 'detail', title: '详情', width: 74, link: () => ({ label: '详情 ›', action: 'detail' }) },
    { id: 'chat', title: '对话', width: 90, link: () => ({ label: '添加到对话', action: 'chat-concept' }) },
    { id: 'topic', title: '主题', width: 110, value: (r) => `${r.topic_index + 1}. ${r.topic_title}`, sortValue: (r) => r.topic_index * 1000 + r.sub_index },
    { id: 'mastery', title: '掌握度', width: 76, value: (r) => MASTERY_LABEL[r.mastery] ?? r.mastery },
    { id: 'attempts', title: '作答', width: 58, value: (r) => r.attempts },
    { id: 'avg', title: '平均分', width: 70, value: (r) => (r.avg_score == null ? null : Math.round(r.avg_score * 100)) },
    { id: 'relations', title: '关系', width: 58, value: (r) => r.relations },
    { id: 'todos', title: '待办', width: 58, value: (r) => r.open_todos },
    { id: 'review', title: '下次复习', width: 92, value: (r) => (r.next_review_at ? fmtDay(r.next_review_at) : '未排期'), sortValue: (r) => r.next_review_at ?? '9999' },
  ], []);
  const rCols = useMemo(() => [
    { id: 'kp', title: '知识点', width: 150, link: (r) => ({ label: `${r.concept_title} ›`, action: 'detail' }) },
    { id: 'due', title: '下次复习', width: 92, value: (r) => (r.due_at ? fmtDay(r.due_at) : '未排期'), sortValue: (r) => r.due_at ?? '9999' },
    { id: 'state', title: '状态', width: 76, value: (r) => REVIEW_STATE[r.state] ?? r.state },
    { id: 'last', title: '上次复习', width: 104, value: (r) => fmtLocal(r.last_review_at), sortValue: (r) => r.last_review_at },
    { id: 'reps', title: '复习次数', width: 70, value: (r) => r.reps },
    { id: 'lapses', title: '遗忘', width: 52, value: (r) => r.lapses },
    { id: 'stab', title: '记忆稳定性（天）', width: 112, value: (r) => (r.stability == null ? null : Math.round(r.stability * 10) / 10) },
    { id: 'chat', title: '对话', width: 90, link: () => ({ label: '添加到对话', action: 'chat-review' }) },
  ], []);
  const qCols = useMemo(() => [
    { id: 'question', title: '题目', width: 220, value: (r) => r.question },
    { id: 'kp', title: '知识点', width: 120, link: (r) => (r.concept_id ? { label: `${r.concept_title ?? '知识点'} ›`, action: 'detail' } : null) },
    { id: 'lesson', title: '课时', width: 120, value: (r) => r.lesson_title },
    { id: 'attempts', title: '作答次数', width: 76, value: (r) => r.attempts },
    { id: 'avg', title: '平均分', width: 70, value: (r) => (r.avg_score == null ? null : Math.round(r.avg_score * 100)) },
    { id: 'last', title: '最近作答', width: 110, value: (r) => fmtLocal(r.last_at), sortValue: (r) => r.last_at },
  ], []);
  const aCols = useMemo(() => [
    { id: 'at', title: '时间', width: 104, value: (r) => fmtLocal(r.recorded_at), sortValue: (r) => r.recorded_at },
    { id: 'kp', title: '知识点', width: 116, link: (r) => (r.concept_id ? { label: `${r.concept_title ?? '知识点'} ›`, action: 'detail' } : null) },
    { id: 'question', title: '题目', width: 180, value: (r) => r.question },
    { id: 'answer', title: '你的回答', width: 180, value: (r) => r.student_answer },
    { id: 'score', title: '得分', width: 56, value: (r) => (r.score == null ? null : Math.round(r.score * 100)) },
    { id: 'hints', title: '提示', width: 50, value: (r) => r.hint_count },
    { id: 'transfer', title: '迁移题', width: 60, value: (r) => (r.transfer ? '是' : '否') },
    { id: 'feedback', title: '反馈', width: 200, kind: 'muted', value: (r) => r.feedback },
  ], []);
  const tCols = useMemo(() => [
    { id: 'title', title: '待办', width: 170, value: (r) => r.title },
    { id: 'status', title: '状态', width: 96, sortValue: (r) => r.status, link: (r) => ({ label: r.status === 'done' ? '✓ 已完成（撤销）' : r.status === 'dropped' ? '已放弃' : '○ 标为完成', action: r.status === 'dropped' ? null : 'toggle' }) },
    { id: 'due', title: '到期', width: 110, value: (r) => fmtLocal(r.due_at), sortValue: (r) => r.due_at },
    { id: 'kp', title: '知识点', width: 116, link: (r) => (r.concept_id ? { label: `${r.concept_title ?? '知识点'} ›`, action: 'detail' } : null), empty: () => '—' },
    { id: 'by', title: '创建', width: 54, value: (r) => (r.created_by === 'learner' ? '你' : 'AI') },
    { id: 'chat', title: '对话', width: 90, link: () => ({ label: '添加到对话', action: 'chat-todo' }) },
  ], []);

  const gridH = Math.max(220, (height ?? 460) - (detailId ? 300 : 0));
  return (
    <div data-testid="data-view">
      <div className="title2"><span>数据 <span className="small">· SQLite · 第 {revision} 版</span></span>
        <span className="tools">{zoomButtons}</span>
      </div>
      <div className="tools rfbar" data-testid="data-subtabs">
        {DATA_TABS.map(([k, label]) => <button key={k} className={`tbtn ${sub === k ? 'on' : ''}`} data-sub={k} onClick={() => setSub(k)}>{label}{k === 'todos' && dueToday.length ? `（今天 ${dueToday.length}）` : ''}{k === 'reviews' && reviewsDue.length ? `（到期 ${reviewsDue.length}）` : ''}</button>)}
        {sub !== 'calendar' && <input className="kgsearch" type="search" placeholder="筛选…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="data-search" />}
        {sub === 'kp' && (
          <select className="dsel" value={mastery} onChange={(e) => setMastery(e.target.value)} data-testid="data-mastery" aria-label="按掌握度筛选">
            <option value="">全部掌握度</option>{Object.entries(MASTERY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
      </div>
      {err && <div className="banner warn"><span>读取数据失败：{err}</span></div>}
      {(sub === 'todos' || sub === 'calendar' || sub === 'reviews') && <DueToday dueToday={dueToday} overdue={overdue} reviewsDue={reviewsDue} dayStart={dayStart} busy={busy} onRate={rate} picked={picked} onPick={setPicked} onToggle={(t) => onAction('toggle', t)} onDetail={openDetail} onAddToChat={onAddToChat} courseId={course.id} />}
      {sub === 'kp' && <DataGrid testId="grid-kp" columns={kpCols} rows={kpRows} rowKey={(r) => r.concept_id} onAction={onAction} height={gridH} highlightKey={detailId ?? selected} />}
      {sub === 'questions' && <DataGrid testId="grid-questions" columns={qCols} rows={(data.questions ?? []).filter((r) => match(r.question, r.concept_title, r.lesson_title))} rowKey={(r) => r.assessment_id} onAction={onAction} height={gridH} />}
      {sub === 'attempts' && <DataGrid testId="grid-attempts" columns={aCols} rows={(data.attempts ?? []).filter((r) => match(r.question, r.student_answer, r.concept_title, r.feedback))} rowKey={(r) => r.assessment_id} onAction={onAction} height={gridH} />}
      {sub === 'todos' && (
        <>
          <TodoForm busy={busy} kps={data.kp ?? []} defaultConcept={detailId ?? ''} onCreate={(input) => todoWrite('create', { courseId: course.id, ...input })} />
          <DataGrid testId="grid-todos" columns={tCols} rows={todos.filter((r) => match(r.title, r.concept_title))} rowKey={(r) => r.id} onAction={onAction} height={gridH} highlightKey={picked} />
        </>
      )}
      {sub === 'reviews' && <DataGrid testId="grid-reviews" columns={rCols} rows={reviews.filter((r) => match(r.concept_title, r.topic_title))} rowKey={(r) => r.concept_id} onAction={onAction} height={gridH} highlightKey={detailId ?? selected} />}
      {sub === 'calendar' && (
        <TodoCalendar todos={todos} reviews={reviews} onSelectReview={(r) => openDetail(r.concept_id)} height={Math.max(420, (height ?? 460) - 60)} now={now} onSelect={(t) => { setPicked(t.id); if (t.concept_id) onSelectConcept(t.concept_id); }}
          onMove={(t, iso) => todoWrite('update', { id: t.id, baseRevision: t.revision, dueAt: iso })} />
      )}
      {detailId && <ConceptDrawer detail={detail} topics={topics} nav={nav} busy={busy} onRate={(rating) => detail?.review && reviewRate({ conceptId: detail.concept_id, rating, baseRevision: detail.review.card.revision })} onClose={() => setDetailId(null)} onNewTodo={() => setSub('todos')} onAddToChat={onAddToChat} courseId={course.id} />}
      <div className="status">表格直接查 SQLite（tutor.db）。点蓝色链接：「白板卡片」跳到知识白板并高亮那张卡片，「详情」打开知识点详情；点表头排序。待办到期时间按你电脑的时区显示。</div>
    </div>
  );
}

function DueToday({ dueToday, overdue, reviewsDue, dayStart, busy, onRate, picked, onPick, onToggle, onDetail, onAddToChat, courseId }) {
  const n = dueToday.length + reviewsDue.length;
  return (
    <div className="card duetoday" data-testid="due-today">
      <b>今天到期</b> <span className="small">{n ? `待办 ${dueToday.length} 项 · 复习 ${reviewsDue.length} 个知识点` : '今天没有到期的待办或复习'}{overdue.length ? ` · 待办已过期 ${overdue.length} 项` : ''}</span>
      {reviewsDue.map((r) => {
        const late = Date.parse(r.due_at) < dayStart;
        return (
          <div key={r.id} className={`dueitem review ${late ? 'late' : ''}`} data-review-id={r.id} data-concept={r.concept_id}>
            <span className="kind review" title="FSRS 复习">复习</span>
            <span className="grow"><button className="linkbtn" onClick={() => onDetail(r.concept_id)}>{r.concept_title} ›</button></span>
            <span className="small">{late ? `已过期 · ${fmtDay(r.due_at)}` : fmtLocal(r.due_at, false)}</span>
            <span className="rates" data-testid="review-rate">{RATING.map(([v, label]) => <button key={v} className={`tbtn rate r${v}`} disabled={busy} data-rating={v} onClick={() => onRate(r, v)}>{label}</button>)}</span>
            <AddToChatButton resource={{ kind: 'review', id: r.id, title: r.concept_title, courseId }} onAddToChat={onAddToChat} testId="add-to-chat-review" />
          </div>
        );
      })}
      {[...overdue.map((t) => ({ t, late: true })), ...dueToday.map((t) => ({ t, late: false }))].map(({ t, late }) => (
        <div key={t.id} className={`dueitem ${late ? 'late' : ''} ${picked === t.id ? 'picked' : ''}`} data-todo-id={t.id} onClick={() => onPick(t.id)}>
          <span className="kind todo">待办</span>
          <button className="tbtn" title="标为完成" onClick={(e) => { e.stopPropagation(); onToggle(t); }}>○</button>
          <span className="grow">{t.title}</span>
          <span className="small">{late ? `已过期 · ${fmtLocal(t.due_at)}` : fmtLocal(t.due_at, false)}</span>
          {t.concept_id && <button className="linkbtn" onClick={(e) => { e.stopPropagation(); onDetail(t.concept_id); }}>{t.concept_title ?? '知识点'} ›</button>}
          <AddToChatButton resource={{ kind: 'todo', id: t.id, title: t.title, courseId }} onAddToChat={onAddToChat} testId="add-to-chat-todo" />
        </div>
      ))}
    </div>
  );
}

function TodoForm({ busy, kps, defaultConcept, onCreate }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [concept, setConcept] = useState(defaultConcept);
  useEffect(() => { setConcept(defaultConcept); }, [defaultConcept]);
  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const ok = await onCreate({ title: title.trim(), dueAt: localInputToIso(due), conceptId: concept || undefined });
    if (ok) setTitle('');
  };
  return (
    <form className="todoform" onSubmit={submit} data-testid="todo-form">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="新待办，例如：复习顶点式" data-testid="todo-title" maxLength={200} />
      <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} data-testid="todo-due" aria-label="到期时间" />
      <select value={concept} onChange={(e) => setConcept(e.target.value)} data-testid="todo-concept" aria-label="关联知识点">
        <option value="">不关联知识点</option>{kps.map((k) => <option key={k.concept_id} value={k.concept_id}>{k.title}</option>)}
      </select>
      <button className="action" disabled={busy || !title.trim()} data-testid="todo-add">添加待办</button>
    </form>
  );
}

const REL = { prerequisite: '前置', partOf: '属于', explains: '解释', contrasts: '对比', applies: '应用', exampleOf: '例子', relatedTo: '相关' };
function ConceptDrawer({ detail, topics, nav, busy, onRate, onClose, onNewTodo, onAddToChat, courseId }) {
  if (!detail) return <div className="card kpdrawer" data-testid="kp-detail"><span className="small">正在读取知识点…</span></div>;
  if (detail.error) return <div className="card kpdrawer" data-testid="kp-detail"><span className="small">读取失败：{detail.error}</span> <button className="tbtn" onClick={onClose}>关闭</button></div>;
  const topic = topics[detail.topic_index];
  return (
    <div className="card kpdrawer" data-testid="kp-detail" data-concept={detail.concept_id}>
      <div className="kphead">
        <span><span className="small">知识点详情 · {detail.topic_index + 1}.{detail.sub_index + 1} · {topic?.title ?? detail.topic_title}</span><br /><b data-testid="kp-detail-title">{detail.title}</b></span>
        <button className="tbtn" onClick={onClose} data-testid="kp-detail-close" title="关闭详情">✕</button>
      </div>
      <p className="small">{detail.description || '大纲里还没有这条知识点的说明。'}</p>
      <p className="small">理解状态：<b>{MASTERY_LABEL[detail.mastery] ?? detail.mastery}</b> · 作答 {detail.attempts.length} 次{detail.avg_score != null ? ` · 平均 ${Math.round(detail.avg_score * 100)} 分` : ''} · 候选关系 {detail.relations.length} 条</p>
      <div className="kplinks" data-testid="kp-detail-links">
        {detail.board_cards.length
          ? detail.board_cards.map((id, i) => <button key={id} className="linkbtn" data-testid="kp-go-card" data-element={id} onClick={() => nav.toCard(id, detail.concept_id)}>{i === 0 ? '▦ 去白板卡片' : `▦ 第 ${i + 1} 张卡片`} ›</button>)
          : <span className="small muted" data-testid="kp-no-card">还没有白板卡片（在「知识白板」点「从大纲生成」可放入）</span>}
        <button className="linkbtn" data-testid="kp-go-outline" onClick={() => nav.toOutline(detail.concept_id)}>☰ 在大纲中查看 ›</button>
        <button className="linkbtn" data-testid="kp-go-graph" onClick={() => nav.toGraph(detail.concept_id)}>◎ 在图谱中查看 ›</button>
        <button className="linkbtn" onClick={onNewTodo}>＋ 给它加待办</button>
        <AddToChatButton resource={{ kind: 'concept', id: detail.concept_id, title: detail.title, courseId }} onAddToChat={onAddToChat} testId="add-to-chat-kp" />
      </div>
      <ReviewSection review={detail.review} busy={busy} onRate={onRate} />
      {detail.relations.length > 0 && (
        <div className="kpsec"><span className="small">候选关系</span>
          {detail.relations.map((r) => <div key={r.id} className="small">{r.from_title} —{REL[r.type] ?? r.type}→ {r.to_title}{r.status === 'candidate' ? '（候选）' : ''}</div>)}
        </div>
      )}
      <div className="kpsec"><span className="small">作答记录</span>
        {detail.attempts.length ? detail.attempts.map((a) => (
          <div key={a.assessment_id} className="qa"><div><b>{a.question}</b> <span className={`score ${a.score < 0.6 ? 'low' : ''}`}>{Math.round(a.score * 100)} 分</span></div>
            <div className="small">你的回答：{a.student_answer}</div><div className="small">反馈：{a.feedback}</div></div>
        )) : <div className="small muted">还没有作答。</div>}
      </div>
      <div className="kpsec" data-testid="kp-lessons"><span className="small">讲到它的课时</span>
        {(detail.lessons ?? []).length ? detail.lessons.map((l) => (
          <div key={l.lesson_id} className="small"><button className="linkbtn" data-testid="kp-go-lesson" data-lesson={l.lesson_id} onClick={() => nav.toLesson?.(l.lesson_id)}>{l.title} ›</button>
            <span className="muted"> · {l.via === 'plan' ? '课时计划' : '有作答（旧课时）'}{l.status === 'complete' ? ' · 已结课' : ''}</span></div>
        )) : <div className="small muted">还没有课时讲它。</div>}
      </div>
      <div className="kpsec" data-testid="kp-notes"><span className="small">挂在它上面的笔记</span>
        {(detail.notes ?? []).length ? detail.notes.map((n) => {
          const card = (detail.note_cards ?? []).find((c) => c.note_id === n.note_id);
          return (
            <div key={n.note_id} className="small">
              <button className="linkbtn" data-testid="kp-go-note" data-note={n.note_id} onClick={() => nav.toNote?.(n.note_id)}>{n.author === 'learner' ? '我的笔记' : 'AI 笔记'}：{n.title} ›</button>
              {card && <button className="linkbtn" data-testid="kp-go-note-card" data-element={card.element_id} onClick={() => nav.toCard(card.element_id, detail.concept_id)}>▦ 白板上的笔记卡片 ›</button>}
              {n.excerpt && <div className="muted">{n.excerpt}</div>}
            </div>
          );
        }) : <div className="small muted">还没有笔记挂在这个知识点上。</div>}
      </div>
      {detail.todos.length > 0 && (
        <div className="kpsec"><span className="small">相关待办</span>
          {detail.todos.map((t) => <div key={t.id} className="small">{STATUS[t.status]} · {t.title}{t.due_at ? ` · 到期 ${fmtLocal(t.due_at)}` : ''}</div>)}
        </div>
      )}
    </div>
  );
}

const ACTOR = { learner: '你', ai: 'AI', system: '初始化' };
function ReviewSection({ review, busy, onRate }) {
  if (!review) return null;
  const c = review.card;
  const now = Date.now();
  return (
    <div className="kpsec reviewsec" data-testid="kp-review" data-state={c.state} data-due={c.due_at ?? ''} data-revision={c.revision}>
      <span className="small">复习排期（FSRS）</span>
      <div className="small">
        {c.due_at
          ? <>下次复习：<b data-testid="kp-next-review">{fmtDay(c.due_at)}</b>{Date.parse(c.due_at) < now ? '（已到期）' : ''} · {REVIEW_STATE[c.state]} · 复习 {c.reps} 次 · 遗忘 {c.lapses} 次{c.stability != null ? ` · 记忆稳定性约 ${Math.round(c.stability * 10) / 10} 天` : ''}</>
          : <>下次复习：<b data-testid="kp-next-review">未排期</b>（还没有作答记录；第一次评分后开始排期）</>}
      </div>
      <div className="small">现在回想一下这个知识点，按记得的程度评分：</div>
      <div className="rates" data-testid="kp-rate">
        {RATING.map(([v, label]) => (
          <button key={v} className={`tbtn rate r${v}`} disabled={busy} data-rating={v} onClick={() => onRate(v)}>
            {label}<span className="muted"> · {inDays(review.preview[v].days)}</span>
          </button>
        ))}
      </div>
      {review.logs.length > 0 && (
        <div className="small muted" data-testid="kp-review-logs">
          {review.logs.slice(0, 4).map((l) => <div key={l.id}>{fmtLocal(l.reviewed_at)} · {ACTOR[l.actor] ?? l.actor} · {RATING.find(([v]) => v === l.rating)?.[1]}{l.assessment_id ? '（来自作答）' : ''}{l.next_due ? ` → ${fmtDay(l.next_due)}` : ''}</div>)}
        </div>
      )}
    </div>
  );
}
