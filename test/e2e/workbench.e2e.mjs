// End-to-end: real "间隔重复" state → standalone workbench (same component + RPC as the DSH sidebar tab).
// Covers manual + AI edits of outline, mind map and board, CAS conflicts, chat cards, and restart recovery.
// Usage: node test/e2e/workbench.e2e.mjs [--state fixture.json] [--out dir] [--port 0]
// Browser: PW_CHANNEL=chrome (default, system Chrome) or PW_CHANNEL=bundled (Playwright's Chromium, used in CI).
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
let port = Number(arg('--port', 0)); // 0 = any free port; the restart step reuses the port the harness got
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
    child.stdout.on('data', (d) => { const m = /workbench harness http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(d)); if (m) { port = Number(m[1]); resolve(child); } });
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
const channel = process.env.PW_CHANNEL ?? 'chrome';
const browser = await chromium.launch({ ...(channel === 'bundled' ? {} : { channel }), headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', timezoneId: 'America/Phoenix' });
context.setDefaultTimeout(8000);
let page = await context.newPage();
const pageErrors = [];
let serverDown = false; // the 1 s head poll may hit the port while the harness is deliberately restarted
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !(serverDown && /ERR_CONNECTION_REFUSED/.test(m.text())) && pageErrors.push(m.text()));
const url = `http://127.0.0.1:${port}/`;
await page.goto(url);
await page.waitForSelector('[data-testid=tutor-workbench]');
const VIEW_ID = { outline: 'outline-view', mindmap: 'mindmap-view', graph: 'graph-view', board: 'board-view' };
const tab = async (k, p = page) => { await p.click(`#omt-tab-${k}`); await p.waitForSelector(`[data-testid=${VIEW_ID[k]}]`); };
const mmNode = (id) => `[data-testid=mindmap-elixir] [data-nodeid="me${id}"]`;
const outlineRev = async () => (await course()).syllabus.revision;
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
  await page.dragAndDrop(`[data-subtopic-id="${mover.id}"]`, `[data-subtopic-id="${target.id}"]`, { targetPosition: { x: 30, y: 3 } });
  await eventually(async () => {
    const t4 = (await topics())[4];
    assert.equal(t4.subtopics[1].id, mover.id, 'dragged knowledge point lands before the drop target');
  });
  const st = await readState();
  assert.equal(st.concepts[mover.conceptId].topicId, (await topics())[4].id, 'concept id stable, re-parented');
});

await step('outline: drag DOWN inside one list lands exactly before / after the target (review #4)', async () => {
  const t = (await topics())[2];
  const [a, , c] = t.subtopics;
  await page.locator(`[data-subtopic-id="${c.id}"]`).scrollIntoViewIfNeeded();
  await page.dragAndDrop(`[data-subtopic-id="${a.id}"]`, `[data-subtopic-id="${c.id}"]`, { targetPosition: { x: 30, y: 3 }, force: true });
  await eventually(async () => { const ids = (await topics())[2].subtopics.map((x) => x.id); assert.equal(ids.indexOf(a.id), ids.indexOf(c.id) - 1, `before target: ${ids}`); });
  await eventually(async () => assert.equal(await page.locator(`[data-topic-id="${t.id}"] [data-subtopic-id]`).first().getAttribute('data-subtopic-id'), t.subtopics[1].id));
  const box = await page.locator(`[data-subtopic-id="${c.id}"]`).boundingBox();
  await page.dragAndDrop(`[data-subtopic-id="${a.id}"]`, `[data-subtopic-id="${c.id}"]`, { targetPosition: { x: 30, y: box.height - 3 }, force: true });
  await eventually(async () => { const ids = (await topics())[2].subtopics.map((x) => x.id); assert.equal(ids.indexOf(a.id), ids.indexOf(c.id) + 1, `after target: ${ids}`); });
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
  await eventually(async () => assert.match(await page.textContent('[data-testid=approval-banner]'), new RegExp(`第 ${(await course()).syllabus.revision} 版`)));
  await page.click('[data-testid=approve-outline]');
  await eventually(async () => { const c = await course(); assert.equal(c.status, 'active'); assert.equal(c.syllabus.approvedBy, 'learner'); });
  const ev = (await readState()).events.at(-1);
  assert.equal(ev.action, 'course.approve'); assert.equal(ev.actor, 'learner');
  await page.screenshot({ path: join(shots, '02-outline-manual.png') });
});

