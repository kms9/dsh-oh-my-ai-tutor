import React from 'react';
import { createRoot } from 'react-dom/client';
import css from './workbench.css';
import { Workbench } from './Workbench.jsx';
import { TutorToolCard } from './ToolCard.jsx';

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
createRoot(document.getElementById('root')).render(<Workbench api={api} initialView={params.get('view') ?? undefined} pollMs={Number(params.get('poll') ?? 1000)} />);
