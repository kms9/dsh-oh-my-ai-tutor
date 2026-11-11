// End-to-end: real "间隔重复" state → standalone workbench (same component + RPC as the DSH sidebar tab).
// Covers manual + AI edits of outline, mind map and board, CAS conflicts, chat cards, and restart recovery.
// Usage: node test/e2e/workbench.e2e.mjs [--state fixture.json] [--out dir] [--port 4181]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { JsonTutorStore } from '../../src/store.mjs';
import { toolSpecs } from '../../src/tools.mjs';
import { validateState } from '../../src/core.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const fixture = arg('--state', join(root, 'test/fixtures/spaced-repetition.state.json'));
const out = arg('--out', join(root, '.e2e-out'));
const port = Number(arg('--port', 4181));
const shots = join(out, 'shots');
await mkdir(shots, { recursive: true });
const statePath = join(out, 'tutor-state.json');
await copyFile(fixture, statePath);
const store = new JsonTutorStore(statePath);
const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
const readState = async () => validateState(JSON.parse(await readFile(statePath, 'utf8')));
const results = [];
const t0 = Date.now();

function startServer() {
  const child = spawn(process.execPath, [join(root, 'scripts/workbench-server.mjs'), '--state', statePath, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('workbench harness')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`harness exited ${code}`)));
    setTimeout(() => reject(new Error('harness start timeout')), 8000);
  });
}
async function step(name, fn) {
  const s = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - s }); console.log(`ok   ${name} (${Date.now() - s} ms)`); }
  catch (e) { results.push({ name, ok: false, ms: Date.now() - s, error: e.message }); console.log(`FAIL ${name}: ${e.message}`); await page.screenshot({ path: join(shots, `FAIL-${results.length}.png`) }).catch(() => {}); }
}
async function eventually(fn, ms = 4000) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 150)); } }
  throw last;
}
const course = async () => Object.values((await readState()).courses)[0];
const topics = async () => (await course()).syllabus.topics;

let server = await startServer();
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'America/Phoenix' });
let page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && pageErrors.push(m.text()));
const url = `http://127.0.0.1:${port}/`;
await page.goto(url);
await page.waitForSelector('[data-testid=tutor-workbench]');
const tab = async (k) => { await page.click(`#omt-tab-${k}`); await page.waitForTimeout(150); };
const cid = (await course()).id;

await step('initial render reads the real state (no hard-coded ZPD lesson)', async () => {
  const st = await readState();
  const lesson = Object.values(st.lessons)[0];
  assert.equal(await page.textContent('[data-testid=lesson-title]'), lesson.title);
  const body = await page.textContent('[data-testid=lesson-body]');
  assert.ok(body.includes('1932'), 'lesson body shows the real part text');
  assert.ok(!(await page.textContent('body')).includes('ZPD'), 'no design-fixture ZPD text');
  assert.equal(await page.locator('[data-testid=sidebar-toc] button.sub').count(), 15);
  assert.equal(await page.locator('[data-testid=review-box] .qa').count(), Object.keys(st.assessments).length);
  await page.screenshot({ path: join(shots, '01-initial-graph.png') });
});

await step('graph renders all 15 nodes inside the canvas (adaptive layout)', async () => {
  await tab('graph');
  assert.equal(await page.locator('[data-testid=graph-svg] g.node').count(), 15);
  const box = await page.locator('[data-testid=graph-svg]').evaluate((svg) => {
    const vb = svg.viewBox.baseVal; const rects = [...svg.querySelectorAll('g.node rect:first-child')];
    return { ok: rects.every((r) => +r.getAttribute('x') + +r.getAttribute('width') <= vb.width && +r.getAttribute('y') + +r.getAttribute('height') <= vb.height), vb: [vb.width, vb.height] };
  });
  assert.ok(box.ok, `nodes outside viewBox ${box.vb}`);
  assert.equal(await page.locator('[data-testid=graph-svg] [data-edge-id]').count(), 1);
});

await step('outline: manual rename (double-click inline edit)', async () => {
  await tab('outline');
  const t = (await topics())[0];
  await page.dblclick(`[data-topic-id="${t.id}"] .tophead .grow`);
  await page.fill('[data-testid=inline-edit]', '什么是间隔重复（学习者改）');
  await page.keyboard.press('Enter');
  await eventually(async () => assert.equal((await topics())[0].title, '什么是间隔重复（学习者改）'));
  await page.waitForSelector('text=什么是间隔重复（学习者改）');
  assert.equal((await course()).status, 'draft');
  assert.equal((await readState()).events.at(-1).actor, 'learner');
});

