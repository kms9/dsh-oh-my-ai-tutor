// End-to-end: real "间隔重复" state → standalone workbench (same component + RPC as the DSH sidebar tab).
// Covers manual + AI edits of outline, mind map and board, CAS conflicts, chat cards, and restart recovery.
// Usage: node test/e2e/workbench.e2e.mjs [--state fixture.json] [--out dir] [--port 0]
// Browser: PW_CHANNEL=chrome (default, system Chrome) or PW_CHANNEL=bundled (Playwright's Chromium, used in CI).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { SqliteTutorStore } from '../../src/sqlite-store.mjs';
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
const dbPath = join(out, 'tutor-state.db');
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) await rm(f, { force: true });
for (const f of await readdir(out)) if (f.startsWith('tutor-state.json.migrated-')) await rm(join(out, f), { force: true });
await copyFile(fixture, statePath); // the harness imports it into SQLite once (same path as the DSH plugin's first start)
const store = new SqliteTutorStore(dbPath, { legacyJsonPath: statePath });
const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
const readState = async () => validateState(await store.read());
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
const VIEW_ID = { outline: 'outline-view', mindmap: 'mindmap-view', graph: 'graph-view', board: 'board-view', data: 'data-view' };
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

const G = '[data-testid=graph-flow]';
const kgNode = (id, p = page) => p.locator(`${G} .kg-node[data-node-id="${id}"]`);
const kgBox = (id) => page.evaluate((id) => { const r = document.querySelector(`[data-testid=graph-flow] .kg-node[data-node-id="${id}"]`)?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, id);
const kgBoxes = () => page.evaluate(() => [...document.querySelectorAll('[data-testid=graph-flow] .kg-node')].map((n) => { const r = n.getBoundingClientRect(); return { id: n.dataset.nodeId, x: r.x, y: r.y, w: r.width, h: r.height }; }));
/** the live d3-force simulation flies in and settles; wait until no node moves for a few frames */
const graphStill = async () => {
  let last = '';
  for (let i = 0; i < 40; i++) {
    const now = JSON.stringify((await kgBoxes()).map((b) => [Math.round(b.x), Math.round(b.y)]));
    if (now === last) return; last = now; await page.waitForTimeout(250);
  }
  throw new Error('graph never settled');
};
const awayFromGraph = async () => { const c = await page.locator(G).boundingBox(); await page.mouse.move(c.x + 4, c.y + c.height - 4); };
const overlapCount = (bx, pad = 2) => bx.flatMap((p, i) => bx.slice(i + 1).filter((q) => p.x < q.x + q.w - pad && q.x < p.x + p.w - pad && p.y < q.y + q.h - pad && q.y < p.y + p.h - pad)).length;

await step('graph (React Flow, after AWS OntologyGraphFlow): circles per topic colour, directed labelled relation, force layout settles', async () => {
  await tab('graph');
  await page.waitForSelector(`${G} .kg-concept`);
  assert.equal(await page.getAttribute(G, 'data-layout'), 'force');
  assert.equal(await page.locator(`${G} .kg-concept`).count(), 15);
  assert.equal(await page.locator(`${G} .kg-topic`).count(), (await topics()).length);
  const colours = await page.evaluate(() => new Set([...document.querySelectorAll('[data-testid=graph-flow] .kg-topic')].map((n) => n.style.getPropertyValue('--c'))).size);
  assert.equal(colours, (await topics()).length, 'one colour per topic (category)');
  const rel = page.locator(`${G} .react-flow__edge.kg-rel`);
  assert.equal(await rel.count(), 1);
  assert.match(await rel.locator('path').first().getAttribute('style'), /stroke-dasharray/, 'candidate relation is dashed');
  assert.match(await rel.locator('path').first().getAttribute('marker-end') ?? '', /url\(/, 'directed (arrow head)');
  assert.match(await page.textContent(`${G} .kg-elabel`), /前置 · 候选/);
  assert.equal(await page.locator(`${G} .react-flow__edge.kg-contains`).count(), 15);
  assert.ok(await page.locator(`${G} [data-testid=graph-legend]`).count() === 1, 'legend');
  await graphStill();
  assert.ok(Number(await page.getAttribute(G, 'data-scale')) >= 0.8, 'readable zoom');
  assert.equal(overlapCount(await kgBoxes()), 0, 'no two circles overlap after the force layout');
  assert.equal(await page.locator(`${G} .kg-node.dim`).count(), 0, 'nothing dimmed before any hover / click');
});

await step('graph: hover and click highlight the one-hop neighbourhood; click selects (detail card)', async () => {
  const st = await readState(); const r0 = Object.values(st.relations)[0];
  await kgNode(r0.from).hover();
  await eventually(async () => assert.equal(await page.getAttribute(G, 'data-mode'), 'hover'));
  assert.equal(await page.locator(`${G} .kg-node[data-node-id="${r0.to}"].dim`).count(), 0, 'related knowledge point lit');
  assert.ok(await page.locator(`${G} .kg-node.dim`).count() >= 10, 'others dimmed');
  await awayFromGraph();
  await eventually(async () => assert.equal(await page.getAttribute(G, 'data-mode'), ''));
  await kgNode(r0.from).click();
  await awayFromGraph();
  await eventually(async () => assert.match(await page.textContent('[data-testid=graph-detail] b'), new RegExp(st.concepts[r0.from].title.replace(/[()（）+|?.*\[\]]/g, '.'))));
  await eventually(async () => assert.equal(await page.getAttribute(G, 'data-mode'), 'focus'));
  assert.equal(await page.locator(`${G} .kg-node.sel`).count(), 1);
  assert.equal(await page.locator(`${G} .kg-node[data-node-id="${r0.to}"].dim`).count(), 0);
  assert.equal(await page.locator(`${G} .react-flow__edge.kg-rel.hot`).count(), 1, 'its relation lit');
  await page.screenshot({ path: join(shots, '01b-graph-right-column.png') });
});

await step('graph: search highlights matches; double-click a topic collapses it (React Flow hidden), relations re-attach; expand again', async () => {
  await page.fill('[data-testid=graph-search]', '间隔');
  await eventually(async () => assert.match(await page.textContent('[data-testid=graph-hits]'), /^\d+ 个匹配/));
  const hits = Number((await page.textContent('[data-testid=graph-hits]')).match(/\d+/)[0]);
  assert.ok(hits >= 2);
  assert.equal(await page.getAttribute(G, 'data-mode'), 'search');
  assert.equal(await page.locator(`${G} .kg-node.hit`).count(), hits);
  await page.fill('[data-testid=graph-search]', '');
  await eventually(async () => assert.notEqual(await page.getAttribute(G, 'data-mode'), 'search'));
  const st = await readState(); const r0 = Object.values(st.relations)[0];
  const tid = st.concepts[r0.from].topicId;
  const inTopic = Object.values(st.concepts).filter((c) => c.topicId === tid).length;
  await kgNode(`topic:${tid}`).dblclick();
  await eventually(async () => assert.equal(await page.locator(`${G} .kg-concept`).count(), 15 - inTopic));
  assert.equal(await kgNode(`topic:${tid}`).getAttribute('data-collapsed'), 'true');
  assert.equal((await kgNode(`topic:${tid}`).locator('.kg-badge').textContent()).trim(), `+${inTopic}`);
  await eventually(async () => assert.equal(await page.locator(`${G} .react-flow__edge.kg-rel.agg`).count(), 1, 'the relation now starts at the collapsed topic'));
  await awayFromGraph(); await graphStill();
  await page.screenshot({ path: join(shots, '01d-graph-collapsed.png') });
  // double-click the relation's target: lazily reveals the collapsed topic its relation comes from
  await kgNode(r0.to).dblclick();
  await eventually(async () => assert.equal(await page.locator(`${G} .kg-concept`).count(), 15));
  await page.click('[data-testid=graph-collapse-all]');
  await eventually(async () => assert.equal(await page.locator(`${G} .kg-concept`).count(), 0));
  await page.click('[data-testid=graph-collapse-all]');
  await eventually(async () => assert.equal(await page.locator(`${G} .kg-concept`).count(), 15));
  await awayFromGraph(); await graphStill();
});

await step('graph: path between two nodes is highlighted; dagre (层级) ↔ force layout switch', async () => {
  const st = await readState(); const r0 = Object.values(st.relations)[0];
  const sib = Object.values(st.concepts).find((c) => c.topicId === st.concepts[r0.from].topicId && c.id !== r0.from);
  await page.click('[data-testid=graph-path]');
  await kgNode(sib.id).click();
  await kgNode(r0.to).click();
  await awayFromGraph();
  await eventually(async () => assert.match(await page.textContent('[data-testid=graph-status]'), /最短路径（\d+ 步）/));
  assert.equal(await page.getAttribute(G, 'data-mode'), 'path');
  assert.equal(await page.locator(`${G} .kg-node.end`).count(), 2);
  assert.ok(await page.locator(`${G} .react-flow__edge.hot`).count() >= 2, 'path edges lit');
  await page.screenshot({ path: join(shots, '01e-graph-path.png') });
  await page.click('[data-testid=graph-path]');
  await page.click('[data-testid=graph-layout-hierarchical]');
  await eventually(async () => assert.equal(await page.getAttribute(G, 'data-layout'), 'hierarchical'));
  await eventually(async () => {
    const bx = await kgBoxes();
    assert.equal(overlapCount(bx), 0, 'dagre: no overlap');
    const t = bx.find((b) => b.id.startsWith('topic:')), c = bx.find((b) => !b.id.startsWith('topic:'));
    assert.ok(c.x > t.x, 'left → right layers');
  });
  await page.screenshot({ path: join(shots, '01f-graph-dagre.png') });
  await page.click('[data-testid=graph-layout-force]');
  await eventually(async () => assert.equal(await page.getAttribute(G, 'data-layout'), 'force'));
  await graphStill();
});

await step('graph: dragging a node runs the live d3-force simulation (fx/fy pin, neighbours follow) and writes nothing', async () => {
  const st = await readState(); const rev = st.revision;
  const t = (await topics())[1]; const tid = `topic:${t.id}`;
  const kid = Object.values(st.concepts).find((c) => c.topicId === t.id).id;
  const a = await kgBox(tid), k0 = await kgBox(kid);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  for (let i = 1; i <= 14; i++) { await page.mouse.move(a.x + (90 * i) / 14, a.y + (60 * i) / 14); await page.waitForTimeout(16); }
  await page.waitForTimeout(400);
  const mid = await kgBox(tid), kmid = await kgBox(kid);
  assert.ok(Math.hypot(mid.x - a.x - 90, mid.y - a.y - 60) < 20, 'dragged node pinned under the pointer');
  assert.ok(Math.hypot(kmid.x - k0.x, kmid.y - k0.y) > 8, 'a contained knowledge point followed while dragging');
  await page.mouse.up();
  await awayFromGraph(); await graphStill();
  const a1 = await kgBox(tid);
  assert.ok(Math.hypot(a1.x - a.x - 90, a1.y - a.y - 60) < 40, 'released node keeps (about) its new place');
  assert.equal((await readState()).revision, rev, 'view-only: no write');
});

await step('graph: enlarge to the whole workbench shows every node', async () => {
  await page.click('[data-testid=graph-zoom]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=wide]');
  await page.click('[data-testid=graph-zoom-full]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=full]');
  await page.click('[data-testid=graph-fit]');
  await eventually(async () => {
    const r = await page.evaluate(() => {
      const c = document.querySelector('[data-testid=graph-flow]').getBoundingClientRect();
      const ns = [...document.querySelectorAll('[data-testid=graph-flow] .kg-node')].map((x) => x.getBoundingClientRect());
      return { clipped: ns.filter((x) => x.left < c.left - 1 || x.right > c.right + 1 || x.top < c.top - 1 || x.bottom > c.bottom + 1).length, w: c.width };
    });
    assert.ok(r.w > 1100, `whole workbench (${r.w}px)`);
    assert.equal(r.clipped, 0, `${r.clipped} nodes clipped`);
  });
  await page.screenshot({ path: join(shots, '01c-graph-enlarged.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=off]');
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
  // HTML5 drag and drop: bring both rows into view first (the outline column scrolls) and retry once if the
  // browser dropped the gesture (seen ~1 in 4 runs: no drop event, state unchanged — not a wrong landing spot)
  const rev0 = await outlineRev();
  for (let attempt = 0; attempt < 2 && (await outlineRev()) === rev0; attempt++) {
    await page.locator(`[data-subtopic-id="${target.id}"]`).scrollIntoViewIfNeeded();
    await page.locator(`[data-subtopic-id="${mover.id}"]`).scrollIntoViewIfNeeded();
    await page.dragAndDrop(`[data-subtopic-id="${mover.id}"]`, `[data-subtopic-id="${target.id}"]`, { targetPosition: { x: 30, y: 3 } });
    await eventually(async () => assert.notEqual(await outlineRev(), rev0), 1500).catch(() => {});
  }
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
  const mmAttr = (n) => page.getAttribute('[data-testid=mindmap-elixir]', n);
  // fit never goes below a readable zoom; when the map is bigger than that, the overflow is reported (pan or enlarge)
  await eventually(async () => {
    const k = await inside(); assert.equal(k.n, 1 + tops + subs);
    assert.ok(Number(await mmAttr('data-scale')) >= 0.8, 'readable zoom');
    if (await mmAttr('data-overflow') !== 'true') assert.equal(k.clipped, 0, `${k.clipped} nodes clipped`);
  });
  const h0 = (await page.locator('[data-testid=mindmap-elixir]').boundingBox()).height;
  assert.ok(h0 >= 420, `canvas fills the column (${h0}px)`);
  // enlarge: centre + right column, then the whole workbench; Esc restores
  await page.click('[data-testid=mindmap-zoom]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=wide]');
  assert.equal(await page.locator('[data-testid=tutor-workbench] .center').isVisible(), false);
  await page.click('[data-testid=mindmap-zoom-full]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=full]');
  await eventually(async () => {
    const box = await page.locator('[data-testid=mindmap-elixir]').boundingBox();
    assert.ok(box.width >= 1100 && box.height > h0 * 0.95, `whole workbench canvas ${box.width}x${box.height}`);
    assert.ok(Number(await mmAttr('data-scale')) >= 0.8);
    if (await mmAttr('data-overflow') !== 'true') assert.equal((await inside()).clipped, 0);
  });
  await page.screenshot({ path: join(shots, '04c-mindmap-enlarged.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=off]');
  assert.ok(await page.locator('[data-testid=tutor-workbench] .center').isVisible());
  assert.ok(await page.locator('[data-testid=mindmap-elixir] .lhs').count() > 0 && await page.locator('[data-testid=mindmap-elixir] .rhs').count() > 0, 'balanced left/right');
  await page.screenshot({ path: join(shots, '04a-mindmap-side.png') });
  await page.click('[data-testid=mindmap-modes] [data-mode=right]');
  await page.waitForSelector('[data-testid=mindmap-elixir][data-direction=right]');
  await eventually(async () => {
    const leftOfRoot = await page.evaluate(() => { const r = document.querySelector('[data-testid=mindmap-elixir]'); const root = r.querySelector('.me-root .me-tpc, .me-root').getBoundingClientRect(); return [...r.querySelectorAll('.me-main > .me-wrapper > .me-parent > .me-tpc')].filter((t) => t.getBoundingClientRect().right < root.left).length; });
    assert.equal(leftOfRoot, 0, 'logic chart: every topic to the right of the root');
    assert.ok(Number(await mmAttr('data-scale')) >= 0.8);
    if (await mmAttr('data-overflow') !== 'true') assert.equal((await inside()).clipped, 0);
  });
  await page.screenshot({ path: join(shots, '04b-mindmap-logic.png') });
  await page.click('[data-testid=mindmap-modes] [data-mode=list]');
  await page.waitForSelector('[data-testid=mindmap-list]');
  assert.equal(await page.locator('[data-testid=mindmap-list] .treelevel .treelevel .treerow').count(), subs);
  await page.click('[data-testid=mindmap-modes] [data-mode=side]');
  await page.waitForSelector('[data-testid=mindmap-elixir] .me-tpc');
  // the interactive steps below use the enlarged map (how a learner edits a big map); the zoom only applies on this tab
  await page.click('[data-testid=mindmap-zoom]'); await page.click('[data-testid=mindmap-zoom-full]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=full]');
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
  // no retry on purpose: the toolbar has a fixed height (selection never shifts the map) and the native dblclick opens the editor
  await page.dblclick(mmNode(t.id));
  await page.waitForSelector('[data-testid=mindmap-elixir] #input-box');
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

const card = (i) => page.locator('[data-testid=board] .rf-card').nth(i);
const cardById = (id, p = page) => p.locator(`[data-testid=board] .rf-card[data-element="${id}"]`);
const boardEls = async () => (await readState()).boards[cid].elements;
const liveEl = async (id) => (await boardEls()).find((e) => e.id === id);
const arrowsOnScreen = () => page.locator('[data-testid=board] .react-flow__edge');
/** Drag with the mouse in small steps (React Flow / d3-drag need real pointer moves). */
async function drag(p, from, to, steps = 8) {
  await p.mouse.move(from.x, from.y); await p.mouse.down();
  for (let i = 1; i <= steps; i++) await p.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await p.mouse.up();
}
/** A point on the empty canvas (the React Flow pane itself, not a card, section, minimap or attribution). */
const emptyCanvasSpot = (p) => p.evaluate(() => {
  const c = document.querySelector('[data-testid=board]').getBoundingClientRect();
  for (let y = c.bottom - 30; y > c.top + 30; y -= 20) for (let x = c.right - 200; x > c.left + 30; x -= 20) {
    const el = document.elementFromPoint(x, y);
    if (el?.classList.contains('react-flow__pane')) return { x, y };
  }
  throw new Error('no empty canvas spot');
});
/** A screen point on an arrow that is really clickable (not under a card or label), or null. */
const arrowMidpoint = (p, id) => p.evaluate((id) => {
  const g = document.querySelector(`[data-testid=board] .react-flow__edge[data-id="${id}"]`);
  const path = g?.querySelector('path.react-flow__edge-path');
  if (!path) return null;
  const len = path.getTotalLength(), m = path.getScreenCTM();
  for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    const pt = path.getPointAtLength(len * f);
    const x = pt.x * m.a + pt.y * m.c + m.e, y = pt.x * m.b + pt.y * m.d + m.f;
    if (g.contains(document.elementFromPoint(x, y))) return { x, y };
  }
  return null;
}, id);
/** Sections never overlap: frames pairwise disjoint; each card fully inside one frame (or a free note over none), never over a section title. */
async function assertSectionsClean(p = page, label = '') {
  const bad = await p.evaluate(() => {
    const ov = (a, b, m = 1) => a.left < b.right - m && b.left < a.right - m && a.top < b.bottom - m && b.top < a.bottom - m;
    const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
    const frames = [...document.querySelectorAll('[data-testid=board] .rf-section')].map((f) => ({ id: f.dataset.section, r: f.getBoundingClientRect(), t: f.querySelector('.rf-section-title').getBoundingClientRect() }));
    const out = [];
    const host = document.querySelector('[data-testid=board]').getBoundingClientRect();
    const cards = [...document.querySelectorAll('[data-testid=board] .rf-card')];
    if (!cards.length) out.push('no cards rendered');
    else if (!cards.some((c) => { const r = c.getBoundingClientRect(); return r.right > host.left && r.left < host.right && r.bottom > host.top && r.top < host.bottom; })) out.push('no card in view');
    for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) if (ov(frames[i].r, frames[j].r)) out.push(`sections ${i}/${j} overlap`);
    for (const c of document.querySelectorAll('[data-testid=board] .rf-card')) {
      const r = c.getBoundingClientRect(); const name = c.dataset.element;
      const hit = frames.filter((f) => ov(r, f.r));
      if (hit.length > 1) out.push(`${name} over ${hit.length} sections`);
      if (hit.length === 1 && !inside(r, hit[0].r)) out.push(`${name} sticks out of its section`);
      if (frames.some((f) => ov(r, f.t))) out.push(`${name} covers a section title`);
    }
    return out;
  });
  assert.deepEqual(bad, [], `sections clean ${label}`);
}
const centreOf = async (loc) => { const b = await loc.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, b }; };

await step('board (React Flow): seed from syllabus → cards in topic sections + candidate relation arrow; enlarge / whole workbench / restore', async () => {
  await tab('board');
  await page.click('[data-testid=board-seed]');
  const active = Object.values((await readState()).concepts).filter((c) => c.status === 'active').length;
  await eventually(async () => assert.equal(await page.locator('[data-testid=board] .rf-card').count(), active));
  assert.equal(await arrowsOnScreen().count(), 1);
  assert.match(await arrowsOnScreen().first().locator('path').first().getAttribute('style'), /stroke-dasharray/, 'relation arrow dashed');
  assert.equal(await page.locator('[data-testid=board] .rf-section').count(), (await topics()).length, 'one section per topic');
  assert.ok(Number(await page.getAttribute('[data-testid=board]', 'data-scale')) >= 0.8, 'readable zoom');
  // every concept card sits inside its own section frame
  const misplaced = await page.evaluate(() => {
    const frames = [...document.querySelectorAll('[data-testid=board] .rf-section')].map((f) => f.getBoundingClientRect());
    return [...document.querySelectorAll('[data-testid=board] .rf-card.concept')].filter((c) => {
      const r = c.getBoundingClientRect(); return !frames.some((f) => r.left >= f.left - 1 && r.right <= f.right + 1 && r.top >= f.top - 1 && r.bottom <= f.bottom + 1);
    }).length;
  });
  assert.equal(misplaced, 0);
  await assertSectionsClean(page, 'after seed');
  assert.equal(await page.locator('[data-testid=board] .rf-card[data-actor=learner] .rf-by.me').count(), active, 'learner-seeded cards are tagged 你');
  await page.screenshot({ path: join(shots, '06-board-seeded.png') });
  await page.click('[data-testid=board-zoom]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=wide]');
  await page.click('[data-testid=board-zoom-full]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=full]');
  await eventually(async () => assert.ok((await page.locator('[data-testid=board]').boundingBox()).width > 1100));
  await page.click('[data-testid=board-fit]'); await page.waitForTimeout(300);
  await assertSectionsClean(page, 'whole workbench');
  assert.equal(await page.getAttribute('[data-testid=board]', 'data-overflow'), 'false', 'the whole board fits the whole workbench at a readable zoom (3 sections per row)');
  await page.screenshot({ path: join(shots, '06b-board-whole-workbench.png') });
  // the interactive board steps below run on the enlarged board (as a learner editing a big board would)
});

await step('board: drag a card → one board.patch update x/y (actor learner, base revision of the gesture)', async () => {
  const el = card(1); const id = await el.getAttribute('data-element');
  const before = await liveEl(id); const rev0 = (await readState()).boards[cid].revision;
  const c = await centreOf(el);
  await drag(page, c, { x: c.x + 60, y: c.y + 160 });
  await eventually(async () => {
    const e = await liveEl(id);
    assert.ok(e.y > before.y + 60, `moved: ${before.x},${before.y} → ${e.x},${e.y}`);
    assert.equal(e.updatedBy, 'learner');
    assert.equal((await readState()).boards[cid].revision, rev0 + 1);
  });
  const ev = (await readState()).events.at(-1);
  assert.equal(ev.action, 'board.patch'); assert.equal(ev.actor, 'learner'); assert.match(ev.summary, /移动/);
  await eventually(() => assertSectionsClean(page, 'after a learner drag'));
});

await step('board: connect two cards by dragging from a side handle (onConnect → add arrow)', async () => {
  const a = await card(2).getAttribute('data-element'), b = await card(4).getAttribute('data-element');
  await cardById(a).hover();
  const h = await centreOf(cardById(a).locator('.react-flow__handle[data-handleid=r]'));
  await cardById(b).hover();
  const t = await centreOf(cardById(b).locator('.react-flow__handle[data-handleid=l]'));
  await cardById(a).hover();
  await drag(page, h, t, 12);
  await eventually(async () => {
    const arrow = (await boardEls()).find((e) => e.type === 'arrow' && !e.deleted && ((e.from === a && e.to === b) || (e.from === b && e.to === a)));
    assert.ok(arrow, 'arrow saved'); assert.equal(arrow.createdBy, 'learner');
  });
  await eventually(async () => assert.equal(await arrowsOnScreen().count(), 2));
});

await step('board: toolbar link mode, delete a card (cascade), add + edit a note, add a note by double-clicking empty canvas', async () => {
  const a = await card(5).getAttribute('data-element'), b = await card(6).getAttribute('data-element');
  await page.click('[data-testid=board-link]');
  await cardById(a).click(); await cardById(b).click();
  await eventually(async () => assert.ok((await boardEls()).some((e) => e.type === 'arrow' && !e.deleted && e.from === a && e.to === b)));
  await page.waitForSelector('[data-testid=board-link]:not(.on)');
  await cardById(a).click();
  await page.click('[data-testid=board-delete]');
  await eventually(async () => {
    const els = await boardEls();
    assert.ok(els.find((e) => e.id === a).deleted, 'card tombstoned');
    assert.ok(els.filter((e) => e.type === 'arrow' && (e.from === a || e.to === a)).every((e) => e.deleted), 'arrows cascade');
  });
  await page.click('[data-testid=board-add-note]');
  await page.waitForSelector('[data-testid=board] .rf-card.note');
  await page.locator('[data-testid=board] .rf-card.note').first().dblclick();
  await page.fill('[data-testid=board-card-editor]', '我的复习节奏：1-2-4-8 天');
  await page.keyboard.press('Enter');
  await eventually(async () => assert.ok((await boardEls()).some((e) => e.type === 'note' && !e.deleted && e.text === '我的复习节奏：1-2-4-8 天' && e.createdBy === 'learner')));
  await page.waitForSelector('[data-testid=board] .rf-card.note-me >> text=我的复习节奏：1-2-4-8 天');
  // the edited text shows optimistically; wait until the board on screen is at the stored revision before the next gesture
  const boardRev = (await tools.tutor_board_read.execute({ courseId: cid })).revision;
  await eventually(async () => assert.equal(await page.getAttribute('[data-testid=board]', 'data-revision'), String(boardRev)));
  // double-click on empty canvas adds a note at that spot
  const spot = await emptyCanvasSpot(page);
  const notes0 = (await boardEls()).filter((e) => e.type === 'note' && !e.deleted).length;
  await page.mouse.dblclick(spot.x, spot.y);
  await eventually(async () => assert.equal((await boardEls()).filter((e) => e.type === 'note' && !e.deleted).length, notes0 + 1));
  await page.screenshot({ path: join(shots, '07-board-manual.png') });
});

await step('board: double-click a knowledge-point card renames it through the outline (course.editOutline, learner)', async () => {
  const el = card(0); const conceptId = await el.getAttribute('data-concept');
  await el.dblclick();
  await page.fill('[data-testid=board-card-editor]', '适用场景（白板改名）');
  await page.keyboard.press('Enter');
  await eventually(async () => {
    const sub = (await topics()).flatMap((t) => t.subtopics).find((s) => s.conceptId === conceptId);
    assert.equal(sub.title, '适用场景（白板改名）');
  });
  const ev = (await readState()).events.at(-1);
  assert.equal(ev.action, 'course.editOutline'); assert.equal(ev.actor, 'learner');
  await page.waitForSelector(`[data-testid=board] .rf-card[data-concept="${conceptId}"] >> text=适用场景（白板改名）`);
});

await step('board: an interleaved pre-v5 layout (topics mixed per row) is drawn with no overlapping sections, whole workbench and right column', async () => {
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  const order = (await topics()).flatMap((t) => t.subtopics.map((s) => s.conceptId));
  const cards = b.elements.filter((e) => e.type === 'concept').sort((x, y) => order.indexOf(x.conceptId) - order.indexOf(y.conceptId));
  const operations = cards.map((e, i) => ({ op: 'update', id: e.id, x: 22 + (i % 2) * 216, y: 30 + Math.floor(i / 2) * 112, width: 164, height: 66 }));
  const r = await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations });
  await eventually(async () => assert.equal(await page.getAttribute('[data-testid=board]', 'data-revision'), String(r.revision)));
  await page.waitForTimeout(300);
  await assertSectionsClean(page, 'pre-v5 layout, whole workbench');
  assert.match(await page.textContent('[data-testid=board-hint]'), /按主题整理/, 'the learner is pointed at 按主题整理');
  assert.equal(await page.locator('[data-testid=board-arrange].suggest').count(), 1);
  await page.screenshot({ path: join(shots, '06c-board-pre-v5-layout-packed.png') });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=off]');
  await page.click('[data-testid=board-fit]'); await page.waitForTimeout(300);
  await assertSectionsClean(page, 'pre-v5 layout, right column');
  await page.click('[data-testid=board-zoom]'); await page.click('[data-testid=board-zoom-full]');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=full]');
});

await step('board: 按主题整理 moves every card into its topic section in one CAS batch', async () => {
  await page.waitForSelector('[data-testid=board-arrange]:not([disabled])');
  const rev0 = (await readState()).boards[cid].revision;
  await page.click('[data-testid=board-arrange]');
  await eventually(async () => assert.equal((await readState()).boards[cid].revision, rev0 + 1));
  await page.waitForSelector('[data-testid=board-arrange][disabled]');
  const ev = (await readState()).events.at(-1);
  assert.equal(ev.summary, '白板：按主题整理'); assert.equal(ev.actor, 'learner');
  await assertSectionsClean(page, 'after 按主题整理');
});

await step('board: AI edits via tutor_board_read/patch refresh the board live, highlighted and tagged AI', async () => {
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  const note = b.elements.find((e) => e.type === 'note');
  const target = b.elements.find((e) => e.type === 'concept');
  const arrows0 = await arrowsOnScreen().count();
  const r = await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [
    { op: 'add', type: 'note', ref: 'n1', text: 'AI：先复习「间隔效应」再看调度算法', x: target.x + 230, y: target.y },
    { op: 'add', type: 'arrow', from: '$n1', to: target.id, label: '先看' },
    { op: 'update', id: note.id, x: note.x + 20, y: note.y + 10 },
  ] });
  assert.equal(r.revision, b.revision + 1);
  assert.match(r.refs.n1, /^note-/, 'the store assigned the note id');
  const t0 = Date.now();
  await page.waitForSelector(`[data-testid=board] .rf-card.note-ai[data-element="${r.refs.n1}"]`, { timeout: 4000 });
  const ms = Date.now() - t0;
  await eventually(async () => assert.equal(await arrowsOnScreen().count(), arrows0 + 1));
  assert.ok(await page.locator(`[data-testid=board] .rf-card.fresh[data-element="${r.refs.n1}"]`).count() === 1, 'AI change highlighted');
  assert.match(await page.textContent(`[data-testid=board] .rf-card[data-element="${r.refs.n1}"] .rf-by`), /AI/);
  assert.equal(await page.getAttribute('[data-testid=board]', 'data-revision'), String(r.revision));
  console.log(`     AI note on screen ${ms} ms after the write`);
  await eventually(() => assertSectionsClean(page, 'after an AI note beside a card'));
  const tgt = await cardById(target.id).boundingBox(), nb = await cardById(r.refs.n1).boundingBox();
  assert.ok(nb.x > tgt.x + tgt.width - 2 && Math.abs(nb.y - tgt.y) < 4, 'the AI note is drawn to the right of its card');
  await page.screenshot({ path: join(shots, '08-board-after-ai.png') });
});

