import React, { useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import zhCn from '@fullcalendar/core/locales/zh-cn';

/**
 * Due-date calendar (FullCalendar Standard, MIT: dayGrid / timeGrid / interaction only — no Premium plugins).
 * Shown in the browser's local time zone (the learner's, America/Phoenix here). Dragging a to-do to another day
 * calls onMove(todo, newIsoStart) which the workbench saves with the to-do's own revision (conflict → rejected).
 */
export function TodoCalendar({ todos, onSelect, onMove, height = 520, now = Date.now() }) {
  const events = useMemo(() => todos.filter((t) => t.due_at).map((t) => {
    const overdue = t.status === 'open' && Date.parse(t.due_at) < now;
    return { id: t.id, title: t.title, start: t.due_at, allDay: false, editable: t.status === 'open',
      classNames: [`todo-${t.status}`, overdue ? 'todo-overdue' : ''].filter(Boolean),
      backgroundColor: t.status === 'done' ? '#9aa3b5' : overdue ? '#d64545' : '#2f5bd3',
      borderColor: t.status === 'done' ? '#9aa3b5' : overdue ? '#d64545' : '#2f5bd3', extendedProps: { todo: t } };
  }), [todos, now]);
  // week view opens around the current hour instead of 06:00 (evening to-dos would otherwise be below the fold)
  const scrollTime = useMemo(() => `${String(Math.max(0, new Date().getHours() - 2)).padStart(2, '0')}:00:00`, []);
  return (
    <div className="todo-cal" data-testid="todo-calendar" data-events={events.length}>
      <FullCalendar plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]} locale={zhCn} initialView="dayGridMonth"
        headerToolbar={{ left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek' }}
        buttonText={{ today: '今天', month: '月', week: '周' }} height={height} events={events} editable eventDurationEditable={false}
        eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }} dayMaxEvents={3} nowIndicator scrollTime={scrollTime} scrollTimeReset={false}
        eventClick={(info) => onSelect?.(info.event.extendedProps.todo)}
        eventDrop={async (info) => { const ok = await onMove?.(info.event.extendedProps.todo, info.event.start.toISOString()); if (ok === false) info.revert(); }} />
    </div>
  );
}
