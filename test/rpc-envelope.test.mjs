// The workbench RPC must answer in the envelope DSH's connection client accepts (dsh-client-connection
// parseConnectionResponse, @deepseek-ai/dsh 0.2.1-rc.2). Found in real DSH: failures without `details` became
// "connection: invalid server-response failure", so the learner never saw the CAS-conflict notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonTutorStore } from '../src/store.mjs';
import { createRpcHandler, ENDPOINT } from '../src/rpc.mjs';

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Same checks as DSH's parseConnectionResponse. */
function parseLikeDsh(value) {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') throw new TypeError('connection: invalid server-response envelope');
  const result = value.result;
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result');
  if (result.ok === true) return result;
  if (result.ok !== false || !isRecord(result.error)) throw new TypeError('connection: invalid server-response result');
  const e = result.error;
  if (typeof e.code !== 'string' || typeof e.message !== 'string' || !isRecord(e.details)) throw new TypeError('connection: invalid server-response failure');
  return result;
}

test('rpc failures (CAS conflict, forbidden action) pass DSH envelope validation and keep code + revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omt-rpc-'));
  try {
    const statePath = join(dir, 'state.json');
    await copyFile(new URL('./fixtures/spaced-repetition.state.json', import.meta.url), statePath);
    const store = new JsonTutorStore(statePath);
    const handler = createRpcHandler(store);
    const call = async (payload) => {
      const res = await handler(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: ENDPOINT, payload }) }));
      return parseLikeDsh(await res.json());
    };
    const ok = await call({ method: 'head' });
    assert.equal(ok.ok, true);
    const st = await store.read();
    const cid = Object.keys(st.courses)[0];
    const conflict = await call({ method: 'mutate', payload: { action: 'board.seed', input: { courseId: cid, baseRevision: 999 } } });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'tutor/conflict');
    assert.ok(Number.isInteger(conflict.error.details.boardRevision));
    const course = st.courses[cid];
    for (const [action, input] of [
      ['course.editOutline', { courseId: cid, syllabusRevision: course.syllabus.revision + 99, operations: [{ op: 'renameTopic', topicId: course.syllabus.topics?.[0]?.id ?? 'x', title: 'x' }] }],
      ['course.approve', { courseId: cid, syllabusRevision: course.syllabus.revision + 99 }],
    ]) {
      const r = await call({ method: 'mutate', payload: { action, input } });
      assert.equal(r.ok, false, action);
      assert.equal(r.error.code, 'tutor/conflict', action);
      assert.equal(r.error.details.syllabusRevision, course.syllabus.revision, action);
    }
    const forbidden = await call({ method: 'mutate', payload: { action: 'lesson.start', input: {} } });
    assert.equal(forbidden.ok, false);
    assert.equal(typeof forbidden.error.message, 'string');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