await step('graph: an AI relation.propose shows up live as a new directed, labelled candidate edge', async () => {
  await tab('graph');
  await page.waitForSelector(`${G} .kg-concept`);
  const n0 = await page.locator(`${G} .react-flow__edge.kg-rel`).count();
  const st = await readState(); const cs = Object.values(st.concepts).filter((c) => c.courseId === cid && c.status !== 'archived');
  const has = (a, b) => Object.values(st.relations).some((r) => (r.from === a.id && r.to === b.id) || (r.from === b.id && r.to === a.id));
  let pair; for (const a of cs) { for (const b of cs) if (a.id !== b.id && a.topicId !== b.topicId && !has(a, b)) { pair = [a, b]; break; } if (pair) break; }
  await tools.tutor_write.execute({ action: 'relation.propose', payload_json: JSON.stringify({ from: pair[0].id, to: pair[1].id, type: 'relatedTo', note: 'e2e AI' }) });
  const t0 = Date.now();
  await eventually(async () => assert.equal(await page.locator(`${G} .react-flow__edge.kg-rel`).count(), n0 + 1));
  console.log(`     AI relation on the graph ${Date.now() - t0} ms after the write`);
  await page.screenshot({ path: join(shots, '08c-graph-after-ai.png') });
  await tab('board');
});

