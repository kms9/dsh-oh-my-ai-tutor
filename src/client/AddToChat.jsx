import React, { useState } from 'react';

/** Workbench action that inserts a tutor-resource chip into the composer (does not send). */
export function AddToChatButton({ resource, onAddToChat, testId = 'add-to-chat', label: idleLabel = '添加到对话', variant = 'button' }) {
  const [state, setState] = useState('idle'); // idle | ok | err
  if (!onAddToChat || !resource?.id) return null;
  const label = state === 'ok' ? '已添加' : state === 'err' ? '未添加' : idleLabel;
  return (
    <button type="button" className={`${variant === 'link' ? 'linkbtn small' : 'tbtn'}${state === 'ok' ? ' on' : ''}`} data-testid={testId} data-kind={resource.kind}
      title="把这个对象加到当前对话的输入框，发送后 AI 会读到它的当前内容"
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const ok = await onAddToChat(resource);
          setState(ok === false ? 'err' : 'ok');
        } catch { setState('err'); }
        setTimeout(() => setState('idle'), 1600);
      }}>{label}</button>
  );
}