await step('outline: manual reorder (↓ button) and cross-topic drag', async () => {
  const before = await topics();
  const sub = before[2].subtopics[0];
  await page.hover(`[data-subtopic-id="${sub.id}"]`);
  await page.click(`[data-subtopic-id="${sub.id}"] button[title=下移]`);
  await eventually(async () => assert.equal((await topics())[2].subtopics[1].id, sub.id));
  const mover = (await topics())[3].subtopics[0];
  const target = (await topics())[4].subtopics[1];
  await page.dragAndDrop(`[data-subtopic-id="${mover.id}"]`, `[data-subtopic-id="${target.id}"]`);
  await eventually(async () => {
    const t4 = (await topics())[4];
    assert.equal(t4.subtopics[1].id, mover.id, 'dragged knowledge point lands before the drop target');
  });
  const st = await readState();
  assert.equal(st.concepts[mover.conceptId].topicId, (await topics())[4].id, 'concept id stable, re-parented');
});

await step('outline: manual add + delete knowledge point, then learner approves', async () => {
  const t = (await topics())[1];
  await page.hover(`[data-topic-id="${t.id}"] .tophead`);
  await page.click(`[data-topic-id="${t.id}"] .tophead button[title=添加知识点]`);
  await eventually(async () => assert.equal((await topics())[1].subtopics.at(-1).title, '新知识点'));
  const added = (await topics())[1].subtopics.at(-1);
  await page.hover(`[data-subtopic-id="${added.id}"]`);
  await page.click(`[data-subtopic-id="${added.id}"] button[title=删除知识点]`);
  await eventually(async () => assert.ok(!(await topics())[1].subtopics.some((x) => x.id === added.id)));
  assert.equal((await readState()).concepts[added.conceptId].status, 'retired');
  await page.click('[data-testid=approve-outline]');
  await eventually(async () => { const c = await course(); assert.equal(c.status, 'active'); assert.equal(c.syllabus.approvedBy, 'learner'); });
  await page.screenshot({ path: join(shots, '02-outline-manual.png') });
});

await step('outline: AI edit via tutor_outline_edit is visible in the UI', async () => {
  const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  const r = await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [
    { op: 'renameSubtopic', subtopicId: o.topics[0].subtopics[1].id, title: '适用场景：词汇、事实与概念（AI 改）' },
    { op: 'addSubtopic', topicId: o.topics[1].id, title: '测试效应与提取练习（AI 加）' },
  ] });
  assert.equal(r.applied, 2);
  await page.waitForSelector('text=适用场景：词汇、事实与概念（AI 改）', { timeout: 4000 });
  await page.waitForSelector('text=测试效应与提取练习（AI 加）', { timeout: 4000 });
  await page.waitForSelector('[data-testid=approval-banner] >> text=待你确认');
  assert.match(await page.textContent('[data-testid=activity]'), /AI 编辑大纲\/导图/);
  await page.screenshot({ path: join(shots, '03-outline-after-ai.png') });
});

await step('mind map: manual select → 上移 / 删除 via toolbar', async () => {
  await tab('mindmap');
  const t = (await topics())[2];
  const sub = t.subtopics[2];
  await page.click(`[data-testid=mindmap-svg] [data-node-id="${sub.id}"]`);
  await page.click('[data-testid=mindmap-toolbar] >> text=上移');
  await eventually(async () => assert.equal((await topics())[2].subtopics[1].id, sub.id));
  const del = (await topics())[2].subtopics.at(-1);
  await page.click(`[data-testid=mindmap-svg] [data-node-id="${del.id}"]`);
  await page.click('[data-testid=mindmap-toolbar] >> text=删除');
  await eventually(async () => assert.ok(!(await topics())[2].subtopics.some((x) => x.id === del.id)));
  assert.equal(await page.locator(`[data-testid=mindmap-svg] [data-node-id="${del.id}"]`).count(), 0);
});

await step('mind map: manual drag a node onto another topic (re-parent)', async () => {
  const ts = await topics();
  const src = ts[0].subtopics[0], target = ts[1];
  const a = await page.locator(`[data-testid=mindmap-svg] [data-node-id="${src.id}"] rect`).first().boundingBox();
  const b = await page.locator(`[data-testid=mindmap-svg] [data-node-id="${target.id}"] rect`).first().boundingBox();
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 30, { steps: 5 });
  await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await eventually(async () => assert.equal((await topics())[1].subtopics.at(-1).id, src.id));
  await page.screenshot({ path: join(shots, '04-mindmap-manual.png') });
});