await step('CAS: a stale learner drag is rejected, the board reloads and says so (no overwrite)', async () => {
  const slow = await context.newPage();
  await slow.goto(`${url}?view=board&poll=600000`);
  await slow.waitForSelector('[data-testid=board] .rf-card');
  const id = await slow.locator('[data-testid=board] .rf-card').first().getAttribute('data-element');
  const before = await liveEl(id);
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', text: 'AI 并发写入', x: 40, y: 1400 }] });
  const c = await centreOf(slow.locator('[data-testid=board] .rf-card').first());
  await drag(slow, c, { x: c.x + 70, y: c.y + 40 }, 6);
  await slow.waitForSelector('[data-testid=notice].err', { timeout: 4000 });
  assert.match(await slow.textContent('[data-testid=notice]'), /刚改过/);
  const after = await liveEl(id);
  assert.deepEqual([after.x, after.y], [before.x, before.y], 'stale drag not written');
  await eventually(async () => assert.ok(await slow.locator('[data-testid=board] .rf-card >> text=AI 并发写入').count() === 1, 'reloaded to the latest board'));
  await assertSectionsClean(slow, 'conflict page');
  await slow.screenshot({ path: join(shots, '08b-board-conflict.png') });
  await slow.close();
});

await step('board: a drag during the default 1 s poll is not yanked back and keeps its base revision (review #2)', async () => {
  const el = card(3); const id = await el.getAttribute('data-element');
  const before = await liveEl(id);
  const c = await centreOf(el);
  await page.mouse.move(c.x, c.y); await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(c.x + i * 8, c.y + i * 6);
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'note', text: 'AI 在你拖动时加的', x: 40, y: 1500 }] });
  await eventually(async () => assert.equal(await page.getAttribute('[data-testid=board]', 'data-revision'), String(b.revision + 1)), 4000); // the poll landed mid-drag
  const now = await centreOf(cardById(id));
  assert.ok(now.x > c.x + 30, `card stays under the pointer (${now.x} vs start ${c.x})`);
  for (let i = 7; i <= 12; i++) await page.mouse.move(c.x + i * 8, c.y + i * 6);
  await page.mouse.up();
  await page.waitForSelector('[data-testid=notice].err');
  assert.match(await page.textContent('[data-testid=notice]'), /没有保存/);
  const after = await liveEl(id);
  assert.deepEqual([after.x, after.y], [before.x, before.y], 'stale drag not written with the new revision');
});

