import React from 'react';
import workbenchCss from './workbench.css';
const css = workbenchCss;
import { Workbench } from './Workbench.jsx';
import { setChunkLoader } from './chunks.jsx';
/* global __omtRequireAsync -- the host module loader's require.async, captured by the bundle banner (scripts/build.mjs) */
import { TutorToolCard } from './ToolCard.jsx';

export const name = 'dsh-oh-my-ai-tutor';
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection'];
const KIND = 'tutor-workbench';
const TAB_ID = 'dsh-oh-my-ai-tutor'; // pane/title slots are keyed by the tab type id (SidebarRight entryKey = definition.id)
const CARD_TOOLS = ['tutor_visualize', 'tutor_outline_edit', 'tutor_board_patch', 'tutor_board_read'];

/** Browser half: right-sidebar "AI 学习工作台" tab + graphic tool cards in the conversation (dsh-whiteboard's mounting pattern). */
export function apply(ctx) {
  const style = document.createElement('style');
  style.dataset.dshOhMyAiTutor = 'true';
  style.textContent = css;
  ctx.effect(() => { document.head.append(style); return () => { style.remove(); document.querySelectorAll('style[data-dsh-oh-my-ai-tutor-chunk]').forEach((el) => el.remove()); }; });
  // Heavy views are package-local chunks (lib/client.flow.js, lib/client.mindmap.js), loaded on first use.
  // Their CSS goes in BEFORE the workbench styles so ours still win at equal specificity.
  setChunkLoader(async (name) => {
    if (typeof __omtRequireAsync !== 'function') throw new Error('host module loader has no require.async');
    const mod = await __omtRequireAsync(`./client.${name}.js`);
    if (mod.css && !document.querySelector(`style[data-dsh-oh-my-ai-tutor-chunk="${name}"]`)) {
      const el = document.createElement('style'); el.dataset.dshOhMyAiTutorChunk = name; el.textContent = mod.css;
      document.head.insertBefore(el, style.isConnected ? style : null);
    }
    return mod;
  });

  const api = {
    async call(method, payload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('学习状态请求超时（10 秒）')), 10000);
      try {
        const result = await ctx.connection.rpc.call('/api', 'dsh-oh-my-ai-tutor', { method, payload }, controller.signal);
        if (!result.ok) { const e = new Error(result.error.message); e.code = result.error.code; throw e; }
        return result.value;
      } finally { clearTimeout(timer); }
    },
  };
  const openWorkbench = (view) => ctx.sidebarRight.openTab(KIND, { params: { view } });

  function Body({ useTabInfo }) {
    const info = useTabInfo();
    const params = info.tab.navigation?.params ?? {};
    return <Workbench api={api} visible={info.tab.visible !== false} initialView={params.view} navRevision={info.tab.navigation?.revision} />;
  }
  function Title() { return 'AI 学习工作台'; }
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID, kind: KIND, priority: 'extension', keepMounted: true, title: () => 'AI 学习工作台',
    guide: [{ id: 'tutor-workbench', order: 40, title: () => 'AI 学习工作台', description: () => '课程大纲、思维导图、知识图谱与白板，你和 AI 一起编辑' }],
  }));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, Body)));
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, Title)));
  function Card(props) { return <TutorToolCard {...props} openWorkbench={openWorkbench} />; }
  for (const tool of CARD_TOOLS) {
    ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: tool }, Card)));
  }
}