await step('approval gate: the AI cannot approve; a stale approve click is refused (review #1)', async () => {
  const c = await course();
  await assert.rejects(tools.tutor_write.execute({ action: 'course.approve', payload_json: JSON.stringify({ courseId: cid, syllabusRevision: c.syllabus.revision }) }), /Only the learner/);
  const slow = await context.newPage();
  await slow.goto(`${url}?view=outline&poll=600000`);
  await slow.waitForSelector('[data-testid=approval-banner]');
  // the learner's screen shows revision N; the AI edits (N+1) and the page has not refreshed yet
  const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [{ op: 'renameTopic', topicId: o.topics[0].id, title: o.topics[0].title + '·' }] });
  await slow.click('[data-testid=approve-outline]').catch(() => {});
  // the page was showing an approved outline (no button) or the old revision: either way nothing unseen gets approved
  await eventually(async () => assert.equal((await course()).status, 'draft'));
  await slow.close();
  const o2 = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o2.syllabusRevision, operations: [{ op: 'renameTopic', topicId: o2.topics[0].id, title: o.topics[0].title }] });
  const stale = await context.newPage();
  await stale.goto(`${url}?view=outline&poll=600000`);
  await stale.waitForSelector('[data-testid=approve-outline]');
  const o3 = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o3.syllabusRevision, operations: [{ op: 'renameSubtopic', subtopicId: o3.topics[1].subtopics[0].id, title: o3.topics[1].subtopics[0].title + '（AI 未读）' }] });
  await stale.click('[data-testid=approve-outline]');
  await stale.waitForSelector('[data-testid=notice].err');
  assert.equal((await course()).status, 'draft', 'approve with the stale on-screen revision is refused');
  await stale.close();
  const o4 = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o4.syllabusRevision, operations: [{ op: 'renameSubtopic', subtopicId: o4.topics[1].subtopics[0].id, title: o3.topics[1].subtopics[0].title }] });
});

await step('outline: rename during the default 1 s poll keeps its revision; a conflict keeps the draft (review #2)', async () => {
  await tab('outline');
  const t = (await topics())[1];
  await page.dblclick(`[data-topic-id="${t.id}"] .tophead .grow`);
  await page.fill('[data-testid=inline-edit]', '学习者还在打字');
  // AI renames the SAME topic while the editor is open; wait for at least one poll to land
  const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [{ op: 'renameTopic', topicId: t.id, title: 'AI 并发改名' }] });
  await eventually(async () => assert.equal(Number(await page.getAttribute('[data-testid=tutor-workbench]', 'data-revision')), (await readState()).revision));
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid=notice].err');
  assert.match(await page.textContent('[data-testid=notice]'), /草稿还在/);
  assert.equal(await page.inputValue('[data-testid=inline-edit]'), '学习者还在打字', 'draft kept');
  assert.equal((await topics())[1].title, 'AI 并发改名', 'AI edit not overwritten silently');
  // explicit learner retry against the outline now on screen
  await page.keyboard.press('Enter');
  await eventually(async () => assert.equal((await topics())[1].title, '学习者还在打字'));
  await eventually(async () => assert.equal(await page.locator('[data-testid=inline-edit]').count(), 0));
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