await step('board: Backspace never deletes; Delete only with focus inside the board; a selected arrow deletes too (review #5)', async () => {
  const el = card(2); const id = await el.getAttribute('data-element');
  await el.click();
  await page.keyboard.press('Backspace');
  await page.evaluate(() => { document.activeElement?.blur(); document.body.focus(); });
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  assert.ok(!(await liveEl(id)).deleted, 'card survives Backspace and Delete outside the board');
  await el.click();
  await page.keyboard.press('Delete');
  await eventually(async () => assert.ok((await liveEl(id)).deleted));
  await page.click('[data-testid=board-fit]');
  await page.waitForTimeout(200);
  let target = null;
  for (const a of (await boardEls()).filter((e) => e.type === 'arrow' && !e.deleted && !e.relationId)) {
    const pt = await arrowMidpoint(page, a.id);
    if (pt) { target = { a, pt }; break; }
  }
  assert.ok(target, 'an arrow is visible on the canvas');
  await page.mouse.click(target.pt.x, target.pt.y);
  await page.waitForSelector(`[data-testid=board] .react-flow__edge.selected[data-id="${target.a.id}"]`);
  await page.keyboard.press('Delete');
  await eventually(async () => assert.ok((await liveEl(target.a.id)).deleted, 'arrow deleted'));
});

