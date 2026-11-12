import React from 'react';
import { createRoot } from 'react-dom/client';
import workbenchCss from './workbench.css';
import * as flowChunk from './chunk-flow.jsx';
import * as mindmapChunk from './chunk-mindmap.jsx';
import * as gridChunk from './chunk-grid.jsx';
import * as calendarChunk from './chunk-calendar.jsx';
import { setChunkLoader } from './chunks.jsx';
const css = `${mindmapChunk.css}\n${flowChunk.css}\n${gridChunk.css}\n${workbenchCss}`;
import { Workbench } from './Workbench.jsx';
// The harness bundles the view chunks statically (DSH loads them on demand from lib/client.<name>.js).
setChunkLoader((name) => ({ flow: flowChunk, mindmap: mindmapChunk, grid: gridChunk, calendar: calendarChunk })[name]);
import { TutorToolCard } from './ToolCard.jsx';
import { installTutorLinks, viewFor } from './link-intercept.mjs';

/** Standalone harness (same component, same RPC envelope) for e2e tests and design comparison outside DSH. */
const style = document.createElement('style');
style.textContent = css + '\nhtml,body,#root{height:100%;margin:0}';
document.head.append(style);
let seq = 0;
const api = {
  async call(method, payload) {
    const res = await fetch('/api/dsh-oh-my-ai-tutor', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `r${++seq}`, method: 'dsh-oh-my-ai-tutor', payload: { method, payload } }) });
    const msg = await res.json();
    if (!msg.result.ok) { const e = new Error(msg.result.error.message); e.code = msg.result.error.code; throw e; }
    return msg.result.value;
  },
};
const params = new URLSearchParams(location.search);
window.__tutorApi = api;
window.__TutorToolCard = TutorToolCard;
window.__React = React;
window.__createRoot = createRoot;
// Same link interception as in DSH; the harness has one workbench, so "open the tab" = re-render it with a new navigation.
const root = createRoot(document.getElementById('root'));
let nav = { view: params.get('view') ?? undefined, focus: undefined, revision: 0 };
window.__tutorOpened = [];
const openWorkbench = (view, focus) => { nav = { view: view ?? nav.view, focus: focus ? { ...focus, nonce: Date.now() } : undefined, revision: nav.revision + 1 }; window.__tutorOpened.push({ view, focus }); render(); };
window.__tutorOpenWorkbench = openWorkbench;
window.__tutorExternal = [];
const openExternal = (url) => { window.__tutorExternal.push(url); };
window.__tutorAdded = [];
const onAddToChat = (resource) => { window.__tutorAdded.push(resource); return true; };
function render() {
  root.render(<Workbench api={api} initialView={nav.view} focus={nav.focus} navRevision={nav.revision} pollMs={Number(params.get('poll') ?? 1000)} openExternal={openExternal} onAddToChat={onAddToChat} />);
}
installTutorLinks((link) => openWorkbench(viewFor(link), link));
render();
