import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { lazyComponent } from './chunks.jsx';
import { MASTERY_LABEL } from './layout.mjs';
import { AddToChatButton } from './AddToChat.jsx';

// heavy part loads on first use: lib/client.grid.js (Glide Data Grid)
const DataGrid = lazyComponent('grid', 'DataGrid', 200);

/** 数据 tab sub-views: saved learning records only (row data from SQLite). To-dos / review reminders / calendar live in 日历. */
export const DATA_TABS = [['kp', '知识点'], ['questions', '题目'], ['attempts', '作答'], ['lessons', '课时'], ['reviewLogs', '复习记录']];
/** FSRS grades with short Chinese labels (Again / Hard / Good / Easy). */
export const RATING = [[1, '忘了'], [2, '吃力'], [3, '想起来了'], [4, '轻松']];
export const REVIEW_STATE = { new: '未开始', learning: '学习中', review: '复习中', relearning: '重新学习' };
/** "11月14日" in the learner's zone; null → 未排期 */
export function fmtDay(iso) { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : `${d.getMonth() + 1}月${d.getDate()}日`; }
export const inDays = (days) => (days <= 0 ? '今天' : days === 1 ? '明天' : `${days} 天后`);
const QUERY = { kp: 'knowledgePoints', questions: 'questions', attempts: 'attempts', lessons: 'lessons', reviewLogs: 'reviewLogs' };
export const STATUS = { open: '未完成', done: '已完成', dropped: '已放弃' };
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
export const defaultDue = () => { const d = new Date(); d.setHours(d.getHours() + 2, 0, 0, 0); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`; };

const PHASE = { plan_pending: '课时计划', teaching: '讲解中', review_pending: '复习题', summary_pending: '写笔记', feedback_pending: '课末反馈', plan_adjustment_pending: '调整大纲', complete: '已结课' };
const EMPTY = {
  kp: '这门课还没有知识点。批准课程大纲后，大纲里的知识点会出现在这里。',
  questions: '还没有题目记录。上课做题后，每道题会保存为一行。',
  attempts: '还没有作答记录。在课时里回答问题后，你的回答、得分和反馈会保存为一行。',
  lessons: '还没有课时。在对话里让 AI 开始第一节课。',
  reviewLogs: '还没有复习记录。作答或在「日历」里给复习卡评分后，每次评分会保存为一行。',
};

/**
 * 数据 tab: saved learning records (行式数据) straight from the SQLite read models — never a client-side copy:
 * knowledge points, questions, attempts, lessons and the review log. A knowledge point detail drawer links to the
 * board card / outline / graph and shows the row's review state and attempts.
 * To-dos, review reminders and the calendar are the separate 日历 tab (CalendarView), not here.
 * `focus` = { conceptId, nonce } opens the drawer for that knowledge point (from the board, the graph or a chat link).
 */
export function DataView({ api, course, revision, topics, selected, onSelectConcept, nav, reviewRate, busy, height, zoomButtons, focus, onAddToChat }) {
  const [sub, setSub] = useState('kp');
  const [data, setData] = useState({});
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [mastery, setMastery] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [detail, setDetail] = useState(null);
  const load = useCallback(async (key) => {
    try {
      const rows = await api.call('data', { query: QUERY[key], params: { courseId: course.id } });
      setData((d) => ({ ...d, [key]: rows })); setErr('');
    } catch (e) { setErr(e.message); }
  }, [api, course.id]);
  // reload whenever the shared revision changes (AI or another window wrote) or the sub-tab changes
  useEffect(() => { load(sub); }, [load, revision, sub]);
  useEffect(() => { if (focus?.conceptId) setDetailId(focus.conceptId); }, [focus?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
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
    else if (action === 'lesson') nav.toLesson?.(row.lesson_id);
    else if (action === 'chat-concept') onAddToChat?.({ kind: 'concept', id: row.concept_id, title: row.title ?? row.concept_title, courseId: course.id });
    else if (action === 'chat-lesson') onAddToChat?.({ kind: 'lesson', id: row.lesson_id, title: row.title, courseId: course.id });
  }, [nav, openDetail, onAddToChat, course.id]);

  const q = query.trim().toLowerCase();
  const match = (...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q));
  const loaded = data[sub] !== undefined;
  const rowsOf = {
    kp: () => (data.kp ?? []).filter((r) => match(r.title, r.topic_title, r.description) && (!mastery || r.mastery === mastery)),
    questions: () => (data.questions ?? []).filter((r) => match(r.question, r.concept_title, r.lesson_title)),
    attempts: () => (data.attempts ?? []).filter((r) => match(r.question, r.student_answer, r.concept_title, r.feedback)),
    lessons: () => (data.lessons ?? []).filter((r) => match(r.title, r.pending_question, r.feedback)),
    reviewLogs: () => (data.reviewLogs ?? []).filter((r) => match(r.concept_title)),
  };
  const rows = rowsOf[sub]();
  const filtered = Boolean(q || (sub === 'kp' && mastery));

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
  const lCols = useMemo(() => [
    { id: 'title', title: '课时', width: 170, link: (r) => ({ label: `${r.title} ›`, action: 'lesson' }), sortValue: (r) => r.created_at },
    { id: 'phase', title: '阶段', width: 84, value: (r) => (r.status === 'complete' ? '已结课' : PHASE[r.phase] ?? r.phase) },
    { id: 'parts', title: '段数', width: 52, value: (r) => r.parts },
    { id: 'pending', title: '待你回答', width: 180, value: (r) => r.pending_question },
    { id: 'feedback', title: '课末反馈', width: 160, kind: 'muted', value: (r) => r.feedback },
    { id: 'created', title: '开始时间', width: 104, value: (r) => fmtLocal(r.created_at), sortValue: (r) => r.created_at },
    { id: 'updated', title: '最近更新', width: 104, value: (r) => fmtLocal(r.updated_at), sortValue: (r) => r.updated_at },
    { id: 'chat', title: '对话', width: 90, link: () => ({ label: '添加到对话', action: 'chat-lesson' }) },
  ], []);
  const logCols = useMemo(() => [
    { id: 'at', title: '时间', width: 104, value: (r) => fmtLocal(r.reviewed_at), sortValue: (r) => r.reviewed_at },
    { id: 'kp', title: '知识点', width: 130, link: (r) => (r.concept_id ? { label: `${r.concept_title ?? '知识点'} ›`, action: 'detail' } : null) },
    { id: 'rating', title: '评分', width: 76, value: (r) => RATING.find(([v]) => v === r.rating)?.[1] ?? r.rating },
    { id: 'actor', title: '评分人', width: 62, value: (r) => ACTOR[r.actor] ?? r.actor },
    { id: 'from', title: '来源', width: 70, value: (r) => (r.assessment_id ? '来自作答' : '手动评分') },
    { id: 'before', title: '之前状态', width: 76, value: (r) => REVIEW_STATE[r.state_before] ?? r.state_before },
    { id: 'next', title: '下次复习', width: 92, value: (r) => fmtDay(r.next_due) ?? '—', sortValue: (r) => r.next_due },
    { id: 'days', title: '间隔（天）', width: 76, value: (r) => r.scheduled_days },
  ], []);
  const COLS = { kp: kpCols, questions: qCols, attempts: aCols, lessons: lCols, reviewLogs: logCols };
  const KEY = { kp: (r) => r.concept_id, questions: (r) => r.assessment_id, attempts: (r) => r.assessment_id, lessons: (r) => r.lesson_id, reviewLogs: (r) => r.id };

  const gridH = Math.max(220, (height ?? 460) - (detailId ? 300 : 0));
  return (
    <div data-testid="data-view">
      <div className="title2"><span>数据 · 学习记录 <span className="small">· SQLite 行式数据 · 第 {revision} 版</span></span>
        <span className="tools">{zoomButtons}</span>
      </div>
      <div className="tools rfbar" data-testid="data-subtabs">
        {DATA_TABS.map(([k, label]) => <button key={k} className={`tbtn ${sub === k ? 'on' : ''}`} data-sub={k} onClick={() => setSub(k)}>{label}{data[k] ? <span className="muted">（{data[k].length}）</span> : null}</button>)}
        <input className="kgsearch" type="search" placeholder="筛选…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="data-search" />
        {sub === 'kp' && (
          <select className="dsel" value={mastery} onChange={(e) => setMastery(e.target.value)} data-testid="data-mastery" aria-label="按掌握度筛选">
            <option value="">全部掌握度</option>{Object.entries(MASTERY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        )}
      </div>
      {err && <div className="banner warn"><span>读取数据失败：{err}</span></div>}
      {!loaded && !err
        ? <div className="empty" data-testid="data-loading" style={{ padding: 18 }}>正在读取学习记录…</div>
        : <DataGrid key={sub} testId={`grid-${sub === 'reviewLogs' ? 'review-logs' : sub}`} columns={COLS[sub]} rows={rows} rowKey={KEY[sub]} onAction={onAction} height={gridH}
            highlightKey={sub === 'kp' ? detailId ?? selected : null} emptyText={filtered ? '没有符合条件的行。' : EMPTY[sub]} />}
      {detailId && <ConceptDrawer detail={detail} topics={topics} nav={nav} busy={busy} onRate={(rating) => detail?.review && reviewRate({ conceptId: detail.concept_id, rating, baseRevision: detail.review.card.revision })} onClose={() => setDetailId(null)} onNewTodo={() => nav.toCalendar?.({ newTodoFor: detail?.concept_id })} onAddToChat={onAddToChat} courseId={course.id} />}
      <div className="status">这里是保存下来的学习记录（直接查 SQLite 里的 tutor.db，每行一条）：知识点、题目、作答、课时和复习记录。点蓝色链接：「白板卡片」跳到知识白板并高亮那张卡片，「详情」打开知识点详情；点表头排序。待办和复习提醒在「日历」标签页。</div>
    </div>
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
          : <span className="small muted" data-testid="kp-no-card">还没有白板卡片（在「知识白板」点「补齐缺失卡片」可放入）</span>}
        <button className="linkbtn" data-testid="kp-go-outline" onClick={() => nav.toOutline(detail.concept_id)}>☰ 在大纲中查看 ›</button>
        <button className="linkbtn" data-testid="kp-go-graph" onClick={() => nav.toGraph(detail.concept_id)}>◎ 在图谱中查看 ›</button>
        <button className="linkbtn" onClick={onNewTodo}>＋ 在日历里给它加待办</button>
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
