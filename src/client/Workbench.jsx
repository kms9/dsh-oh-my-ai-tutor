import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraphSvg, BoardCanvas } from './views.jsx';
import { MindElixirMap } from './mindmap.jsx';
import { markdownToHtml, MASTERY_LABEL, ACTION_LABEL, relTime } from './layout.mjs';

const TABS = [['outline', '课程大纲'], ['mindmap', '思维导图'], ['graph', '知识图谱'], ['board', '知识白板']];
const PHASES = [['plan_pending', '01 · 课时计划'], ['teaching', '02 · 分段讲解'], ['review_pending', '03 · Review'], ['summary_pending', '04 · 笔记']];
const PART_STATUS = { not_started: '未开始', in_progress: '讲解中', covered: '已讲完' };

function useWidthClass(ref) {
  const [cls, setCls] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setCls(w >= 1010 ? '' : w >= 700 ? 'w-mid' : 'w-narrow');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return cls;
}
/** Callback-ref width observer (the observed element mounts after the first data load). */
function useElementWidth() {
  const [w, setW] = useState(0);
  const roRef = useRef(null);
  const ref = useCallback((el) => {
    roRef.current?.disconnect();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setW(Math.floor(entry.contentRect.width)));
    ro.observe(el); roRef.current = ro;
  }, []);
  return [ref, w];
}

/**
 * Inline rename. `onCommit` resolves true when saved; on false (conflict / error) the editor stays open with the
 * learner's draft so nothing typed is lost, and the learner decides whether to save again.
 */
function InlineEdit({ value, onCommit, onCancel, testId }) {
  const [v, setV] = useState(value);
  const inflight = useRef(false);
  const done = useRef(false);
  const commit = async () => {
    if (inflight.current || done.current) return;
    const t = v.trim();
    if (!t || t === value) { done.current = true; onCancel(); return; }
    inflight.current = true;
    const ok = await onCommit(t);
    inflight.current = false;
    if (ok) done.current = true;
  };
  return (
    <input className="inline" autoFocus value={v} data-testid={testId} onChange={(e) => setV(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { done.current = true; onCancel(); } }}
      onBlur={() => { if (!inflight.current && !done.current) commit(); }} />
  );
}

/**
 * The three-column learning workbench. All reads come from the tutor domain state through `api.call('workbench')`;
 * all learner edits go through `api.call('mutate')` (same transitions, gates and CAS the AI tools use).
 */
