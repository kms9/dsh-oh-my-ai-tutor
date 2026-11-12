import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { lazyComponent } from './chunks.jsx';
import { AddToChatButton } from './AddToChat.jsx';
import { RATING, REVIEW_STATE, fmtDay, fmtLocal, localDayBounds, localInputToIso, defaultDue } from './data-view.jsx';

// heavy parts load on first use: lib/client.grid.js (Glide Data Grid), lib/client.calendar.js (FullCalendar)
const DataGrid = lazyComponent('grid', 'DataGrid', 200);
const TodoCalendar = lazyComponent('calendar', 'TodoCalendar', 420);

/** 日历 tab sub-views: the calendar itself, the to-do list (+ create form) and the FSRS review cards. */
export const CALENDAR_TABS = [['calendar', '日历'], ['todos', '待办'], ['reviews', '复习']];

/**
 * 日历 tab (记忆提醒): to-dos with due dates, FSRS review reminders, 今天到期 / overdue, and the calendar. Separate from
 * 数据 (which only shows saved learning records). Reads the same SQLite read models (`todos`, `reviews`).
 * `focus` = { todoId | reviewId | newTodoFor, nonce } picks / highlights an item (from a chat link or the 数据 drawer).
 * Knowledge point links go to 数据 (nav.toDetail) where the row detail lives.
 */