await step('mind map: AI reorders and prunes via tutor_outline_edit; outline view agrees', async () => {
  const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'mindmap' });
  const last = o.hierarchy.children.at(-1);
  const prune = o.hierarchy.children[3].children.at(-1);
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [
    { op: 'moveTopic', topicId: last.id, toIndex: 0 }, { op: 'removeSubtopic', subtopicId: prune.id },
  ] });
  await eventually(async () => {
    const first = await page.locator('[data-testid=mindmap-svg] [data-kind=topic] text').first().textContent();
    assert.equal(first, last.title.slice(0, first.replace('…', '').length) + (first.endsWith('…') ? '…' : ''));
  });
  assert.equal(await page.locator(`[data-testid=mindmap-svg] [data-node-id="${prune.id}"]`).count(), 0);
  await tab('outline');
  assert.match(await page.locator('[data-testid=outline-view] .card b').first().textContent(), new RegExp(`^1\\. ${last.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await tab('mindmap');
  await page.screenshot({ path: join(shots, '05-mindmap-after-ai.png') });
});

await step('board: seed from syllabus (all cards + candidate relation arrow)', async () => {
  await tab('board');
  await page.click('[data-testid=board-seed]');
  const n = (await readState()).concepts;
  const active = Object.values(n).filter((c) => c.status === 'active').length;
  await eventually(async () => assert.equal(await page.locator('[data-testid=board] .boardnode').count(), active));
  assert.equal(await page.locator('[data-testid=board] [data-arrow-id]').count(), 1);
  await page.screenshot({ path: join(shots, '06-board-seeded.png') });
});

await step('board: manual drag moves a card and persists x/y', async () => {
  const el = page.locator('[data-testid=board] .boardnode').nth(1);
  const id = await el.getAttribute('data-element');
  const box = await el.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 60, { steps: 6 }); await page.mouse.move(box.x + 150, box.y + 90, { steps: 6 });
  await page.mouse.up();
  await eventually(async () => {
    const e = (await readState()).boards[cid].elements.find((x) => x.id === id);
    assert.ok(e.x > 22 + 216 + 60 || e.y > 30 + 60, `moved: ${e.x},${e.y}`);
    assert.equal(e.updatedBy, 'learner');
  });
});

await step('board: manual connect two cards, delete a card (cascade), add + edit a note', async () => {
  const cards = page.locator('[data-testid=board] .boardnode');
  const a = await cards.nth(2).getAttribute('data-element'), b = await cards.nth(5).getAttribute('data-element');
  await page.click('[data-testid=board-link]');
  await page.click(`[data-element="${a}"]`); await page.click(`[data-element="${b}"]`);
  await eventually(async () => assert.ok((await readState()).boards[cid].elements.some((e) => e.type === 'arrow' && !e.deleted && e.from === a && e.to === b)));
  await page.click(`[data-element="${a}"]`);
  await page.click('[data-testid=board-delete]');
  await eventually(async () => {
    const els = (await readState()).boards[cid].elements;
    assert.ok(els.find((e) => e.id === a).deleted, 'card tombstoned');
    assert.ok(els.filter((e) => e.type === 'arrow' && (e.from === a || e.to === a)).every((e) => e.deleted), 'arrows cascade');
  });
  await page.click('[data-testid=board-add-note]');
  await page.waitForSelector('[data-testid=board] .boardnode.note');
  await page.dblclick('[data-testid=board] .boardnode.note');
  await page.fill('[data-testid=board] .boardnode.note textarea', '我的复习节奏：1-2-4-8 天');
  await page.keyboard.press('Enter');
  await eventually(async () => assert.ok((await readState()).boards[cid].elements.some((e) => e.type === 'note' && e.text === '我的复习节奏：1-2-4-8 天')));
  await page.screenshot({ path: join(shots, '07-board-manual.png') });
});

await step('board: AI edits via tutor_board_read/patch are visible in the UI', async () => {
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  const note = b.elements.find((e) => e.type === 'note');
  const card = b.elements.find((e) => e.type === 'concept');
  const r = await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [
    { op: 'add', type: 'note', id: 'ai-note-1', text: 'AI：先复习「间隔效应」再看调度算法', x: 480, y: 40, color: '#eef6ff' },
    { op: 'add', type: 'arrow', from: 'ai-note-1', to: card.id, label: '先看' },
    { op: 'update', id: note.id, x: 480, y: 160 },
  ] });
  assert.equal(r.revision, b.revision + 1);
  await page.waitForSelector('text=AI：先复习「间隔效应」再看调度算法', { timeout: 4000 });
  await eventually(async () => assert.equal(await page.locator('[data-testid=board] [data-arrow-id]').count(), 2));
  assert.match(await page.textContent('[data-testid=activity]'), /AI 编辑白板/);
  await page.screenshot({ path: join(shots, '08-board-after-ai.png') });
});

await step('CAS: a stale learner edit is rejected, UI reloads and says so', async () => {
  const slow = await context.newPage();
  await slow.goto(`${url}?view=board&poll=600000`);
  await slow.waitForSelector('[data-testid=board] .boardnode');
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', id: 'ai-note-2', text: 'AI 并发写入', x: 480, y: 280 }] });
  const box = await slow.locator('[data-testid=board] .boardnode').first().boundingBox();
  await slow.mouse.move(box.x + 20, box.y + 20); await slow.mouse.down(); await slow.mouse.move(box.x + 80, box.y + 50, { steps: 5 }); await slow.mouse.up();
  await slow.waitForSelector('[data-testid=notice].err', { timeout: 4000 });
  assert.match(await slow.textContent('[data-testid=notice]'), /刚改过/);
  await slow.waitForSelector('text=AI 并发写入');
  await slow.close();
});

await step('chat tool cards render tool results as graphics (outline/mindmap/graph/board)', async () => {
  const cards = await Promise.all(['outline', 'mindmap', 'graph', 'board'].map(async (view) => ({ view, value: await tools.tutor_visualize.execute({ courseId: cid, view }) })));
  const p2 = await context.newPage();
  await p2.setViewportSize({ width: 820, height: 1400 });
  await p2.goto(url);
  await p2.waitForSelector('[data-testid=tutor-workbench]');
  await p2.evaluate((cards) => {
    document.body.innerHTML = '<div id="cards" style="padding:16px;background:#fff"></div>';
    const R = window.__React, Card = window.__TutorToolCard;
    window.__createRoot(document.getElementById('cards')).render(R.createElement('div', null, cards.map((c, i) =>
      R.createElement(Card, { key: c.view, toolName: 'tutor_visualize', phase: 'result', openWorkbench: () => {},
        block: { callId: `c${i}`, call: { name: 'tutor_visualize', argsRaw: JSON.stringify({ courseId: 'x', view: c.view }) }, content: [{ type: 'text', text: JSON.stringify(c.value) }], isError: false } }))));
  }, cards);
  await p2.waitForSelector('[data-tutor-card=board] .boardnode');
  assert.equal(await p2.locator('[data-tutor-card]').count(), 4);
  assert.ok(await p2.locator('[data-tutor-card=mindmap] svg [data-kind=sub]').count() >= 10);
  assert.ok(await p2.locator('[data-tutor-card=graph] svg g.node').count() >= 10);
  await p2.screenshot({ path: join(shots, '09-chat-cards.png'), fullPage: true });
  await p2.close();
});

await step('restart recovery: kill harness, restart, reload — all edits persist', async () => {
  const before = await readState();
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  server = await startServer();
  await page.reload();
  await page.waitForSelector('[data-testid=tutor-workbench]');
  const after = await readState();
  assert.equal(after.revision, before.revision);
  assert.equal(Number(await page.getAttribute('[data-testid=tutor-workbench]', 'data-revision')), after.revision);
  await tab('outline');
  await page.waitForSelector('text=什么是间隔重复（学习者改）');
  await page.waitForSelector('text=适用场景：词汇、事实与概念（AI 改）');
  await tab('board');
  await page.waitForSelector('text=我的复习节奏：1-2-4-8 天');
  await page.waitForSelector('text=AI：先复习「间隔效应」再看调度算法');
  const actors = new Set(after.events.map((e) => e.actor).filter(Boolean));
  assert.ok(actors.has('ai') && actors.has('learner'));
  await page.screenshot({ path: join(shots, '10-after-restart-board.png') });
});

await step('no page errors', async () => { assert.deepEqual(pageErrors, []); });

await browser.close();
server.kill('SIGTERM');
const summary = { ok: results.every((r) => r.ok), passed: results.filter((r) => r.ok).length, total: results.length, ms: Date.now() - t0, statePath, results, pageErrors };
await writeFile(join(out, 'e2e-result.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.passed}/${summary.total} passed in ${summary.ms} ms → ${join(out, 'e2e-result.json')}`);
process.exit(summary.ok ? 0 : 1);
