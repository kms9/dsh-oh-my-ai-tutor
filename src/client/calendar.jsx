import React, { useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import zhCn from '@fullcalendar/core/locales/zh-cn';

/**
 * Due-date calendar (FullCalendar Standard, MIT: dayGrid / timeGrid / list / interaction — no Premium plugins).
 * Shown in the browser's local time zone (the learner's, America/Phoenix here). Dragging a to-do to another day
 * calls onMove(todo, newIsoStart) which the workbench saves with the to-do's own revision (conflict → rejected).
 * FSRS reviews are purple and not draggable (their date comes from the rating); clicking one opens the knowledge point.
 *
 * Readable titles in a narrow column: below NARROW px the calendar opens in the 日程 (list) view, where each line has
 * the full title; in 月 / 周 the event text wraps (up to 3 lines) instead of being cut to one character, and every
 * event carries its full title as a hover tooltip.
 */
export const NARROW = 560;
const COLOR = { review: '#7c4dcc', todo: '#2f5bd3', overdue: '#d64545', done: '#9aa3b5' };
const hm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export function fullTitle(ev) {
  const { todo, review } = ev.extendedProps;
  const when = ev.start ? `${ev.start.getMonth() + 1}月${ev.start.getDate()}日 ${hm(ev.start)}` : '';
  if (review) return `复习：${review.concept_title}（${when}）`;
  const state = todo.status === 'done' ? '已完成' : todo.status === 'dropped' ? '已放弃' : ev.classNames.includes('todo-overdue') ? '已过期' : '待办';
  return `${state}：${todo.title}（${when}）${todo.concept_title ? ` · 知识点：${todo.concept_title}` : ''}`;
}
function EventBody({ arg }) {
  const { review } = arg.event.extendedProps;
  const list = arg.view.type.startsWith('list');
  const title = review ? review.concept_title : arg.event.title;
  return (
    <div className={`omt-ev ${list ? 'list' : ''}`} data-full-title={fullTitle(arg.event)}>
      {!list && arg.timeText && <span className="omt-ev-time">{arg.timeText}</span>}
      <span className="omt-ev-tag">{review ? '复习' : '待办'}</span>
      <span className="omt-ev-title">{title}</span>
    </div>
  );
}
export function TodoCalendar({ todos, reviews = [], onSelect, onSelectReview, onMove, height = 520, now = Date.now() }) {
  const wrapRef = useRef(null);
  const calRef = useRef(null);
  const [width, setWidth] = useState(null);
  const chosen = useRef(false); // the learner picked a view: don't switch it on resize
  useEffect(() => {
    const el = wrapRef.current; if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const narrow = width != null && width < NARROW;
  useEffect(() => {
    const api = calRef.current?.getApi(); if (!api || chosen.current || width == null) return;
    const want = narrow ? 'listWeek' : 'dayGridMonth';
    if (api.view.type !== want) api.changeView(want);
  }, [narrow, width]);
  const events = useMemo(() => todos.filter((t) => t.due_at).map((t) => {
    const overdue = t.status === 'open' && Date.parse(t.due_at) < now;
    const color = t.status === 'done' ? COLOR.done : overdue ? COLOR.overdue : COLOR.todo;
    return { id: t.id, title: t.title, start: t.due_at, allDay: false, editable: t.status === 'open', display: 'block',
      classNames: [`todo-${t.status}`, overdue ? 'todo-overdue' : ''].filter(Boolean), backgroundColor: color, borderColor: color, extendedProps: { todo: t } };
  }).concat(reviews.filter((r) => r.due_at).map((r) => ({ id: `review:${r.id}`, title: `复习：${r.concept_title}`, start: r.due_at, allDay: false, editable: false,
    display: 'block', classNames: ['review-event'], backgroundColor: COLOR.review, borderColor: COLOR.review, extendedProps: { review: r } }))), [todos, reviews, now]);
  // week view opens around the current hour instead of 06:00 (evening to-dos would otherwise be below the fold)
  const scrollTime = useMemo(() => `${String(Math.max(0, new Date().getHours() - 2)).padStart(2, '0')}:00:00`, []);
  return (
    <div ref={wrapRef} className={`todo-cal ${narrow ? 'narrow' : ''}`} data-testid="todo-calendar" data-events={events.length} data-narrow={narrow ? '1' : '0'}
      data-reviews={reviews.filter((r) => r.due_at).length}>
      {width != null && (
        <FullCalendar ref={calRef} plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]} locale={zhCn}
          initialView={narrow ? 'listWeek' : 'dayGridMonth'}
          headerToolbar={narrow ? { left: 'prev,next today', center: '', right: 'listWeek,dayGridMonth,timeGridWeek' } : { left: 'prev,next today', center: 'title', right: 'listWeek,dayGridMonth,timeGridWeek' }}
          footerToolbar={narrow ? { center: 'title' } : false}
          buttonText={{ today: '今天', month: '月', week: '周', list: '日程' }} views={{ listWeek: { noEventsContent: '这一周没有待办或复习' } }}
          datesSet={(info) => { if (calRef.current && info.view.type !== (narrow ? 'listWeek' : 'dayGridMonth')) chosen.current = true; }}
          height={height} events={events} editable eventDurationEditable={false}
          eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }} dayMaxEvents={narrow ? 2 : 3} nowIndicator scrollTime={scrollTime} scrollTimeReset={false}
          eventContent={(arg) => <EventBody arg={arg} />}
          eventDidMount={(info) => { info.el.title = fullTitle(info.event); info.el.dataset.fullTitle = fullTitle(info.event); }}
          eventClick={(info) => { const { todo, review } = info.event.extendedProps; if (review) onSelectReview?.(review); else onSelect?.(todo); }}
          eventDrop={async (info) => { const ok = await onMove?.(info.event.extendedProps.todo, info.event.start.toISOString()); if (ok === false) info.revert(); }} />
      )}
      <div className="cal-legend small muted"><i style={{ background: COLOR.review }} />复习 <i style={{ background: COLOR.todo }} />待办 <i style={{ background: COLOR.overdue }} />已过期 <i style={{ background: COLOR.done }} />已完成 · 悬停事件可看完整标题</div>
    </div>
  );
}