await step('board: re-seed after deleting a card brings back the card and its relation arrow (review #6)', async () => {
  const st = await readState();
  const relArrow = st.boards[cid].elements.find((e) => e.type === 'arrow' && e.relationId && !e.deleted);
  const fromCard = st.boards[cid].elements.find((e) => e.id === relArrow.from);
  await cardById(fromCard.id).click();
  await page.click('[data-testid=board-delete]');
  await eventually(async () => assert.ok((await liveEl(relArrow.id)).deleted));
  await page.waitForSelector('[data-testid=board-seed]:not([disabled])');
  await page.click('[data-testid=board-seed]');
  await eventually(async () => {
    const els = (await boardEls()).filter((e) => !e.deleted);
    assert.ok(els.some((e) => e.type === 'concept' && e.conceptId === fromCard.conceptId));
    assert.ok(els.some((e) => e.type === 'arrow' && e.relationId === relArrow.relationId));
  });
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-testid=tutor-workbench][data-mm-zoom=off]');
});

// ── 数据 tab (SQLite read models, Glide Data Grid chunk) + knowledge point links (real conceptId) + to-dos / calendar ──
/** Click a Glide (canvas) cell by row key + column id, using the geometry the wrapper exposes. */
async function gridClick(testId, key, colId) {
  const g = page.locator(`[data-testid=${testId}]`);
  await g.locator('canvas').first().waitFor();
  const geo = await g.evaluate((el) => ({ keys: JSON.parse(el.dataset.rowKeys), cols: JSON.parse(el.dataset.cols), hh: +el.dataset.headerH, rh: +el.dataset.rowH }));
  const r = geo.keys.indexOf(key); assert.ok(r >= 0, `row ${key} is in ${testId}`);
  let x = 0; for (const c of geo.cols) { if (c.id === colId) { x += c.w / 2; break; } x += c.w; }
  const box = await g.boundingBox();
  const y = geo.hh + r * geo.rh + geo.rh / 2;
  assert.ok(y < box.height, `row ${r} visible in the grid`);
  await page.mouse.click(box.x + x, box.y + y);
}
const gridRows = (testId) => page.getAttribute(`[data-testid=${testId}]`, 'data-rows').then(Number);
/** The grid's accessibility table mirrors the visible canvas cells (Glide renders it inside the canvas element). */
const gridText = (testId) => page.locator(`[data-testid=${testId}] table`).first().textContent();
const focusedCard = () => page.locator('[data-testid=board] .rf-card.focus');
async function assertCardInView(id) {
  const host = await page.locator('[data-testid=board]').boundingBox();
  const c = await page.locator(`[data-testid=board] .rf-card[data-element="${id}"]`).boundingBox();
  assert.ok(c && c.x >= host.x && c.x + c.width <= host.x + host.width && c.y >= host.y && c.y + c.height <= host.y + host.height, `card ${id} is inside the visible board`);
}