await step('mind map: mind-elixir renders the outline as a balanced map, fitted with no clipped node; logic chart + list views', async () => {
  await tab('mindmap');
  await page.waitForSelector(`[data-testid=mindmap-elixir][data-direction=side] .me-tpc`);
  const subs = (await topics()).flatMap((t) => t.subtopics).length, tops = (await topics()).length;
  const inside = async () => page.evaluate(() => {
    const r = document.querySelector('[data-testid=mindmap-elixir]'), c = r.getBoundingClientRect();
    const ts = [...r.querySelectorAll('.me-tpc')].map((t) => t.getBoundingClientRect());
    return { n: ts.length, clipped: ts.filter((x) => x.left < c.left - 1 || x.right > c.right + 1 || x.top < c.top - 1 || x.bottom > c.bottom + 1).length };
  });
  await eventually(async () => { const k = await inside(); assert.equal(k.n, 1 + tops + subs); assert.equal(k.clipped, 0, `${k.clipped} nodes clipped`); });
  assert.ok(await page.locator('[data-testid=mindmap-elixir] .lhs').count() > 0 && await page.locator('[data-testid=mindmap-elixir] .rhs').count() > 0, 'balanced left/right');
  await page.screenshot({ path: join(shots, '04a-mindmap-side.png') });
  await page.click('[data-testid=mindmap-modes] [data-mode=right]');
  await page.waitForSelector('[data-testid=mindmap-elixir][data-direction=right]');
  await eventually(async () => {
    const leftOfRoot = await page.evaluate(() => { const r = document.querySelector('[data-testid=mindmap-elixir]'); const root = r.querySelector('.me-root .me-tpc, .me-root').getBoundingClientRect(); return [...r.querySelectorAll('.me-main > .me-wrapper > .me-parent > .me-tpc')].filter((t) => t.getBoundingClientRect().right < root.left).length; });
    assert.equal(leftOfRoot, 0, 'logic chart: every topic to the right of the root');
    assert.equal((await inside()).clipped, 0);
  });
  await page.screenshot({ path: join(shots, '04b-mindmap-logic.png') });
  await page.click('[data-testid=mindmap-modes] [data-mode=list]');
  await page.waitForSelector('[data-testid=mindmap-list]');
  assert.equal(await page.locator('[data-testid=mindmap-list] .treelevel .treelevel .treerow').count(), subs);
  await page.click('[data-testid=mindmap-modes] [data-mode=side]');
  await page.waitForSelector('[data-testid=mindmap-elixir] .me-tpc');
});

await step('mind map: manual select → 上移 / 删除 via toolbar (course.editOutline, actor learner)', async () => {
  const t = (await topics())[2];
  const sub = t.subtopics[2];
  await page.click(mmNode(sub.id));
  await page.waitForSelector('[data-testid=mindmap-toolbar] >> text=已选');
  await page.click('[data-testid=mindmap-toolbar] >> text=上移');
  await eventually(async () => assert.equal((await topics())[2].subtopics[1].id, sub.id));
  const ev = (await readState()).events.at(-1);
  assert.equal(ev.action, 'course.editOutline'); assert.equal(ev.actor, 'learner');
  const del = (await topics())[2].subtopics.at(-1);
  await eventually(async () => assert.equal(await page.locator(mmNode(del.id)).count(), 1));
  await page.click(mmNode(del.id));
  await page.waitForSelector(`[data-testid=mindmap-toolbar] >> text=已选：${del.title}`);
  await page.click('[data-testid=mindmap-toolbar] >> text=删除');
  await eventually(async () => assert.ok(!(await topics())[2].subtopics.some((x) => x.id === del.id)));
  await eventually(async () => assert.equal(await page.locator(mmNode(del.id)).count(), 0));
});

async function mmDrag(fromId, toId, where = 'in', { hold } = {}) {
  await page.click(mmNode(fromId));
  const a = await page.locator(mmNode(fromId)).boundingBox();
  const b = await page.locator(mmNode(toId)).boundingBox();
  const ty = where === 'in' ? b.y + b.height * 0.7 : where === 'before' ? b.y - 3 : b.y + b.height + 3;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, ty, { steps: 14 });
  if (hold) await hold();
  await page.mouse.up();
}

await step('mind map: drag a knowledge point into another topic (re-parent) and before a sibling', async () => {
  const ts = await topics();
  const src = ts[0].subtopics[0], target = ts[1];
  await mmDrag(src.id, target.id, 'in');
  await eventually(async () => assert.equal((await topics())[1].subtopics.at(-1).id, src.id));
  await eventually(async () => assert.equal(await page.locator(`[data-testid=mindmap-elixir] [data-nodeid="me${target.id}"]`).count(), 1));
  const t1 = (await topics())[1];
  const last = t1.subtopics.at(-1), first = t1.subtopics[0];
  await page.waitForTimeout(300);
  await mmDrag(last.id, first.id, 'before');
  await eventually(async () => assert.equal((await topics())[1].subtopics[0].id, last.id));
  await page.screenshot({ path: join(shots, '04c-mindmap-manual.png') });
});

await step('mind map: only two levels — adding under a knowledge point / dropping a topic into a topic is refused', async () => {
  const before = await outlineRev();
  const sub = (await topics())[0].subtopics[0];
  await page.click(mmNode(sub.id));
  await page.keyboard.press('Tab');
  await page.waitForSelector('[data-testid=notice].err >> text=只有两层');
  const ts = await topics();
  await page.waitForTimeout(300);
  await mmDrag(ts[3].id, ts[2].id, 'in');
  await page.waitForTimeout(400);
  assert.equal(await outlineRev(), before, 'no outline change');
  assert.equal(await page.locator('[data-testid=mindmap-elixir] .me-tpc').count(), 1 + ts.length + ts.flatMap((t) => t.subtopics).length);
});

