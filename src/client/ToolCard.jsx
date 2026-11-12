import React, { useMemo } from 'react';
import { MindmapSvg, GraphSvg, BoardCanvas } from './views.jsx';
import { TUTOR_LINK_ORIGIN } from '../links.mjs';

const VIEW_TITLE = { outline: '课程大纲', mindmap: '课程思维导图', graph: '知识语义图谱', board: '课程白板', 'whiteboard-seed': '白板初始布局' };

function parseResult(block) {
  const text = (block?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  try { return JSON.parse(text); } catch { return null; }
}
function readArgs(block) {
  try {
    const raw = block?.call?.argsRaw;
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  const out = {};
  for (const k of ['view', 'courseId', 'action']) { try { const v = block?.args?.value?.(k) ?? block?.args?.get?.(k); if (v !== undefined) out[k] = v; } catch { /* ignore */ } }
  return out;
}
function seedToElements(value) {
  const ops = value.operations ?? [];
  const cards = ops.filter((o) => o.type === 'rectangle').map((o) => ({ id: o.id, type: 'concept', text: o.text, x: o.x + 20, y: o.y + 20, width: o.width ?? 196, height: o.height ?? 72 }));
  const arrows = ops.filter((o) => o.type === 'arrow').map((o) => ({ id: o.id, type: 'arrow', from: o.startId, to: o.endId }));
  return [...cards, ...arrows];
}

/** Clickable chips: internal links open the workbench; http(s) follow DSH (sidebar browser / new tab). */
function LinkChips({ links, openWorkbench, openExternal }) {
  if (!links?.length) return null;
  return (
    <div className="chips" data-testid="tool-links">
      {links.map((l, i) => {
        const href = l.href;
        const internal = href && href.startsWith(`${TUTOR_LINK_ORIGIN}/`);
        const external = href && /^https?:/i.test(href) && !internal;
        const onOpen = (e) => {
          if (!href) return;
          if (internal && openWorkbench) { e.preventDefault(); openWorkbench(undefined, { kind: l.kind, id: l.id, courseId: undefined }); }
          else if (external && openExternal && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); openExternal(href); }
        };
        if (!href) return <span key={`${l.kind}-${l.id}-${i}`} className="chip-text">{l.label}</span>;
        return <a key={`${l.kind}-${l.id}-${i}`} className={`chip-link${external ? ' ext' : ''}${l.retired ? ' retired' : ''}`} href={href} data-testid="tool-link" data-kind={l.kind} data-id={l.id}
          target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined} onClick={onOpen}>{l.label}</a>;
      })}
    </div>
  );
}

function titleOf(toolName, args, view) {
  if (toolName === 'tutor_outline_edit') return 'AI 编辑了课程大纲';
  if (toolName === 'tutor_board_patch') return 'AI 编辑了课程白板';
  if (toolName === 'tutor_board_read') return '读取课程白板';
  if (toolName === 'tutor_write') return args.action ? `已记录：${args.action}` : '已写入学习状态';
  if (toolName === 'tutor_links') return '可点击的学习资源';
  return VIEW_TITLE[view] ?? '学习可视化';
}

/** Graphic chat card for tutor_* results (replaces raw JSON). */
export function TutorToolCard({ toolName, phase, block, openWorkbench, openExternal }) {
  const args = useMemo(() => readArgs(block), [block]);
  const value = useMemo(() => (phase === 'result' ? parseResult(block) : null), [phase, block]);
  const view = toolName === 'tutor_visualize' ? args.view : toolName === 'tutor_outline_edit' ? 'outline' : (toolName === 'tutor_board_patch' || toolName === 'tutor_board_read') ? 'board' : null;
  const title = titleOf(toolName, args, view);
  if (phase !== 'result') return <div className="omt-card"><div className="hd"><b>{title}</b><span className="meta">正在生成…</span></div></div>;
  if (block?.isError || !value) return <div className="omt-card"><div className="hd"><b>{title}</b><span className="meta">失败</span></div><div className="err">{(block?.content ?? []).map((c) => c.text).join(' ').slice(0, 400) || '没有可显示的结果'}</div></div>;
  let body = null, meta = '';
  const lines = value.change?.lines ?? value.sinceApproved?.lines;
  if (view === 'outline') {
    const o = toolName === 'tutor_outline_edit' ? value.outline : value;
    meta = `大纲第 ${o?.syllabusRevision ?? '?'} 版 · ${o?.approvedAt ? '已批准' : '待确认'}`;
    body = (
      <>
        {lines?.length > 0 && <ul className="diff" data-testid="outline-card-diff">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        {value.change?.reason && <div className="small" data-testid="outline-card-reason">原因：{value.change.reason}</div>}
        <div className="frame"><div className="ol">{(o?.topics ?? []).map((t, i) => <React.Fragment key={t.id}><b>{i + 1}. {t.title}</b>{t.subtopics.map((s, j) => <span key={s.id}>{i + 1}.{j + 1} {s.title}</span>)}</React.Fragment>)}</div></div>
      </>
    );
  } else if (view === 'mindmap') {
    meta = `${value.hierarchy?.children?.length ?? 0} 个主题`;
    body = <div className="frame" style={{ padding: 6 }}><MindmapSvg hierarchy={value.hierarchy} maxWidth={680} /></div>;
  } else if (view === 'graph') {
    meta = `${value.nodes?.length ?? 0} 个知识点 · ${value.edges?.length ?? 0} 条候选关系`;
    body = <div className="frame dots"><GraphSvg nodes={value.nodes ?? []} edges={value.edges ?? []} width={560} /></div>;
  } else if (view === 'board' || view === 'whiteboard-seed') {
    const els = view === 'whiteboard-seed' ? seedToElements(value) : (value.board?.elements ?? value.elements ?? []);
    const cards = els.filter((e) => e.type !== 'arrow');
    const w = Math.max(200, ...cards.map((e) => e.x + e.width)) + 24;
    meta = view === 'whiteboard-seed' ? '种子操作（未写入白板）' : `白板第 ${value.board?.revision ?? value.boardRevision ?? value.revision ?? '?'} 版 · ${cards.length} 张卡片`;
    body = <div className="omt" style={{ background: 'transparent', height: 'auto' }}><BoardCanvas elements={els} scale={Math.min(1, 560 / w)} height={260} testId={`chat-board-${block.callId ?? 'x'}`} /></div>;
  } else if (toolName === 'tutor_links') {
    meta = `${(value.links ?? []).length} 个链接`;
    body = null;
  } else if (toolName === 'tutor_write') {
    meta = value.revision != null ? `第 ${value.revision} 版` : '';
    body = lines?.length ? <ul className="diff" data-testid="write-card-diff">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : null;
  }
  const openView = view === 'whiteboard-seed' ? 'board' : view;
  return (
    <div className="omt-card" data-tutor-card={view ?? toolName}>
      <div className="hd"><b>{title}</b><span className="meta">{meta}</span>{openWorkbench && <button className="open" onClick={() => openWorkbench(openView)}>在学习工作台打开</button>}</div>
      {body}
      <LinkChips links={value.links} openWorkbench={openWorkbench} openExternal={openExternal} />
    </div>
  );
}
