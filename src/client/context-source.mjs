// DSH @ source 「学习资源」and programmatic composer insert (「添加到对话」).
import {
  SOURCE_NAME, clipboardTextFor, decodeRef, filterCatalog, lexiconNames, makeReferenceInsert,
} from '../context-ref.mjs';
import { viewFor } from './link-intercept.mjs';

let activeCourseId = null;
const lexiconListeners = new Set();

export function setActiveCourseId(id) {
  if (activeCourseId === id) return;
  activeCourseId = id;
  for (const fn of lexiconListeners) fn();
}

export function getActiveCourseId() { return activeCourseId; }

/**
 * Insert a tutor-resource chip into the current session composer without sending.
 * Uses the session-scoped `slash/input-insert-reference` event (same path as an @ pick).
 * Caret comes from the input shell when available; otherwise the chip is appended at the end of the draft.
 */
export function insertTutorReference(ctx, sessionId, resource) {
  const sessions = ctx.sessions ?? ctx.get?.('sessions');
  const conversation = ctx.conversation ?? ctx.get?.('conversation');
  if (!sessionId) throw new Error('当前没有打开的对话，无法添加到输入框。');
  const actx = sessions?.scope?.(sessionId);
  if (!actx) throw new Error('当前对话还没有就绪，无法添加到输入框。');
  const input = conversation?.input?.for?.(actx);
  if (!input) throw new Error('无法访问当前对话的输入框。');
  const insert = makeReferenceInsert(resource);
  const snap = input.state?.getSnapshot?.();
  const caret = typeof input.caretSpan === 'function' ? input.caretSpan() : null;
  const atEnd = snap ? (typeof snap.draft === 'string' ? snap.draft.length : 0) : 0;
  const span = {
    start: caret?.start ?? atEnd,
    end: caret?.end ?? atEnd,
    draftRev: snap?.draftRev ?? 0,
  };
  const applied = (typeof actx.bail === 'function' && actx.bail(actx, 'slash/input-insert-reference', { reference: insert, span }) === true)
    || input.insertReference?.(insert, span) === true;
  if (!applied) throw new Error('现在不能添加到对话（可能正在发送）。');
  input.focus?.();
  return true;
}

function rowsToCandidates(items) {
  return items.map((it) => ({
    name: it.name,
    label: `${it.section}·${it.title}`,
    description: it.id,
    section: it.section,
    value: encodeURIComponent(JSON.stringify({ kind: it.kind, id: it.id, courseId: it.courseId, title: it.title })),
    icon: 'file',
  }));
}

async function fetchCatalog(api, courseId, signal) {
  const out = await api.call('contextCatalog', { courseId: courseId ?? undefined }, signal);
  return out;
}

/**
 * Register the @ 「学习资源」source. `apiFor(sessionId)` is the same RPC helper the workbench uses.
 * `openWorkbench(view, focus)` reuses the existing link-intercept jump.
 */
export function registerTutorInputSource(ctx, { apiFor, openWorkbench, getSessionId }) {
  const inputTriggers = ctx.inputTriggers ?? ctx.get?.('inputTriggers');
  if (!inputTriggers?.registerSource) return () => {};

  const cache = new Map(); // sessionId -> { courseId, items, revision }
  const notify = () => { for (const fn of lexiconListeners) fn(); };

  const load = async (sessionId, signal) => {
    const api = apiFor(sessionId);
    const out = await fetchCatalog(api, activeCourseId, signal);
    cache.set(sessionId, { courseId: out.courseId, items: out.items ?? [], revision: out.revision });
    notify();
    return out.items ?? [];
  };

  const source = {
    trigger: '@',
    name: SOURCE_NAME,
    order: 8,
    async candidates(session, { query, signal }) {
      let items;
      try { items = await load(session.sessionId, signal); }
      catch { return []; }
      if (signal.aborted || !items.length) return [];
      return rowsToCandidates(filterCatalog(items, query));
    },
    onPick({ candidate }) {
      if (!candidate?.value) return undefined;
      let resource;
      try { resource = JSON.parse(decodeURIComponent(candidate.value)); } catch { return undefined; }
      return { insert: makeReferenceInsert(resource) };
    },
    warm(session) { load(session.sessionId).catch(() => {}); },
    lexicon(session) {
      const entry = cache.get(session.sessionId);
      if (!entry) return undefined;
      return lexiconNames(entry.items);
    },
    subscribeLexicon(_session, listener) {
      lexiconListeners.add(listener);
      return () => lexiconListeners.delete(listener);
    },
    openReference(_session, { ref }) {
      const parsed = decodeRef(ref);
      if (!parsed) return false;
      openWorkbench(viewFor(parsed), parsed);
      return true;
    },
    codec: {
      clipboardText: (ref) => clipboardTextFor(ref) || String(ref ?? ''),
      async serialize(ref, signal) {
        const sid = getSessionId?.();
        const parsed = decodeRef(ref);
        try {
          const out = await apiFor(sid).call('contextSerialize', { ref }, signal);
          if (!out?.text) throw new Error('学习资源序列化为空');
          return out.text;
        } catch (err) {
          if (signal?.aborted) throw err;
          const label = parsed ? `${parsed.kind}:${parsed.id}` : ref;
          throw new Error(err?.message || `学习资源不存在：${label}`);
        }
      },
    },
  };

  return inputTriggers.registerSource(source);
}