await step('mind map: double-click rename and Tab on a topic add through the outline', async () => {
  const t = (await topics())[0];
  // the map may still be re-rendering the previous step's refresh; retry the double-click until the editor opens
  await eventually(async () => {
    await page.dblclick(mmNode(t.id));
    await page.waitForSelector('[data-testid=mindmap-elixir] #input-box', { timeout: 1500 });
  }, 9000);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('什么是间隔重复（导图改名）');
  await page.keyboard.press('Enter');
  await eventually(async () => assert.equal((await topics())[0].title, '什么是间隔重复（导图改名）'));
  const n = (await topics())[0].subtopics.length;
  await page.click(mmNode(t.id));
  await page.keyboard.press('Tab');
  await eventually(async () => assert.equal((await topics())[0].subtopics.length, n + 1));
  assert.equal((await readState()).events.at(-1).actor, 'learner');
  const added = (await topics())[0].subtopics.at(-1);
  await eventually(async () => assert.equal(await page.locator(mmNode(added.id)).count(), 1));
  await page.click(mmNode(added.id));
  await page.keyboard.press('Delete');
  await eventually(async () => assert.equal((await topics())[0].subtopics.length, n));
});

await step('mind map: an AI edit during a drag waits for the gesture; the drop then conflicts instead of using the new revision', async () => {
  const ts = await topics();
  const src = ts[2].subtopics[0], target = ts[4];
  const renamed = ts[3].title + '（AI 拖动中改）';
  const revBefore = await outlineRev();
  await mmDrag(src.id, target.id, 'in', { hold: async () => {
    const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'outline' });
    await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [{ op: 'renameTopic', topicId: ts[3].id, title: renamed }] });
    await page.waitForTimeout(1600); // more than one poll
    assert.equal(await page.locator(`[data-testid=mindmap-elixir] .me-tpc:has-text("${renamed}")`).count(), 0, 'map not refreshed under the pointer');
    assert.equal(await page.locator('[data-testid=mindmap-elixir] .mind-elixir-ghost').evaluate((g) => g.style.display), 'block', 'drag still in progress');
  } });
  await page.waitForSelector('[data-testid=notice].err');
  await eventually(async () => assert.equal(await page.locator(`[data-testid=mindmap-elixir] .me-tpc:has-text("${renamed}")`).count(), 1, 'refreshed after the gesture'));
  assert.equal((await topics())[2].subtopics[0].id, src.id, 'stale drop not applied');
  assert.equal(await outlineRev(), revBefore + 1);
});

