import { snapshot } from './core.mjs';
import { projectCourse } from './projections.mjs';

export const ENDPOINT = 'dsh-oh-my-ai-tutor';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Learner-initiated writes allowed from the workbench UI. Assessments stay in the conversation (real answers only). */
export const LEARNER_ACTIONS = Object.freeze([
  'course.editOutline', 'course.approve', 'lesson.approve', 'board.seed', 'board.patch', 'relation.propose', 'note.add',
]);

/** One UI read model: everything the three-column workbench needs, derived from the same state file. */
export function workbenchModel(state, courseId) {
  const top = snapshot(state);
  const courses = top.courses.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const chosen = courseId && state.courses[courseId] ? state.courses[courseId] : courses[0];
  if (!chosen) return { revision: state.revision, courses: [], course: null };
  const data = snapshot(state, chosen.id);
  const goal = state.goals[chosen.goalId] ?? null;
  const conceptIds = new Set(data.concepts.map((c) => c.id));
  const events = state.events.slice(-40).reverse().map((e) => ({ ...e }));
  return {
    revision: state.revision,
    courses: courses.map((c) => ({ id: c.id, title: c.title, status: c.status })),
    goal, course: data.course, concepts: data.concepts, relations: data.relations.filter((r) => conceptIds.has(r.from) && conceptIds.has(r.to)),
    lessons: data.lessons, notes: data.notes, assessments: data.assessments, sources: data.sources,
    views: {
      outline: projectCourse(state, chosen.id, 'outline'),
      mindmap: projectCourse(state, chosen.id, 'mindmap'),
      graph: projectCourse(state, chosen.id, 'graph'),
      board: projectCourse(state, chosen.id, 'board'),
    },
    events,
  };
}

/** Host fetch handler, same envelope as dsh-whiteboard's `/api/dsh-whiteboard` route (ctx.connection.rpc.call). */
export function createRpcHandler(store) {
  return async (request) => {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return new Response('Expected application/json', { status: 415 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return new Response('Request too large', { status: 413 });
    let message;
    try { message = JSON.parse(raw); } catch { return new Response('Invalid JSON', { status: 400 }); }
    const reply = (result) => Response.json({ type: 'server-response', rpcId: message?.rpcId ?? 'invalid', result });
    try {
      if (message?.type !== 'client-request' || message.method !== ENDPOINT || typeof message.rpcId !== 'string') throw new Error('Invalid request envelope');
      return reply({ ok: true, value: await dispatch(store, message.payload ?? {}) });
    } catch (error) {
      const code = error.code === 'conflict' ? 'tutor/conflict' : error.code === 'forbidden' ? 'tutor/forbidden' : 'tutor/request-failed';
      // DSH's connection client (dsh-client-connection parseConnectionResponse) only accepts a failure with
      // string code, string message AND a `details` object; without `details` every error, conflicts included,
      // surfaces as "connection: invalid server-response failure".
      const details = {
        ...(Number.isInteger(error.syllabusRevision) ? { syllabusRevision: error.syllabusRevision } : {}),
        ...(Number.isInteger(error.boardRevision) ? { boardRevision: error.boardRevision } : {}),
        ...(Number.isInteger(error.todoRevision) ? { todoRevision: error.todoRevision } : {}),
        ...(Number.isInteger(error.reviewRevision) ? { reviewRevision: error.reviewRevision } : {}),
      };
      return reply({ ok: false, error: { code, message: String(error.message ?? 'request failed'), details, ...details } });
    }
  };
}

export async function dispatch(store, { method, payload = {} }) {
  if (method === 'head') return store.head();
  if (method === 'workbench') return workbenchModel(await store.read(), payload.courseId);
  if (method === 'data') {
    if (typeof store.data !== 'function') throw new Error('数据面板需要 SQLite 存储（当前是 JSON 存储）');
    return store.data(String(payload.query ?? ''), payload.params ?? {});
  }
  if (method === 'review') {
    if (typeof store.review !== 'function') throw new Error('复习排期需要 SQLite 存储（当前是 JSON 存储）');
    const { conceptId, cardId, rating, baseRevision } = payload.input ?? {};
    return store.review({ conceptId, cardId, rating, baseRevision }, { actor: 'learner' });
  }
  if (method === 'todo') {
    if (typeof store.todo !== 'function') throw new Error('待办需要 SQLite 存储（当前是 JSON 存储）');
    if (!['create', 'update'].includes(payload.op)) throw new Error('todo op must be create | update');
    return store.todo(payload.op, payload.input ?? {}, { actor: 'learner' });
  }
  if (method === 'mutate') {
    if (!LEARNER_ACTIONS.includes(payload.action)) throw new Error(`Action not allowed from the workbench: ${payload.action}`);
    const out = await store.mutate(payload.action, payload.input ?? {}, payload.expectedRevision, { actor: 'learner', summary: payload.summary });
    return { revision: out.revision, result: out.result };
  }
  throw new Error('Unknown tutor workbench method');
}