await step('data: 数据 tab loads the Glide grid chunk; 知识点总表 has the real SQLite rows, sort + filter', async () => {
  await tab('data');
  await page.waitForSelector('[data-testid=grid-kp] canvas');
  const subs = (await topics()).flatMap((t) => t.subtopics);
  await eventually(async () => assert.equal(await gridRows('grid-kp'), subs.length));
  const keys = JSON.parse(await page.getAttribute('[data-testid=grid-kp]', 'data-row-keys'));
  assert.deepEqual(new Set(keys), new Set(subs.map((s) => s.conceptId)), 'one row per knowledge point, keyed by conceptId');
  const sqlRows = await store.data('knowledgePoints', { courseId: cid });
  assert.equal(sqlRows.length, subs.length);
  const txt = await gridText('grid-kp');
  assert.ok(txt.includes(subs[0].title), 'first knowledge point title drawn');
  assert.match(txt, /白板卡片 ›|主卡片/, 'board card link cells');
  // header click sorts (asc → desc → off)
  const g = await page.locator('[data-testid=grid-kp]').boundingBox();
  const cols = JSON.parse(await page.getAttribute('[data-testid=grid-kp]', 'data-cols'));
  const xOf = (id) => { let x = 0; for (const c of cols) { if (c.id === id) return x + c.w / 2; x += c.w; } return 0; };
  await page.mouse.click(g.x + xOf('title'), g.y + 17);
  await eventually(async () => assert.equal(await page.getAttribute('[data-testid=grid-kp]', 'data-sort'), 'title:asc'));
  await page.mouse.click(g.x + xOf('title'), g.y + 17);
  await eventually(async () => assert.equal(await page.getAttribute('[data-testid=grid-kp]', 'data-sort'), 'title:desc'));
  await page.mouse.click(g.x + xOf('title'), g.y + 17);
  await eventually(async () => assert.equal(await page.getAttribute('[data-testid=grid-kp]', 'data-sort'), ''));
  await page.fill('[data-testid=data-search]', subs[1].title.slice(0, 4));
  await eventually(async () => assert.ok((await gridRows('grid-kp')) < subs.length && (await gridRows('grid-kp')) >= 1));
  await page.fill('[data-testid=data-search]', '');
  await eventually(async () => assert.equal(await gridRows('grid-kp'), subs.length));
  for (const [k, id] of [['questions', 'grid-questions'], ['attempts', 'grid-attempts']]) {
    await page.click(`[data-testid=data-subtabs] [data-sub=${k}]`);
    await page.waitForSelector(`[data-testid=${id}] canvas`);
    assert.ok((await gridRows(id)) >= 1, `${k} table has real rows`);
  }
  await page.screenshot({ path: join(shots, '11-data-attempts.png') });
  await page.click('[data-testid=data-subtabs] [data-sub=kp]');
  await page.waitForSelector('[data-testid=grid-kp] canvas');
  await page.screenshot({ path: join(shots, '11-data-kp.png') });
});