await step('mind map: AI reorders and prunes via tutor_outline_edit; map, list and outline agree', async () => {
  const o = await tools.tutor_visualize.execute({ courseId: cid, view: 'mindmap' });
  const last = o.hierarchy.children.at(-1);
  const prune = o.hierarchy.children[3].children.at(-1);
  await tools.tutor_outline_edit.execute({ courseId: cid, syllabusRevision: o.syllabusRevision, operations: [
    { op: 'moveTopic', topicId: last.id, beforeId: o.hierarchy.children[0].id }, { op: 'removeSubtopic', subtopicId: prune.id },
  ] });
  await eventually(async () => assert.equal(await page.locator(mmNode(prune.id)).count(), 0));
  await page.click('[data-testid=mindmap-modes] [data-mode=list]');
  assert.equal((await page.locator('[data-testid=mindmap-list] .treelevel > .treerow').first().textContent()).replace(/^●\s*/, ''), last.title);
  await page.click('[data-testid=mindmap-modes] [data-mode=side]');
  await tab('outline');
  assert.match(await page.locator('[data-testid=outline-view] .card b').first().textContent(), new RegExp(`^1\\. ${last.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  await tab('mindmap');
  await page.waitForSelector('[data-testid=mindmap-elixir] .me-tpc');
  await page.waitForTimeout(400);
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
    { op: 'add', type: 'note', ref: 'n1', text: 'AI：先复习「间隔效应」再看调度算法', x: 480, y: 40, color: '#eef6ff' },
    { op: 'add', type: 'arrow', from: '$n1', to: card.id, label: '先看' },
    { op: 'update', id: note.id, x: 480, y: 160 },
  ] });
  assert.equal(r.revision, b.revision + 1);
  assert.match(r.refs.n1, /^note-/, 'the store assigned the note id');
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
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', text: 'AI 并发写入', x: 480, y: 280 }] });
  const box = await slow.locator('[data-testid=board] .boardnode').first().boundingBox();
  await slow.mouse.move(box.x + 20, box.y + 20); await slow.mouse.down(); await slow.mouse.move(box.x + 80, box.y + 50, { steps: 5 }); await slow.mouse.up();
  await slow.waitForSelector('[data-testid=notice].err', { timeout: 4000 });
  assert.match(await slow.textContent('[data-testid=notice]'), /刚改过/);
  await slow.waitForSelector('text=AI 并发写入');
  await slow.close();
});

await step('board: a drag during the default 1 s poll is not yanked back and keeps its base revision (review #2)', async () => {
  await tab('board');
  const el = page.locator('[data-testid=board] .boardnode').nth(3);
  const id = await el.getAttribute('data-element');
  const before = (await readState()).boards[cid].elements.find((x) => x.id === id);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 50, { steps: 5 });
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', text: 'AI 在你拖动时加的', x: 700, y: 40 }] });
  await page.waitForSelector('text=AI 在你拖动时加的', { timeout: 4000 }); // the poll landed mid-drag
  const left = await el.evaluate((n) => parseFloat(n.style.left));
  assert.ok(left > before.x + 20, `card stays under the pointer (left=${left}, server x=${before.x})`);
  await page.mouse.move(box.x + 100, box.y + 80, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector('[data-testid=notice].err');
  assert.match(await page.textContent('[data-testid=notice]'), /没有保存/);
  const after = (await readState()).boards[cid].elements.find((x) => x.id === id);
  assert.deepEqual([after.x, after.y], [before.x, before.y], 'stale drag not written with the new revision');
});

await step('board: Backspace never deletes; Delete only works with focus inside the board (review #5)', async () => {
  const card = page.locator('[data-testid=board] .boardnode').nth(2);
  const id = await card.getAttribute('data-element');
  await card.click();
  await page.keyboard.press('Backspace');
  await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  assert.ok(!(await readState()).boards[cid].elements.find((x) => x.id === id).deleted, 'card survives Backspace and Delete outside the board');
  await card.click();
  await page.keyboard.press('Delete');
  await eventually(async () => assert.ok((await readState()).boards[cid].elements.find((x) => x.id === id).deleted));
});

await step('board: re-seed after deleting a card brings back the card and its relation arrow (review #6)', async () => {
  const st = await readState();
  const relArrow = st.boards[cid].elements.find((e) => e.type === 'arrow' && e.relationId && !e.deleted);
  const fromCard = st.boards[cid].elements.find((e) => e.id === relArrow.from);
  await page.click(`[data-element="${fromCard.id}"]`);
  await page.click('[data-testid=board-delete]');
  await eventually(async () => assert.ok((await readState()).boards[cid].elements.find((e) => e.id === relArrow.id).deleted));
  await page.waitForSelector('[data-testid=board-seed]:not([disabled])');
  await page.click('[data-testid=board-seed]');
  await eventually(async () => {
    const els = (await readState()).boards[cid].elements.filter((e) => !e.deleted);
    assert.ok(els.some((e) => e.type === 'concept' && e.conceptId === fromCard.conceptId));
    assert.ok(els.some((e) => e.type === 'arrow' && e.relationId === relArrow.relationId));
  });
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
  serverDown = true;
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  await page.waitForSelector('[data-testid=sync-chip] >> text=已断开', { timeout: 5000 }); // review #10: no fake "实时"
  server = await startServer();
  await page.waitForSelector('[data-testid=sync-chip] >> text=实时', { timeout: 5000 });
  await page.reload();
  serverDown = false;
  await page.waitForSelector('[data-testid=tutor-workbench]');
  const after = await readState();
  assert.equal(after.revision, before.revision);
  assert.equal(Number(await page.getAttribute('[data-testid=tutor-workbench]', 'data-revision')), after.revision);
  await tab('outline');
  await page.waitForSelector('text=什么是间隔重复（导图改名）');
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
