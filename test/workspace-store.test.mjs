// Route B: learning state under $DSH_HOME/oh-my-ai-tutor/<workspace-key>/, never process.cwd(), never a project-local .oh-my-ai-tutor.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TutorStoreHub, normalizeWorkspacePath, workspaceKey, fingerprint, strongFingerprintMatch, lookupOrCreate, readRegistry, tutorHome } from '../src/workspace-store.mjs';
import { toolSpecs } from '../src/tools.mjs';
import { createRpcHandler, ENDPOINT, dispatch } from '../src/rpc.mjs';

async function tmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'omt-ws-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
function gitInit(dir, remote = 'https://example.com/lesson.git') {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ws-demo' }));
}
function sessionsFor(map) {
  const list = Object.entries(map).map(([id, cwd]) => ({ id, header: { cwd } }));
  return { get: (id) => list.find((s) => s.id === id), list: () => list };
}

test('normalizeWorkspacePath: absolute only; never resolves against process.cwd()', async () => {
  assert.equal(normalizeWorkspacePath('relative/path'), null);
  assert.equal(normalizeWorkspacePath(''), null);
  assert.equal(normalizeWorkspacePath(process.cwd().replace(/^\//, '')), null);
  await tmp(async (dir) => {
    const real = normalizeWorkspacePath(dir);
    assert.equal(real, dir);
    const missing = normalizeWorkspacePath(join(dir, 'gone'));
    assert.ok(missing.endsWith('/gone'));
  });
});

test('isolation: workspace A cannot see B; the same path (web or headless) shares one file; no workspace → global fallback', () => tmp(async (home) => {
  const a = join(home, 'proj-a'), b = join(home, 'proj-b');
  await mkdir(a); await mkdir(b);
  const sessions = sessionsFor({ sa: a, sb: b });
  const hub = new TutorStoreHub({}, { home, sessions: () => sessions });
  const toolsA = Object.fromEntries(toolSpecs((exec) => hub.resolveFromExec(exec)).map((t) => [t.name, t]));
  const wa = async (action, payload) => toolsA.tutor_write.execute({ action, payload_json: JSON.stringify(payload) }, { agent: { sessionId: 'sa' } });
  const g = (await wa('goal.create', { title: 'A 的目标', expectedOutcome: '会' })).result;
  await wa('course.create', { goalId: g.id, title: 'A 的课' });
  const readA = await toolsA.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  const readB = await toolsA.tutor_read.execute({}, { agent: { sessionId: 'sb' } });
  const readG = await toolsA.tutor_read.execute({}, {}); // no session
  assert.equal(readA.courses.length, 1);
  assert.equal(readA.courses[0].title, 'A 的课');
  assert.equal(readB.courses.length, 0, 'opening B does not see A\'s courses');
  assert.equal(readG.workspace.kind, 'global');
  assert.equal(readG.courses.length, 0, 'unclaimed global stays empty; A was copied only if it was the first claim of a pre-existing global');
  assert.equal(readA.workspace.kind, 'workspace');
  assert.equal(readA.workspace.path, a);
  assert.equal(readB.workspace.path, b);
  assert.ok(readA.workspace.key !== readB.workspace.key);
  // same workspace, two "processes" (two hubs, same home) share the file
  const headless = new TutorStoreHub({}, { home, sessions: () => sessions });
  const toolsH = Object.fromEntries(toolSpecs((exec) => headless.resolveFromExec(exec)).map((t) => [t.name, t]));
  const again = await toolsH.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  assert.equal(again.courses[0].title, 'A 的课');
  assert.equal(again.workspace.key, readA.workspace.key);
  // the store is under $home/<key>/tutor.db, never a .oh-my-ai-tutor inside the project
  assert.equal((await readdir(a)).includes('.oh-my-ai-tutor'), false);
  const key = readA.workspace.key;
  assert.ok(existsSync(join(home, key, 'tutor.db')));
  hub.close(); headless.close();
}));

test('configured dbPath wins and is shared regardless of session cwd', () => tmp(async (home) => {
  const db = join(home, 'custom', 'tutor.db');
  const a = join(home, 'wa'), b = join(home, 'wb');
  await mkdir(a); await mkdir(b);
  const hub = new TutorStoreHub({ dbPath: db }, { home, sessions: () => sessionsFor({ sa: a, sb: b }) });
  const tools = Object.fromEntries(toolSpecs((e) => hub.resolveFromExec(e)).map((t) => [t.name, t]));
  const g = (await tools.tutor_write.execute({ action: 'goal.create', payload_json: JSON.stringify({ title: 'g', expectedOutcome: 'o' }) }, { agent: { sessionId: 'sa' } })).result;
  await tools.tutor_write.execute({ action: 'course.create', payload_json: JSON.stringify({ goalId: g.id, title: '同一库' }) }, { agent: { sessionId: 'sb' } });
  const ra = await tools.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  const rb = await tools.tutor_read.execute({}, { agent: { sessionId: 'sb' } });
  assert.equal(ra.workspace.kind, 'configured');
  assert.equal(ra.courses.length, 1);
  assert.equal(rb.courses.length, 1);
  assert.ok(existsSync(db));
  hub.close();
}));

test('explicit migration: first workspace to open copies the existing global db (backup 0600); later workspaces stay empty; global file remains', () => tmp(async (home) => {
  // pre-seed a global tutor.db the way today's install looks
  const globalHub = new TutorStoreHub({}, { home, sessions: () => null });
  const gt = Object.fromEntries(toolSpecs((e) => globalHub.resolveFromExec(e)).map((t) => [t.name, t]));
  const g = (await gt.tutor_write.execute({ action: 'goal.create', payload_json: JSON.stringify({ title: '旧全局目标', expectedOutcome: '会' }) })).result;
  await gt.tutor_write.execute({ action: 'course.create', payload_json: JSON.stringify({ goalId: g.id, title: '旧全局课' }) });
  const before = await gt.tutor_read.execute({});
  assert.equal(before.workspace.kind, 'global');
  assert.equal(before.courses[0].title, '旧全局课');
  const globalPath = join(home, 'tutor.db');
  globalHub.close();

  const a = join(home, 'first-ws'), b = join(home, 'second-ws');
  await mkdir(a); await mkdir(b);
  const hub = new TutorStoreHub({}, { home, sessions: () => sessionsFor({ sa: a, sb: b }) });
  const tools = Object.fromEntries(toolSpecs((e) => hub.resolveFromExec(e)).map((t) => [t.name, t]));
  const ra = await tools.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  assert.equal(ra.courses[0].title, '旧全局课');
  assert.equal(ra.workspace.fromGlobal, true);
  const reg = readRegistry(home);
  assert.equal(reg.global.claimedBy.key, ra.workspace.key);
  assert.ok(reg.global.claimedBy.backup);
  const st = await stat(reg.global.claimedBy.backup);
  assert.equal(st.mode & 0o777, 0o600, 'claim backup is owner-only');
  // global file is still there with the same course (copy, not move)
  const stillGlobal = await tools.tutor_read.execute({}, {});
  assert.equal(stillGlobal.workspace.kind, 'global');
  assert.equal(stillGlobal.courses[0].title, '旧全局课');
  // a second workspace does not get another copy
  const rb = await tools.tutor_read.execute({}, { agent: { sessionId: 'sb' } });
  assert.equal(rb.courses.length, 0);
  assert.notEqual(rb.workspace.key, ra.workspace.key);
  // reopening A does not re-copy or lose data
  const ra2 = await tools.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  assert.equal(ra2.courses[0].title, '旧全局课');
  hub.close();
}));

test('rename recognition: same git remote, old path gone → reuse the bucket; a living copy gets its own empty bucket', () => tmp(async (home) => {
  const a = join(home, 'original');
  await mkdir(a);
  gitInit(a, 'https://github.com/demo/algebra.git');
  const sessions = sessionsFor({ sa: a });
  const hub = new TutorStoreHub({}, { home, sessions: () => sessions });
  const tools = Object.fromEntries(toolSpecs((e) => hub.resolveFromExec(e)).map((t) => [t.name, t]));
  const g = (await tools.tutor_write.execute({ action: 'goal.create', payload_json: JSON.stringify({ title: '代数', expectedOutcome: '会' }) }, { agent: { sessionId: 'sa' } })).result;
  await tools.tutor_write.execute({ action: 'course.create', payload_json: JSON.stringify({ goalId: g.id, title: '代数课' }) }, { agent: { sessionId: 'sa' } });
  const first = await tools.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  const key = first.workspace.key;
  hub.close();

  const moved = join(home, 'renamed');
  await rename(a, moved);
  const hub2 = new TutorStoreHub({}, { home, sessions: () => sessionsFor({ sa: moved }) });
  const t2 = Object.fromEntries(toolSpecs((e) => hub2.resolveFromExec(e)).map((t) => [t.name, t]));
  const after = await t2.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  assert.equal(after.workspace.key, key, 'the renamed folder keeps the same bucket');
  assert.equal(after.courses[0].title, '代数课');
  assert.equal(after.workspace.adoptedFrom, a);
  const rec = readRegistry(home).workspaces.find((w) => w.key === key);
  assert.equal(rec.path, moved);
  assert.equal(rec.adoptedFrom.reason, 'git-remote');
  hub2.close();

  // a clone (old path "still there" after we put a copy back) must not steal the bucket
  await mkdir(a);
  gitInit(a, 'https://github.com/demo/algebra.git');
  const hub3 = new TutorStoreHub({}, { home, sessions: () => sessionsFor({ sa: a, sm: moved }) });
  const t3 = Object.fromEntries(toolSpecs((e) => hub3.resolveFromExec(e)).map((t) => [t.name, t]));
  const clone = await t3.tutor_read.execute({}, { agent: { sessionId: 'sa' } });
  const origin = await t3.tutor_read.execute({}, { agent: { sessionId: 'sm' } });
  assert.equal(origin.courses[0].title, '代数课');
  assert.equal(clone.courses.length, 0, 'the living original is not mixed into the clone');
  assert.notEqual(clone.workspace.key, origin.workspace.key);
  assert.equal(clone.workspace.copySuspect, true);
  hub3.close();
}));

test('strong fingerprints: shared git remote matches; top-level names alone do not', () => tmp(async (dir) => {
  const a = join(dir, 'a'), b = join(dir, 'b'), c = join(dir, 'c');
  await mkdir(a); await mkdir(b); await mkdir(c);
  gitInit(a, 'https://github.com/demo/x.git');
  gitInit(b, 'git@github.com:demo/x.git'); // same remote, different form
  writeFileSync(join(c, 'README.md'), 'x'); writeFileSync(join(c, 'package.json'), JSON.stringify({ name: 'unrelated' }));
  const fa = fingerprint(a), fb = fingerprint(b), fc = fingerprint(c);
  assert.ok(strongFingerprintMatch(fa, fb), 'https and scp-style remotes of the same repo match');
  assert.ok(!strongFingerprintMatch(fa, fc), 'a coincidental top-level file list is not a strong match');
}));

test('tutorHome follows DSH_HOME, not the process working directory', () => {
  const home = tutorHome({ DSH_HOME: '/tmp/dsh-home-test' });
  assert.equal(home, '/tmp/dsh-home-test/oh-my-ai-tutor');
  assert.ok(!home.includes(process.cwd()) || process.cwd() === '/tmp/dsh-home-test');
});

test('workbench RPC: no live session → global; one live workspace (even without sessionId) → that bucket; explicit sessionId wins', () => tmp(async (home) => {
  const a = join(home, 'rpc-a'); await mkdir(a);
  const empty = new TutorStoreHub({}, { home, sessions: () => sessionsFor({}) });
  const handler0 = createRpcHandler((payload) => empty.resolveForWorkbench({ sessionId: payload?.sessionId ?? payload?.payload?.sessionId }));
  const call = (hubHandler) => async (method, payload, sessionId) => {
    const res = await hubHandler(new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: ENDPOINT, payload: { method, payload, sessionId } }) }));
    return (await res.json()).result;
  };
  const none = await call(handler0)('workbench', {});
  assert.equal(none.ok, true);
  assert.equal(none.value.workspace.kind, 'global');
  empty.close();
  const hub = new TutorStoreHub({}, { home, sessions: () => sessionsFor({ sa: a }) });
  const handler = createRpcHandler((payload) => hub.resolveForWorkbench({ sessionId: payload?.sessionId ?? payload?.payload?.sessionId }));
  const implied = await call(handler)('workbench', {});
  assert.equal(implied.value.workspace.kind, 'workspace');
  assert.equal(implied.value.workspace.path, a, 'a single live session is enough for the workbench to pick that workspace');
  const ws = await call(handler)('workbench', {}, 'sa');
  assert.equal(ws.value.workspace.kind, 'workspace');
  assert.equal(ws.value.workspace.path, a);
  hub.close();
}));