await step('data → board: 「白板卡片」 link switches to 知识白板, centres the card and highlights it (conceptId, not title)', async () => {
  const b = await tools.tutor_board_read.execute({ courseId: cid });
  const card = b.elements.find((e) => e.type === 'concept' && b.elements.filter((x) => x.conceptId === e.conceptId).length === 1);
  await gridClick('grid-kp', card.conceptId, 'cards');
  await page.waitForSelector('[data-testid=board-view]');
  await eventually(async () => assert.equal(await focusedCard().getAttribute('data-element'), card.id));
  assert.equal(await page.getAttribute('[data-testid=board]', 'data-focus'), card.id);
  assert.equal(await focusedCard().getAttribute('data-concept'), card.conceptId);
  await eventually(() => assertCardInView(card.id));
  assert.match(await page.textContent('[data-testid=board-focus-note]'), /已定位到/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, '12-link-board-card.png') });
  // reverse: the board's 「知识点详情」 opens the same knowledge point in 数据
  await page.click('[data-testid=board-focus-detail]');
  await page.waitForSelector(`[data-testid=kp-detail][data-concept="${card.conceptId}"]`);
});

await step('data: a knowledge point without a board card reads 还没有白板卡片 — no dead link, the detail says so too', async () => {
  // the core keeps one card per knowledge point (a second add is refused), so "several cards" cannot arise from the tools
  let b = await tools.tutor_board_read.execute({ courseId: cid });
  const main = b.elements.find((e) => e.type === 'concept' && !e.stale);
  await assert.rejects(tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'add', type: 'concept', conceptId: main.conceptId, x: main.x, y: main.y + 120 }] }), /already on board/);
  // the AI removes one knowledge point's card → that row reads 还没有白板卡片 and the link is inert
  b = await tools.tutor_board_read.execute({ courseId: cid });
  const lonely = b.elements.find((e) => e.type === 'concept' && e.conceptId !== main.conceptId && !e.stale);
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b.revision, operations: [{ op: 'delete', id: lonely.id }] });
  assert.deepEqual((await store.data('knowledgePoints', { courseId: cid })).find((k) => k.concept_id === lonely.conceptId).board_cards, []);
  await tab('data');
  await page.waitForSelector('[data-testid=grid-kp] canvas');
  await eventually(async () => assert.match(await gridText('grid-kp'), /还没有白板卡片/));
  await gridClick('grid-kp', lonely.conceptId, 'cards');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-testid=data-view]').count(), 1, 'an empty link does not leave the data tab');
  await gridClick('grid-kp', lonely.conceptId, 'detail');
  await page.waitForSelector(`[data-testid=kp-detail][data-concept="${lonely.conceptId}"] [data-testid=kp-no-card]`);
  assert.equal(await page.locator('[data-testid=kp-go-card]').count(), 0, 'no dead card link in the detail');
  // put it back for the steps below (re-seed is idempotent)
  const b2 = await tools.tutor_board_read.execute({ courseId: cid });
  await tools.tutor_board_patch.execute({ courseId: cid, baseRevision: b2.revision, seed: true });
});