export function Workbench({ api, visible = true, initialView, navRevision, pollMs = 1000, chrome = true }) {
  const rootRef = useRef(null);
  const widthClass = useWidthClass(rootRef);
  const [rightRef, rightWidth] = useElementWidth();
  const [model, setModel] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(initialView && TABS.some(([k]) => k === initialView) ? initialView : 'graph');
  const [mmZoom, setMmZoom] = useState('off'); // 'off' | 'wide' (centre + right column) | 'full' (whole workbench)
  const zoom = tab === 'mindmap' ? mmZoom : 'off';
  useEffect(() => {
    if (zoom === 'off') return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.target.closest?.('#input-box')) setMmZoom('off'); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom]);
  const [courseId, setCourseId] = useState(null);
  const [selected, setSelected] = useState(null); // conceptId
  const [lessonId, setLessonId] = useState(null);
  const [partIndex, setPartIndex] = useState(null);
  const revRef = useRef(-1);
  const courseRef = useRef(null);
  courseRef.current = courseId;
  // Poll ordering: every workbench request gets a sequence number; a response older than the last applied one is dropped.
  const seqRef = useRef(0);
  const appliedRef = useRef(0);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => { if (initialView && TABS.some(([k]) => k === initialView)) setTab(initialView); }, [initialView, navRevision]);

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    const next = await api.call('workbench', { courseId: courseRef.current ?? undefined });
    if (seq < appliedRef.current) return null; // a newer response already landed
    appliedRef.current = seq;
    revRef.current = next.revision;
    setModel(next); setError(''); setDisconnected(false);
    return next;
  }, [api]);

  useEffect(() => { reload().catch((e) => setError(e.message)); }, [reload, courseId]);
  useEffect(() => {
    if (!visible) return undefined;
    let stop = false, inflight = false;
    const tick = async () => {
      if (inflight) return; // never stack polls behind a slow host
      inflight = true;
      try {
        const head = await api.call('head', {});
        if (!stop) setDisconnected(false);
        if (!stop && head.revision !== revRef.current) await reload();
      } catch (e) { if (!stop) { setError(e.message); setDisconnected(true); } }
      finally { inflight = false; }
    };
    const t = setInterval(tick, pollMs);
    return () => { stop = true; clearInterval(t); };
  }, [api, reload, visible, pollMs]);

  const flash = (text, err = false) => { setNotice({ text, err }); setTimeout(() => setNotice((n) => (n && n.text === text ? null : n)), err ? 6000 : 2600); };
  /**
   * One learner write. Never retries with a newer revision by itself: on conflict it re-reads, says so and returns false,
   * so the caller keeps its draft (rename box, note) and the learner decides.
   */
  const mutate = useCallback(async (action, input, summary, okText, { draft = false } = {}) => {
    setBusy(true);
    try {
      await api.call('mutate', { action, input, summary });
      await reload();
      if (okText) flash(okText);
      return true;
    } catch (e) {
      const conflict = e.code === 'tutor/conflict' || /changed|conflict/i.test(e.message);
      flash(conflict
        ? (draft ? 'AI 或其他窗口刚改过这里，没有保存。已读到最新版本，你的草稿还在，确认后再保存一次。' : 'AI 或其他窗口刚改过这里，没有保存。已刷新到最新版本，请看一眼再操作。')
        : `未保存：${e.message}`, true);
      await reload().catch(() => {});
      return false;
    } finally { setBusy(false); }
  }, [api, reload]);

  if (error && !model) return <div className="omt" ref={rootRef}><div className="empty" style={{ padding: 28 }}>无法读取学习状态：{error}</div></div>;
  if (!model) return <div className="omt" ref={rootRef}><div className="empty" style={{ padding: 28 }}>正在读取学习状态…</div></div>;
  if (!model.course) return (
    <div className="omt" ref={rootRef}><div className="empty" style={{ padding: 28 }}>还没有课程。在对话里告诉 AI 你想学什么，它会用 tutor 工具创建目标和大纲，这里会自动出现。</div></div>
  );

  const { course, goal, concepts, views } = model;
  const topics = course.syllabus.topics;
  const conceptById = new Map(concepts.map((c) => [c.id, c]));
  const syllabusRevision = course.syllabus.revision;
  // `rev` = the outline revision that was on screen when the gesture began (locked by the caller); default = rendered one.
  const outlineEdit = (operations, summary, rev = syllabusRevision, opts) => mutate('course.editOutline', { courseId: course.id, syllabusRevision: rev, operations }, summary, '已保存到课程大纲（思维导图同步更新）', opts);

  const lessons = model.lessons.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const lesson = lessons.find((l) => l.id === lessonId) ?? lessons.find((l) => l.status !== 'complete') ?? lessons.at(-1) ?? null;
  const lessonNo = lesson ? lessons.indexOf(lesson) + 1 : 0;
  const pIndex = lesson ? Math.min(lesson.parts.length - 1, partIndex ?? lesson.activePartIndex ?? 0) : 0;
  const part = lesson?.parts[pIndex];
  const phaseIdx = lesson ? (lesson.phase === 'complete' ? 4 : PHASES.findIndex(([k]) => k === lesson.phase)) : -1;
  const lessonAssessments = lesson ? model.assessments.filter((a) => a.lessonId === lesson.id).sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt))) : [];
  const selectedConcept = conceptById.get(selected) ?? concepts[0];

  return (
    <div className={`omt ${widthClass}${zoom !== 'off' ? ` mmz-${zoom}` : ''}`} ref={rootRef} data-testid="tutor-workbench" data-revision={model.revision} data-mm-zoom={zoom}>
      {chrome && (
        <header className="omt-header">
          <div className="mark">oh-my-<i>ai-tutor</i> <span className="small">/ DSH 学习工作台</span></div>
          <div className="hdr-right">
            {model.courses.length > 1 && (
              <select className="course" value={course.id} onChange={(e) => { setCourseId(e.target.value); setLessonId(null); setPartIndex(null); }} aria-label="选择课程">
                {model.courses.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
              </select>
            )}
            {disconnected
              ? <span className="chip warn" data-testid="sync-chip" title={error}>已断开 · 显示第 {model.revision} 版</span>
              : <span className="chip src" data-testid="sync-chip">实时 · 第 {model.revision} 版</span>}
          </div>
        </header>
      )}
      <div className="app">
        <aside className="side">
          <div className="goal">
            <span className="small">LEARNING GOAL</span>
            <strong data-testid="goal-title">{goal?.title ?? course.title}</strong>
            <div className="small" style={{ marginTop: 10 }}>{model.courses.length} 门课程 · {concepts.length} 个知识点</div>
          </div>
          <h3>课程目录</h3>
          <div data-testid="sidebar-toc">
            {topics.map((t, i) => (
              <React.Fragment key={t.id}>
                <div className="topic"><span>{i + 1}. {t.title}</span><span className="small">{t.subtopics.length}</span></div>
                {t.subtopics.map((s) => {
                  const c = conceptById.get(s.conceptId);
                  return (
                    <button key={s.id} className={`sub ${s.conceptId === selectedConcept?.id ? 'active' : ''}`} onClick={() => setSelected(s.conceptId)} title={MASTERY_LABEL[c?.mastery] ?? ''}>
                      <i className={`dot ${c?.mastery ?? ''}`} />{s.title}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
          <h3>学习视图</h3>
          <button className="sub" onClick={() => setTab('mindmap')}>◇ 课程思维导图</button>
          <button className="sub" onClick={() => setTab('graph')}>◎ 知识语义图谱</button>
          <button className="sub" onClick={() => setTab('board')}>▦ 知识白板</button>
        </aside>

        <main className="center" data-testid="lesson-pane">
          {lesson ? (
            <>
              <div className="eyebrow">LESSON {String(lessonNo).padStart(2, '0')} / {course.title}</div>
              <h1 className="h" data-testid="lesson-title">{lesson.title}</h1>
              <div className="lead">目标：{goal?.expectedOutcome ?? lesson.parts.map((p) => p.objective).join('；')}</div>
              {lessons.length > 1 && (
                <div className="parts" style={{ marginBottom: 8 }}>
                  {lessons.map((l, i) => <button key={l.id} className={l.id === lesson.id ? 'active' : ''} onClick={() => { setLessonId(l.id); setPartIndex(null); }}>第 {i + 1} 课</button>)}
                </div>
              )}
              <div className="stepper" data-testid="stepper">
                {PHASES.map(([k, label], i) => <span key={k} className={`step ${i === phaseIdx ? 'active' : i < phaseIdx ? 'done' : ''}`}>{label}</span>)}
                {lesson.phase === 'complete' && <span className="step active">✓ 已结课</span>}
              </div>
              <section className="lesson">
                <div className="lessonbar">
                  <b>{part?.title ?? '课时计划'}</b>
                  <span className="parts">
                    {lesson.parts.map((p, i) => <button key={p.id} className={i === pIndex ? 'active' : ''} onClick={() => setPartIndex(i)} title={PART_STATUS[p.status]}>Part {i + 1}</button>)}
                    <span className="small" style={{ marginLeft: 6 }}>{PART_STATUS[part?.status] ?? ''}</span>
                  </span>
                </div>
                <div className="lessonbody">
                  {part?.body
                    ? <div data-testid="lesson-body" dangerouslySetInnerHTML={{ __html: markdownToHtml(part.body) }} />
                    : <div data-testid="lesson-body"><h4>{part?.title}</h4><p>{part?.objective}</p><p className="small">这一段的讲解还没有写入。在对话里让 AI 开讲后，会自动出现在这里。</p></div>}
                  {lesson.phase === 'plan_pending' && (
                    <div className="banner"><span>课时计划等待你确认（{lesson.parts.length} 段）。</span>
                      <button className="action" disabled={busy} onClick={() => mutate('lesson.approve', { lessonId: lesson.id }, '学习者批准课时计划', '已批准课时计划')}>批准课时计划</button></div>
                  )}
                  <div className="q" data-testid="review-box">
                    <label>{lessonAssessments.length ? `Review：已记录 ${lessonAssessments.length} 道题的真实作答` : 'Review：讲完所有段落后，AI 会在对话里一次出一道题'}</label>
                    {lessonAssessments.map((a, i) => (
                      <div className="qa" key={a.id}>
                        <div><b>第 {i + 1} 题</b><span className={`score ${a.score < 0.6 ? 'low' : ''}`}>{Math.round(a.score * 100)} 分 · {MASTERY_LABEL[conceptById.get(a.conceptId)?.mastery] ?? '—'}</span></div>
                        <div>{a.question}</div>
                        <div className="small">你的回答：{a.studentAnswer}</div>
                        <div className="small">反馈：{a.feedback}</div>
                      </div>
                    ))}
                    <NoteBox busy={busy} onSave={(text) => mutate('note.add', { lessonId: lesson.id, title: `我的笔记 · ${part?.title ?? lesson.title}`.slice(0, 160), content: text }, '学习者写笔记', '笔记已保存到课程状态')} />
                  </div>
                </div>
              </section>
            </>
          ) : (
            <>
              <div className="eyebrow">COURSE / {course.status === 'active' ? '大纲已批准' : '大纲草稿'}</div>
              <h1 className="h" data-testid="lesson-title">{course.title}</h1>
              <div className="lead">目标：{goal?.expectedOutcome}</div>
              <div className="empty">还没有课时。大纲确认后，AI 会创建第一课的分段计划，课文会出现在这里。</div>
            </>
          )}
        </main>

        <section className="right" ref={rightRef}>
          <div className="righthead"><strong>知识工作台</strong><span className="small">同一份知识数据 · 不同视图</span></div>
          <nav className="tabs" role="tablist">
            {TABS.map(([k, label]) => <button key={k} id={`omt-tab-${k}`} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>)}
          </nav>
          {/* zero-height sticky toast: saving/conflict notices never shift the layout under the pointer */}
          <div className="noticebar">{notice && <div className={`notice ${notice.err ? 'err' : ''}`} data-testid="notice" role="status">{notice.text}</div>}</div>
          {(tab === 'outline' || tab === 'mindmap') && <ApprovalBanner course={course} busy={busy} onApprove={() => mutate('course.approve', { courseId: course.id, syllabusRevision }, `学习者批准大纲第 ${syllabusRevision} 版`, '大纲已批准')} />}
          {tab === 'outline' && <OutlineView topics={topics} busy={busy} edit={outlineEdit} syllabusRevision={syllabusRevision} selected={selectedConcept?.id} onSelect={setSelected} />}
          {tab === 'mindmap' && <MindmapView view={views.mindmap} topics={topics} busy={busy} edit={outlineEdit} syllabusRevision={syllabusRevision} selected={selectedConcept?.id} onSelectConcept={setSelected} flash={flash} wide={rightWidth >= 640} zoom={zoom} setZoom={setMmZoom} fill={widthClass === '' || zoom !== 'off'} rootRef={rootRef} />}
          {tab === 'graph' && <GraphView view={views.graph} topics={topics} selected={selectedConcept?.id} onSelect={setSelected} conceptById={conceptById} relations={model.relations} width={rightWidth > 80 ? rightWidth - 4 : undefined} />}
          {tab === 'board' && <BoardView view={views.board} course={course} concepts={concepts} busy={busy} mutate={mutate} onSelectConcept={setSelected} />}
          <Activity events={model.events} />
        </section>
      </div>
    </div>
  );
}

function NoteBox({ busy, onSave }) {
  const [text, setText] = useState('');
  return (
    <>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="写下你的判断、疑问或复习计划…（保存为你的课程笔记）" data-testid="note-input" />
      <button className="action" disabled={busy || !text.trim()} onClick={async () => { if (await onSave(text.trim())) setText(''); }}>保存为我的笔记</button>
      <div className="kmeta" style={{ marginTop: 8 }}>作答请在对话中进行，AI 只记录你真实给出的回答；这里的笔记会写入同一份课程状态。</div>
    </>
  );
}

function ApprovalBanner({ course, busy, onApprove }) {
  if (course.status === 'active') return <div className="banner ok" data-testid="approval-banner"><span>大纲第 {course.syllabus.revision} 版已批准{course.syllabus.approvedBy === 'learner' ? '（由你确认）' : ''}。任何修改都会让大纲回到待确认。</span></div>;
  return (
    <div className="banner" data-testid="approval-banner">
      <span>大纲第 {course.syllabus.revision} 版待你确认：修改后需要重新批准，AI 才能继续开新课。</span>
      <button className="action" disabled={busy} onClick={onApprove} data-testid="approve-outline">批准大纲</button>
    </div>
  );
}

function OutlineView({ topics, busy, edit, syllabusRevision, selected, onSelect }) {
  const [editing, setEditing] = useState(null);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const lockRef = useRef(null); // outline revision on screen when a rename / drag began
  const startEdit = (id) => { lockRef.current = syllabusRevision; setEditing(id); };
  const commitRename = async (ops, summary) => {
    const ok = await edit(ops, summary, lockRef.current ?? syllabusRevision, { draft: true });
    if (ok) setEditing(null);
    // conflict: keep the editor open with the draft; the next Enter is an explicit learner retry against what is now on screen
    else lockRef.current = null;
    return ok;
  };
  useEffect(() => { if (editing && lockRef.current === null) lockRef.current = syllabusRevision; }, [editing, syllabusRevision]);
  /** Drop position from the pointer: upper half of a row = before it, lower half = after it. */
  const half = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY - r.top <= r.height / 2 ? 'before' : 'after'; };
  const dropSub = (e, target, topic) => {
    const src = drag; setDrag(null); setOver(null);
    if (!src || src.kind !== 'sub') return;
    let beforeId = null;
    if (target) {
      if (half(e) === 'before') beforeId = target.id;
      else { const rest = topic.subtopics.filter((x) => x.id !== src.id); const i = rest.findIndex((x) => x.id === target.id); beforeId = rest[i + 1]?.id ?? null; }
      if (beforeId === src.id) return;
    }
    edit([{ op: 'moveSubtopic', subtopicId: src.id, toTopicId: topic.id, beforeId }], target ? `拖动知识点「${src.title}」` : `拖动知识点「${src.title}」到「${topic.title}」`, src.rev);
  };
  const dropTopic = (e, t) => {
    const d = drag; setDrag(null); setOver(null);
    if (!d || d.kind !== 'topic' || d.id === t.id) return;
    let beforeId = t.id;
    if (half(e) === 'after') { const rest = topics.filter((x) => x.id !== d.id); const i = rest.findIndex((x) => x.id === t.id); beforeId = rest[i + 1]?.id ?? null; }
    edit([{ op: 'moveTopic', topicId: d.id, beforeId }], `移动主题「${d.title}」`, d.rev);
  };
  const step = (kind, list, i, dir, item) => {
    const beforeId = dir < 0 ? list[i - 1].id : (list[i + 2]?.id ?? null);
    return edit([kind === 'topic' ? { op: 'moveTopic', topicId: item.id, beforeId } : { op: 'moveSubtopic', subtopicId: item.id, beforeId }], `${dir < 0 ? '上移' : '下移'}${kind === 'topic' ? '主题' : '知识点'}「${item.title}」`);
  };
  return (
    <div data-testid="outline-view">
      <div className="title2">课程大纲
        <span className="tools"><button className="tbtn" disabled={busy} data-testid="add-topic"
          onClick={() => edit([{ op: 'addTopic', title: '新主题', subtopics: [{ title: '新知识点' }] }], '添加主题')}>＋ 主题</button></span>
      </div>
      {topics.map((t, i) => (
        <div className="card" key={t.id} data-topic-id={t.id}
          draggable={editing == null} onDragStart={(e) => { if (e.target !== e.currentTarget) return; setDrag({ kind: 'topic', id: t.id, title: t.title, index: i, rev: syllabusRevision }); }}
          onDragEnd={() => { setDrag(null); setOver(null); }}
          onDragOver={(e) => { if (drag) { e.preventDefault(); } }}
          onDrop={(e) => { e.preventDefault(); if (drag?.kind === 'topic') dropTopic(e, t); else if (drag?.kind === 'sub') dropSub(e, null, t); }}>
          <div className={`tophead ${over === t.id ? 'dragover' : ''}`} onDragEnter={() => drag?.kind === 'sub' && setOver(t.id)}>
            <span className="grow" onDoubleClick={() => startEdit(t.id)}>
              {editing === t.id
                ? <InlineEdit value={t.title} testId="inline-edit" onCancel={() => setEditing(null)} onCommit={(v) => commitRename([{ op: 'renameTopic', topicId: t.id, title: v }], `重命名主题为「${v}」`)} />
                : <b>{i + 1}. {t.title}</b>}
            </span>
            <span className="rowtools">
              <button className="tbtn" title="重命名" onClick={() => startEdit(t.id)}>改名</button>
              <button className="tbtn" title="上移" disabled={busy || i === 0} onClick={() => step('topic', topics, i, -1, t)}>↑</button>
              <button className="tbtn" title="下移" disabled={busy || i === topics.length - 1} onClick={() => step('topic', topics, i, 1, t)}>↓</button>
              <button className="tbtn" title="添加知识点" disabled={busy} onClick={() => edit([{ op: 'addSubtopic', topicId: t.id, title: '新知识点' }], `在「${t.title}」下添加知识点`)}>＋</button>
              <button className="tbtn danger" title="删除主题" disabled={busy || topics.length === 1} onClick={() => edit([{ op: 'removeTopic', topicId: t.id }], `删除主题「${t.title}」`)}>✕</button>
            </span>
          </div>
          {t.subtopics.map((s, j) => (
            <div key={s.id} className={`treerow ${selected === s.conceptId ? 'sel' : ''} ${over === s.id ? 'dragover' : ''}`} data-subtopic-id={s.id}
              draggable={editing == null} onDragStart={(e) => { e.stopPropagation(); setDrag({ kind: 'sub', id: s.id, title: s.title, index: j, rev: syllabusRevision }); }}
              onDragEnd={() => { setDrag(null); setOver(null); }}
              onDragEnter={() => drag?.kind === 'sub' && setOver(s.id)} onDragOver={(e) => drag?.kind === 'sub' && e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); if (drag?.kind === 'sub' && drag.id !== s.id) dropSub(e, s, t); else { setDrag(null); setOver(null); } }}
              onClick={() => onSelect(s.conceptId)} onDoubleClick={() => startEdit(s.id)}>
              <span className="grow">
                {editing === s.id
                  ? <InlineEdit value={s.title} testId="inline-edit" onCancel={() => setEditing(null)} onCommit={(v) => commitRename([{ op: 'renameSubtopic', subtopicId: s.id, title: v }], `重命名知识点为「${v}」`)} />
                  : <>{i + 1}.{j + 1} {s.title}　<span className="small">知识点</span></>}
              </span>
              <span className="rowtools">
                <button className="tbtn" title="上移" disabled={busy || j === 0} onClick={(e) => { e.stopPropagation(); step('sub', t.subtopics, j, -1, s); }}>↑</button>
                <button className="tbtn" title="下移" disabled={busy || j === t.subtopics.length - 1} onClick={(e) => { e.stopPropagation(); step('sub', t.subtopics, j, 1, s); }}>↓</button>
                <button className="tbtn danger" title="删除知识点" disabled={busy || t.subtopics.length === 1} onClick={(e) => { e.stopPropagation(); edit([{ op: 'removeSubtopic', subtopicId: s.id }], `删除知识点「${s.title}」`); }}>✕</button>
              </span>
            </div>
          ))}
        </div>
      ))}
      <p className="legend">双击标题可改名，拖到一行的上半部分放在它前面、下半部分放在它后面；修改会写入同一份课程状态，AI 用 tutor_outline_edit 编辑的也是这份大纲。</p>
    </div>
  );
}

const MM_MODES = [['side', '导图'], ['right', '逻辑图'], ['list', '列表']];
/** Height that fills the rest of the workbench below `el` (the right column scrolls, so add its scrollTop back). */
function useFillHeight(el, root, enabled, fallback) {
  const [h, setH] = useState(fallback);
  const measure = useCallback(() => {
    const e = el.current, r = root.current;
    if (!enabled || !e || !r) { setH((x) => (x === fallback ? x : fallback)); return; }
    const scroller = e.closest('.right');
    const top = e.getBoundingClientRect().top + (scroller?.scrollTop ?? 0);
    const next = Math.max(420, Math.round(r.getBoundingClientRect().bottom - top - 20));
    setH((x) => (Math.abs(x - next) > 2 ? next : x));
  }, [el, root, enabled, fallback]);
  useEffect(() => { measure(); }); // cheap; banners above the map change its top
  useEffect(() => {
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' && root.current ? new ResizeObserver(measure) : null;
    ro?.observe(root.current);
    return () => { window.removeEventListener('resize', measure); ro?.disconnect(); };
  }, [measure, root]);
  return h;
}

const MM_HINT = '拖动节点可调序或换到别的主题；双击改名；选中后 Tab 加子节点、Enter 加同级、Delete 删除；拖动空白处或滚轮平移，Ctrl+滚轮缩放。只有两层：主题 → 知识点。';
function MindmapView({ view, topics, busy, edit, syllabusRevision, selected, onSelectConcept, flash, wide, zoom = 'off', setZoom, fill, rootRef }) {
  const [sel, setSel] = useState(null); // { id, kind, topicId?, conceptId? } from the mind map selection
  const [mode, setMode] = useState('side');
  const [fitInfo, setFitInfo] = useState({ overflow: false });
  const mapRef = useRef(null);
  const wrapRef = useRef(null);
  const height = useFillHeight(wrapRef, rootRef, fill && mode !== 'list', wide ? 560 : 440);
  const h = view.hierarchy;
  const node = sel && (sel.kind === 'topic' ? topics.find((t) => t.id === sel.id) : topics.flatMap((t) => t.subtopics.map((s) => ({ ...s, topic: t }))).find((s) => s.id === sel.id));
  const topicIdx = node && sel.kind === 'topic' ? topics.indexOf(node) : -1;
  const subIdx = node && sel.kind === 'sub' ? node.topic.subtopics.findIndex((s) => s.id === node.id) : -1;
  const selectedSubId = topics.flatMap((t) => t.subtopics).find((s) => s.conceptId === selected)?.id;
  const submit = (ops, summary, rev, opts) => edit(ops, summary, rev, opts);
  return (
    <div data-testid="mindmap-view">
      <div className="title2">课程思维导图
        <span className="tools" data-testid="mindmap-modes">
          {mode !== 'list' && <button className="tbtn" onClick={() => mapRef.current?.fit()} data-testid="mindmap-fit" title="缩放到能看到全部节点（不小于可读字号）">适配</button>}
          {mode !== 'list' && zoom === 'off' && <button className="tbtn" onClick={() => setZoom('wide')} data-testid="mindmap-zoom" title="导图临时占用中栏 + 右栏（Esc 还原）">放大</button>}
          {mode !== 'list' && zoom === 'wide' && <button className="tbtn" onClick={() => setZoom('full')} data-testid="mindmap-zoom-full" title="导图占用整个工作台（Esc 还原）">整个工作台</button>}
          {zoom !== 'off' && <button className="tbtn on" onClick={() => setZoom('off')} data-testid="mindmap-zoom-off" title="还原三栏（Esc）">还原</button>}
          {MM_MODES.map(([k, label]) => <button key={k} className={`tbtn ${mode === k ? 'on' : ''}`} data-mode={k} onClick={() => setMode(k)}>{label}</button>)}
        </span>
      </div>
      <div className={`card ${mode !== 'list' ? 'mmcard' : ''}`}>
        {mode === 'list' && <span className="tag">基于课程大纲</span>}
        {mode !== 'list' ? (
          <>
            {/* fixed height: selecting a node must not shift the map under the pointer (a double-click would miss) */}
            <div className="tools mmbar" data-testid="mindmap-toolbar">
              {node ? <>
                <span className="small mmsel" title={node.title}>已选：{node.title}</span>
                <button className="tbtn" disabled={busy} onClick={() => mapRef.current?.beginRename(node.id)}>改名</button>
                <button className="tbtn" disabled={busy || (sel.kind === 'topic' ? topicIdx === 0 : subIdx === 0)} onClick={() => mapRef.current?.run('step', { id: node.id, dir: -1 })}>上移</button>
                <button className="tbtn" disabled={busy || (sel.kind === 'topic' ? topicIdx === topics.length - 1 : subIdx === node.topic.subtopics.length - 1)} onClick={() => mapRef.current?.run('step', { id: node.id, dir: 1 })}>下移</button>
                <button className="tbtn" disabled={busy} onClick={() => mapRef.current?.run(sel.kind === 'topic' ? 'addChild' : 'insertSibling', sel.kind === 'topic' ? { parentId: node.id } : { id: node.id, position: 'after' })}>＋ {sel.kind === 'topic' ? '子节点' : '同级'}</button>
                <button className="tbtn danger" disabled={busy || (sel.kind === 'topic' ? topics.length === 1 : node.topic.subtopics.length === 1)} onClick={async () => { if (await mapRef.current?.run('remove', { ids: [node.id] })) setSel(null); }}>删除</button>
              </> : <span className="small mmhint" title={MM_HINT}>{fitInfo.overflow ? '导图比画布大：拖动空白处平移，或点右上角「放大」。' : MM_HINT}</span>}
            </div>
            <div className="mm" ref={wrapRef}>
              <MindElixirMap ref={mapRef} hierarchy={h} syllabusRevision={syllabusRevision} direction={mode} submit={submit} notify={flash}
                selectedId={sel?.id ?? selectedSubId} height={height} onFit={(f) => setFitInfo((x) => (x.overflow === f.overflow ? x : f))}
                onSelect={(n) => { if (!n || n.kind === 'root') { setSel(null); return; } setSel(n); if (n.conceptId) onSelectConcept(n.conceptId); }} />
            </div>
          </>
        ) : (
          <div data-testid="mindmap-list">
            <div className="treerow" style={{ fontWeight: 700, marginTop: 12 }}>◉ {h.title}</div>
            <div className="treelevel">{topics.map((t) => <React.Fragment key={t.id}><div className="treerow">● {t.title}</div><div className="treelevel">{t.subtopics.map((s) => <div key={s.id} className="treerow" onClick={() => onSelectConcept(s.conceptId)}>└ {s.title}</div>)}</div></React.Fragment>)}</div>
          </div>
        )}
      </div>
      <p className="legend">导图只表达课程包含关系，不自动产生“知识前置/因果”语义边。导图与课程大纲是同一份数据：在这里调序、改名或删减，大纲同步变化；AI 用 tutor_outline_edit 改的也会实时出现在这里（你正在拖动或改名时，会等你做完再刷新）。</p>
    </div>
  );
}

function GraphView({ view, topics, selected, onSelect, conceptById, relations, width }) {
  const c = conceptById.get(selected) ?? (view.nodes[0] && conceptById.get(view.nodes[0].id));
  const related = relations.filter((r) => r.from === c?.id || r.to === c?.id);
  return (
    <div data-testid="graph-view">
      <div className="title2">语义知识图谱 <span className="small">{view.nodes.length} 个知识点 · {view.edges.length} 条候选关系</span></div>
      <div className="graph"><GraphSvg nodes={view.nodes} edges={view.edges} topicOrder={topics.map((t) => t.id)} selectedId={c?.id} onSelect={onSelect} width={width} /></div>
      {c && (
        <div className="card" data-testid="graph-detail">
          <b>{c.title}</b>
          <p className="kmeta">知识点 ID: {c.id}</p>
          <p className="small">理解状态：{MASTERY_LABEL[c.mastery]}（{c.mastery}）。{related.length ? `相关候选关系：${related.map((r) => `${conceptById.get(r.from)?.title} —${r.type}→ ${conceptById.get(r.to)?.title}`).join('；')}。` : '暂无候选关系。'}这里只展示候选关系，不把图形箭头误认为已验证知识。</p>
        </div>
      )}
      <p className="legend">虚线箭头为候选语义关系；关系类型和来源审查属于 Knowledge Graph 的领域层。节点按课程大纲顺序排列，颜色条表示所属主题。</p>
    </div>
  );
}

function BoardView({ view, course, concepts, busy, mutate, onSelectConcept }) {
  const [sel, setSel] = useState(null);
  const [linkMode, setLinkMode] = useState(false);
  const [scale, setScale] = useState(1);
  const els = view.elements;
  const onBoard = new Set(els.filter((e) => e.type === 'concept').map((e) => e.conceptId));
  const missing = concepts.filter((c) => !onBoard.has(c.id)).length;
  // `rev` = board revision on screen when the gesture began (BoardCanvas locks it at pointer-down / double-click)
  const patch = (operations, summary, ok, rev = view.boardRevision, opts) => mutate('board.patch', { courseId: course.id, baseRevision: rev, operations }, summary, ok, opts);
  const selEl = els.find((e) => e.id === sel);
  const rootRef = useRef(null);
  // Delete key only: scoped to the board root, ignored when focus is outside it or in a text field (no Backspace).
  const onKeyDown = (e) => {
    if (e.key !== 'Delete' || !selEl) return;
    if (!rootRef.current?.contains(e.target) || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable) return;
    e.preventDefault(); patch([{ op: 'delete', id: selEl.id }], `白板：删除「${selEl.text ?? '连线'}」`, '已从白板删除'); setSel(null);
  };
  const maxY = els.filter((e) => e.type !== 'arrow').reduce((m, e) => Math.max(m, e.y + e.height), 0);
  return (
    <div data-testid="board-view" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: 'none' }}>
      <div className="title2">知识白板 <span className="small">· 第 {view.boardRevision} 版 · {els.filter((e) => e.type !== 'arrow').length} 张卡片</span></div>
      <div className="tools" style={{ marginBottom: 8 }} data-testid="board-toolbar">
        <button className="tbtn" disabled={busy || !missing} onClick={() => mutate('board.seed', { courseId: course.id, baseRevision: view.boardRevision }, '白板：从大纲生成知识点卡片', '已生成白板卡片')} data-testid="board-seed">{missing ? `从大纲生成（${missing}）` : '已同步大纲'}</button>
        <button className="tbtn" disabled={busy} data-testid="board-add-note" onClick={() => patch([{ op: 'add', type: 'note', text: '新便签', x: 22, y: maxY + 24 }], '白板：添加便签', '已添加便签（双击可编辑）')}>＋ 便签</button>
        <button className={`tbtn ${linkMode ? 'on' : ''}`} disabled={busy} data-testid="board-link" onClick={() => setLinkMode((v) => !v)}>{linkMode ? '连线中：依次点两张卡片' : '连线'}</button>
        <button className="tbtn danger" disabled={busy || !selEl} data-testid="board-delete" onClick={() => { patch([{ op: 'delete', id: selEl.id }], `白板：删除「${selEl.text ?? '连线'}」`, '已从白板删除'); setSel(null); }}>删除</button>
        <span style={{ flex: 1 }} />
        <button className="tbtn" onClick={() => setScale((s) => Math.max(0.4, +(s - 0.15).toFixed(2)))} title="缩小">−</button>
        <span className="small" style={{ minWidth: 34, textAlign: 'center' }}>{Math.round(scale * 100)}%</span>
        <button className="tbtn" onClick={() => setScale((s) => Math.min(1.6, +(s + 0.15).toFixed(2)))} title="放大">＋</button>
      </div>
      {els.length ? (
        <BoardCanvas elements={els} editable selectedId={sel} scale={scale} linkMode={linkMode} revision={view.boardRevision}
          onSelect={(id) => { setSel(id); rootRef.current?.focus({ preventScroll: true }); const e = els.find((x) => x.id === id); if (e?.conceptId) onSelectConcept(e.conceptId); }}
          onMove={(id, x, y, rev) => patch([{ op: 'update', id, x, y }], `白板：移动「${els.find((e) => e.id === id)?.text ?? id}」`, undefined, rev)}
          onLink={(from, to, rev) => { setLinkMode(false); patch([{ op: 'add', type: 'arrow', from, to }], '白板：连线', '已连线', rev); }}
          onEditNote={(id, text, rev) => patch([{ op: 'update', id, text }], '白板：编辑便签', '便签已保存', rev, { draft: true })} />
      ) : (
        <div className="board" data-testid="board"><div className="empty" style={{ padding: 24 }}>白板还是空的。点「从大纲生成」放入全部知识点卡片，或让 AI 用 tutor_board_patch 布置白板。</div></div>
      )}
      <div className="status">白板保存在课程状态里：拖动、删除、连线会立即保存；AI 用 tutor_board_patch 编辑同一块白板，双方修改都按版本号校验。箭头只是视觉连线，不会自动变成知识关系。</div>
    </div>
  );
}

function Activity({ events }) {
  const recent = events.filter((e) => e.action !== 'lesson.partWrite').slice(0, 6);
  if (!recent.length) return null;
  return (
    <div className="activity" data-testid="activity">
      <h4>最近修改</h4>
      {recent.map((e) => (
        <div className="act" key={e.revision}>
          <span className={`who ${e.actor === 'learner' ? 'learner' : ''}`}>{e.actor === 'learner' ? '你' : 'AI'}</span>
          <span>{e.summary ?? ACTION_LABEL[e.action] ?? e.action}</span>
          <span className="t">第 {e.revision} 版 · {relTime(e.at)}</span>
        </div>
      ))}
    </div>
  );
}