export function CalendarView({ api, course, revision, nav, onSelectConcept, todoWrite, reviewRate, busy, height, zoomButtons, focus, onAddToChat }) {
  const [sub, setSub] = useState('calendar');
  const [data, setData] = useState({});
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(null); // to-do id picked in calendar / today list
  const [pickedReview, setPickedReview] = useState(null); // review card id reached through a link
  const [newTodoFor, setNewTodoFor] = useState('');
  const load = useCallback(async () => {
    try {
      const [todos, reviews, kp] = await Promise.all(['todos', 'reviews', 'knowledgePoints']
        .map((query) => api.call('data', { query, params: { courseId: course.id } })));
      setData({ todos, reviews, kp }); setErr('');
    } catch (e) { setErr(e.message); }
  }, [api, course.id]);
  // reload whenever the shared revision changes (AI or another window wrote)
  useEffect(() => { load(); }, [load, revision]);
  useEffect(() => {
    if (focus?.todoId) { setPicked(focus.todoId); setSub('todos'); }
    if (focus?.reviewId) { setPickedReview(focus.reviewId); setSub('reviews'); }
    if (focus?.newTodoFor) { setNewTodoFor(focus.newTodoFor); setSub('todos'); }
  }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const toDetail = useCallback((conceptId) => { if (conceptId) nav.toDetail(conceptId); }, [nav]);
  const onAction = useCallback((action, row) => {
    if (action === 'detail') toDetail(row.concept_id);
    else if (action === 'toggle') todoWrite('update', { id: row.id, baseRevision: row.revision, status: row.status === 'done' ? 'open' : 'done' });
    else if (action === 'chat-todo') onAddToChat?.({ kind: 'todo', id: row.id, title: row.title, courseId: course.id });
    else if (action === 'chat-review') onAddToChat?.({ kind: 'review', id: row.id, title: row.concept_title, courseId: course.id });
  }, [toDetail, todoWrite, onAddToChat, course.id]);

  const q = query.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q));
  const todos = data.todos ?? [];
  const reviews = data.reviews ?? [];
  const [dayStart, dayEnd] = localDayBounds();
  const now = Date.now();
  const dueToday = todos.filter((t) => t.status === 'open' && t.due_at && Date.parse(t.due_at) >= dayStart && Date.parse(t.due_at) < dayEnd);
  const overdue = todos.filter((t) => t.status === 'open' && t.due_at && Date.parse(t.due_at) < dayStart);
  // reviews due by the end of today (overdue included); 'new' cards are not scheduled yet
  const reviewsDue = reviews.filter((r) => r.due_at && Date.parse(r.due_at) < dayEnd);
  const rate = (r, rating) => reviewRate({ conceptId: r.concept_id, rating, baseRevision: r.revision });
  const reviewHighlight = reviews.find((r) => r.id === pickedReview)?.concept_id ?? null;

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
  const tCols = useMemo(() => [
    { id: 'title', title: '待办', width: 170, value: (r) => r.title },
    { id: 'status', title: '状态', width: 96, sortValue: (r) => r.status, link: (r) => ({ label: r.status === 'done' ? '✓ 已完成（撤销）' : r.status === 'dropped' ? '已放弃' : '○ 标为完成', action: r.status === 'dropped' ? null : 'toggle' }) },
    { id: 'due', title: '到期', width: 110, value: (r) => fmtLocal(r.due_at), sortValue: (r) => r.due_at },
    { id: 'kp', title: '知识点', width: 116, link: (r) => (r.concept_id ? { label: `${r.concept_title ?? '知识点'} ›`, action: 'detail' } : null), empty: () => '—' },
    { id: 'by', title: '创建', width: 54, value: (r) => (r.created_by === 'learner' ? '你' : 'AI') },
    { id: 'chat', title: '对话', width: 90, link: () => ({ label: '添加到对话', action: 'chat-todo' }) },
  ], []);

  const gridH = Math.max(220, (height ?? 460) - 160);
  return (
    <div data-testid="calendar-view">
      <div className="title2"><span>日历 · 记忆提醒 <span className="small">· 待办与复习 · 第 {revision} 版</span></span>
        <span className="tools">{zoomButtons}</span>
      </div>
      <div className="tools rfbar" data-testid="calendar-subtabs">
        {CALENDAR_TABS.map(([k, label]) => <button key={k} className={`tbtn ${sub === k ? 'on' : ''}`} data-sub={k} onClick={() => setSub(k)}>{label}{k === 'todos' && dueToday.length ? `（今天 ${dueToday.length}）` : ''}{k === 'reviews' && reviewsDue.length ? `（到期 ${reviewsDue.length}）` : ''}</button>)}
        {sub !== 'calendar' && <input className="kgsearch" type="search" placeholder="筛选…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="calendar-search" />}
      </div>
      {err && <div className="banner warn"><span>读取待办和复习失败：{err}</span></div>}
      <DueToday dueToday={dueToday} overdue={overdue} reviewsDue={reviewsDue} dayStart={dayStart} busy={busy} onRate={rate} picked={picked} pickedReview={pickedReview} onPick={setPicked} onToggle={(t) => onAction('toggle', t)} onDetail={toDetail} onAddToChat={onAddToChat} courseId={course.id} />
      {sub === 'todos' && (
        <>
          <TodoForm busy={busy} kps={data.kp ?? []} defaultConcept={newTodoFor} onCreate={(input) => todoWrite('create', { courseId: course.id, ...input })} />
          <DataGrid testId="grid-todos" columns={tCols} rows={todos.filter((r) => match(r.title, r.concept_title))} rowKey={(r) => r.id} onAction={onAction} height={gridH} highlightKey={picked}
            emptyText={q ? '没有符合条件的待办。' : '还没有待办。用上面的表单添加，或在对话里让 AI 帮你安排。'} />
        </>
      )}
      {sub === 'reviews' && <DataGrid testId="grid-reviews" columns={rCols} rows={reviews.filter((r) => match(r.concept_title, r.topic_title))} rowKey={(r) => r.concept_id} onAction={onAction} height={gridH} highlightKey={reviewHighlight}
        emptyText={q ? '没有符合条件的复习卡。' : '还没有复习卡。知识点有了作答记录后，会按 FSRS 排期出现在这里。'} />}
      {sub === 'calendar' && (
        <TodoCalendar todos={todos} reviews={reviews} onSelectReview={(r) => toDetail(r.concept_id)} height={Math.max(420, (height ?? 460) - 60)} now={now} onSelect={(t) => { setPicked(t.id); if (t.concept_id) onSelectConcept?.(t.concept_id); }}
          onMove={(t, iso) => todoWrite('update', { id: t.id, baseRevision: t.revision, dueAt: iso })} />
      )}
      <div className="status">这里是记忆提醒：待办（可拖到别的日期改期）和 FSRS 复习到期卡（紫色）。评分「忘了 / 吃力 / 想起来了 / 轻松」会重新排下次复习。点知识点链接到「数据」看它的学习记录。时间按你电脑的时区显示。</div>
    </div>
  );
}

function DueToday({ dueToday, overdue, reviewsDue, dayStart, busy, onRate, picked, pickedReview, onPick, onToggle, onDetail, onAddToChat, courseId }) {
  const n = dueToday.length + reviewsDue.length;
  return (
    <div className="card duetoday" data-testid="due-today">
      <b>今天到期</b> <span className="small">{n ? `待办 ${dueToday.length} 项 · 复习 ${reviewsDue.length} 个知识点` : '今天没有到期的待办或复习'}{overdue.length ? ` · 待办已过期 ${overdue.length} 项` : ''}</span>
      {reviewsDue.map((r) => {
        const late = Date.parse(r.due_at) < dayStart;
        return (
          <div key={r.id} className={`dueitem review ${late ? 'late' : ''} ${pickedReview === r.id ? 'picked' : ''}`} data-review-id={r.id} data-concept={r.concept_id}>
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