await step('data: 「详情」 opens the knowledge point detail (content, attempts) with links to its board card, outline row and graph node', async () => {
  await tab('data');
  await page.waitForSelector('[data-testid=grid-kp] canvas');
  const st = await readState();
  const a = Object.values(st.assessments).find((x) => x.conceptId);
  const c = st.concepts[a.conceptId];
  await gridClick('grid-kp', c.id, 'detail');
  await page.waitForSelector(`[data-testid=kp-detail][data-concept="${c.id}"]`);
  assert.equal(await page.textContent('[data-testid=kp-detail-title]'), c.title);
  const d = await page.textContent('[data-testid=kp-detail]');
  assert.ok(d.includes(a.question), 'the attempt on this knowledge point is listed');
  await page.screenshot({ path: join(shots, '13-kp-detail.png') });
  const cardId = await page.getAttribute('[data-testid=kp-go-card]', 'data-element');
  await page.click('[data-testid=kp-go-card]');
  await eventually(async () => assert.equal(await focusedCard().getAttribute('data-element'), cardId));
  assert.equal(await focusedCard().getAttribute('data-concept'), c.id);
  // back to the detail via the board toolbar (selected card → 知识点详情)
  await page.click('[data-testid=board-detail]');
  await page.waitForSelector(`[data-testid=kp-detail][data-concept="${c.id}"]`);
  await page.click('[data-testid=kp-go-outline]');
  await page.waitForSelector(`[data-testid=outline-view] .treerow.linkflash[data-concept-id="${c.id}"]`);
  assert.ok(await page.locator(`.treerow.sel[data-concept-id="${c.id}"]`).count() === 1);
  await page.screenshot({ path: join(shots, '13b-kp-outline.png') });
  // outline row 详情 → detail; detail → graph; graph detail → detail / board card
  await page.hover(`.treerow[data-concept-id="${c.id}"]`);
  await page.click(`.treerow[data-concept-id="${c.id}"] [data-testid=outline-detail]`);
  await page.waitForSelector(`[data-testid=kp-detail][data-concept="${c.id}"]`);
  await page.click('[data-testid=kp-go-graph]');
  await page.waitForSelector('[data-testid=graph-detail]');
  assert.ok((await page.textContent('[data-testid=graph-detail]')).includes(c.title));
  await page.click('[data-testid=graph-go-card]');
  await eventually(async () => assert.equal(await focusedCard().getAttribute('data-concept'), c.id));
  await tab('graph');
  await page.click('[data-testid=graph-go-detail]');
  await page.waitForSelector(`[data-testid=kp-detail][data-concept="${c.id}"]`);
});

await step('to-dos: add one due today linked to a knowledge point → 今天到期 + calendar (FullCalendar chunk); toggle; stale toggle conflicts', async () => {
  await tab('data');
  await page.click('[data-testid=data-subtabs] [data-sub=todos]');
  await page.waitForSelector('[data-testid=todo-form]');
  const c = Object.values((await readState()).concepts).find((x) => x.courseId === cid && x.status === 'active');
  // due later today in the learner's zone (America/Phoenix in this browser context)
  const due = await page.evaluate(() => { const d = new Date(); d.setHours(Math.min(23, d.getHours() + 1), 30, 0, 0); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; });
  await page.fill('[data-testid=todo-title]', 'e2e：复习这个知识点');
  await page.fill('[data-testid=todo-due]', due);
  await page.selectOption('[data-testid=todo-concept]', c.id);
  await page.click('[data-testid=todo-add]');
  await page.waitForSelector('[data-testid=due-today] >> text=e2e：复习这个知识点');
  const [t] = (await store.data('todos', { courseId: cid })).filter((x) => x.title === 'e2e：复习这个知识点');
  assert.equal(t.concept_id, c.id); assert.equal(t.created_by, 'learner'); const phx = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t.due_at)).replace(' ', 'T');
  assert.equal(phx, due, 'the instant stored is the wall-clock time the learner typed, in America/Phoenix');
  await page.waitForSelector('[data-testid=grid-todos] canvas');
  await page.screenshot({ path: join(shots, '14-todos-due-today.png') });
  await page.click('[data-testid=data-subtabs] [data-sub=calendar]');
  await page.waitForSelector('[data-testid=todo-calendar] .fc-event');
  assert.ok((await page.textContent('[data-testid=todo-calendar]')).includes('e2e：复习这个知识点'));
  await page.click('[data-testid=todo-calendar] .fc-timeGridWeek-button');
  await page.waitForSelector('[data-testid=todo-calendar] .fc-timegrid-event');
  await page.screenshot({ path: join(shots, '14b-calendar-week.png') });
  await page.click('[data-testid=todo-calendar] .fc-dayGridMonth-button');
  await page.waitForSelector('[data-testid=todo-calendar] .fc-daygrid-event');
  await page.screenshot({ path: join(shots, '14c-calendar-month.png') });
  // the AI updates the same to-do meanwhile; the learner's stale toggle is refused with the Chinese notice
  await store.todo('update', { id: t.id, baseRevision: t.revision, note: 'AI 补充：先做两道迁移题' }, { actor: 'ai' });
  await page.click(`[data-testid=due-today] [data-todo-id="${t.id}"] .tbtn`);
  await page.waitForSelector('[data-testid=notice] >> text=AI 或其他窗口刚改过这条待办，没有保存');
  await page.waitForTimeout(1300);
  await page.click(`[data-testid=due-today] [data-todo-id="${t.id}"] .tbtn`);
  await page.waitForSelector('[data-testid=notice] >> text=已标为完成');
  const [t2] = (await store.data('todos', { courseId: cid })).filter((x) => x.id === t.id);
  assert.equal(t2.status, 'done'); assert.equal(t2.revision, t.revision + 2);
  const ev = (await readState()).events.filter((e) => e.action?.startsWith('todo.'));
  assert.deepEqual(ev.map((e) => e.actor), ['learner', 'ai', 'learner']);
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
  await page.waitForSelector('text=适用场景（白板改名）');
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
