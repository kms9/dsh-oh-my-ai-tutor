import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newState, transition } from '../src/core.mjs';
import { SqliteTutorStore } from '../src/sqlite-store.mjs';
import { skeletonMindNodeId } from '../src/resources.mjs';
import { dispatch } from '../src/rpc.mjs';
import { toolSpecs } from '../src/tools.mjs';
import { internalHref, parseTutorHref, linksFor, LINK_KINDS } from '../src/links.mjs';
import { viewFor } from '../src/client/link-intercept.mjs';
import {
  SOURCE_NAME, RESOURCE_KINDS, encodeRef, decodeRef, clipboardTextFor, labelFor,
  makeReferenceInsert, catalogFromState, filterCatalog, resourceSnapshot, serializeResource,
} from '../src/context-ref.mjs';

function seed() {
  let state = newState();
  const run = (action, payload, actor = 'ai') => {
    const r = transition(state, action, payload, { actor, now: '2026-11-12T10:00:00.000Z' });
    state = r.state;
    return r.result;
  };
  const goal = run('goal.create', { title: 'G', expectedOutcome: 'O' });
  const course = run('course.create', { goalId: goal.id, title: '微积分' });
  run('course.plan', { courseId: course.id, syllabusRevision: 0, topics: [
    { title: '极限', subtopics: [{ title: '极限的定义' }, { title: '夹逼定理' }] },
  ] });
  run('course.approve', { courseId: course.id, syllabusRevision: 1 }, 'learner');
  const topic = state.courses[course.id].syllabus.topics[0];
  const sub = topic.subtopics[0];
  const parent = skeletonMindNodeId(sub.id);
  const added = run('mindmap.edit', { courseId: course.id, mindmapRevision: state.mindmaps[course.id].revision, operations: [
    { op: 'addChild', parentId: parent, title: '极限定义法' },
  ] }, 'learner');
  const mindNodeId = added.touched[0];
  const gn = run('graphNode.add', { courseId: course.id, title: '连续' });
  const rel = run('relation.propose', { from: `gn-${sub.conceptId}`, to: gn.id, type: 'relatedTo', note: '候选' });
  const lesson = run('lesson.create', { courseId: course.id, title: '第一课', topicId: topic.id, parts: [{ title: '定义', objective: '理解定义' }] });
  const note = run('note.add', { lessonId: lesson.id, title: '课堂笔记', content: '极限是逼近', conceptIds: [sub.conceptId] }, 'learner');
  run('board.seed', { courseId: course.id, baseRevision: 0 });
  const card = (state.boards[course.id].elements ?? []).find((e) => e.type === 'concept' && e.conceptId === sub.conceptId);
  return { get state() { return state; }, run, course, topic, sub, mindNodeId, graphNode: gn, relation: rel, lesson, note, card };
}

test('ref encoding and clipboard text round-trip for every resource kind', () => {
  for (const kind of RESOURCE_KINDS) {
    const ref = encodeRef({ kind, courseId: 'crs_1', id: 'obj_2' });
    assert.equal(ref, `${kind}:crs_1:obj_2`);
    assert.deepEqual(decodeRef(ref), { kind, courseId: 'crs_1', id: 'obj_2' });
    assert.equal(clipboardTextFor(ref), `@${kind}:obj_2`);
  }
  assert.equal(encodeRef({ kind: 'evil', courseId: 'c', id: 'x' }), null);
  assert.equal(decodeRef('not-a-ref'), null);
  assert.equal(decodeRef('concept:bad id:x'), null);
  const insert = makeReferenceInsert({ kind: 'concept', courseId: 'crs_1', id: 'c_1', title: '极限' });
  assert.equal(insert.source, SOURCE_NAME);
  assert.equal(insert.label, '知识点·极限');
  assert.equal(insert.ref, 'concept:crs_1:c_1');
  assert.equal(insert.clipboardText, '@concept:c_1');
  assert.equal(labelFor('mindmapNode', '极限定义法'), '导图节点·极限定义法');
});

test('catalog lists each kind and filterCatalog matches title, label and id', () => {
  const ctx = seed();
  const items = catalogFromState(ctx.state, ctx.course.id);
  const byKind = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, items.filter((i) => i.kind === k)]));
  assert.ok(byKind.concept.some((i) => i.id === ctx.sub.conceptId && i.title === '极限的定义'));
  assert.ok(byKind.mindmapNode.some((i) => i.id === ctx.mindNodeId && i.title === '极限定义法'));
  assert.ok(byKind.graphNode.some((i) => i.id === ctx.graphNode.id && i.title === '连续'));
  assert.ok(byKind.relation.some((i) => i.id === ctx.relation.id));
  assert.equal(byKind.topic[0].id, ctx.topic.id);
  assert.equal(byKind.outline[0].id, ctx.course.id);
  assert.ok(byKind.note.some((i) => i.id === ctx.note.id));
  assert.ok(byKind.lesson.some((i) => i.id === ctx.lesson.id));
  assert.ok(byKind.card.length >= 1);
  assert.equal(byKind.todo.length, 0);
  assert.equal(catalogFromState(ctx.state, 'missing').length, 0);
  const hits = filterCatalog(items, '定义法');
  assert.ok(hits.some((i) => i.kind === 'mindmapNode' && i.id === ctx.mindNodeId));
  assert.ok(hits.every((i) => JSON.stringify(i).includes('定义法') || i.title.includes('定义法') || i.id.includes('定义法') || i.kind.includes('定义法')));
  const byId = filterCatalog(items, ctx.sub.conceptId);
  assert.ok(byId.some((i) => i.id === ctx.sub.conceptId));
  assert.deepEqual(filterCatalog(items, ''), items);
  assert.deepEqual(filterCatalog(items, '不会出现的查询词xyz'), []);
});

test('serializeResource includes kind, id, content and a write/expand hint for each kind', () => {
  const ctx = seed();
  const cid = ctx.course.id;
  const cases = [
    ['concept', ctx.sub.conceptId, ['极限的定义', 'mastery', 'addChild']],
    ['mindmapNode', ctx.mindNodeId, ['极限定义法', 'parentId', 'tutor_mindmap_edit']],
    ['graphNode', ctx.graphNode.id, ['连续', 'relation.propose', 'candidate']],
    ['relation', ctx.relation.id, ['relatedTo', 'candidate', ctx.graphNode.id]],
    ['topic', ctx.topic.id, ['极限', 'addSubtopic', 'syllabusRevision']],
    ['outline', cid, ['微积分', 'tutor_outline_edit', 'syllabusRevision']],
    ['card', ctx.card.id, ['极限的定义', 'tutor_board_patch', 'boardRevision']],
    ['note', ctx.note.id, ['课堂笔记', '极限是逼近', 'note.update']],
    ['lesson', ctx.lesson.id, ['第一课', 'lesson.partWrite', 'planRevision']],
  ];
  for (const [kind, id, needles] of cases) {
    const ref = encodeRef({ kind, courseId: cid, id });
    const snap = resourceSnapshot(ctx.state, ref);
    assert.equal(snap.kind, kind, kind);
    assert.equal(snap.id, id, kind);
    assert.equal(snap.courseId, cid, kind);
    assert.ok(snap.title, kind);
    assert.ok(snap.hint, kind);
    const text = serializeResource(ctx.state, ref);
    assert.match(text, new RegExp(`kind=${kind}`));
    assert.match(text, new RegExp(`id=${id}`));
    assert.match(text, new RegExp(`courseId=${cid}`));
    for (const n of needles) assert.ok(text.includes(n), `${kind} should mention ${n}\n${text}`);
  }
});

test('serialize fails clearly when the object is gone; note.update changes the next snapshot', () => {
  const ctx = seed();
  assert.throws(() => serializeResource(ctx.state, encodeRef({ kind: 'concept', courseId: ctx.course.id, id: 'no-such' })), /学习资源不存在/);
  assert.throws(() => serializeResource(ctx.state, 'not-a-ref'), /无效/);
  const before = resourceSnapshot(ctx.state, encodeRef({ kind: 'note', courseId: ctx.course.id, id: ctx.note.id }));
  assert.equal(before.content, '极限是逼近');
  ctx.run('note.update', { noteId: ctx.note.id, content: '改写后的正文' }, 'ai');
  const after = resourceSnapshot(ctx.state, encodeRef({ kind: 'note', courseId: ctx.course.id, id: ctx.note.id }));
  assert.equal(after.content, '改写后的正文');
  assert.ok(serializeResource(ctx.state, encodeRef({ kind: 'note', courseId: ctx.course.id, id: ctx.note.id })).includes('改写后的正文'));
  assert.throws(() => ctx.run('note.update', { noteId: ctx.note.id }), /title or content/);
});

test('jump-link kinds cover mind-map nodes, graph nodes, relations, todos and review cards', () => {
  for (const kind of ['mindmapNode', 'graphNode', 'relation', 'todo', 'review']) {
    assert.ok(LINK_KINDS.includes(kind), kind);
    const href = internalHref(kind, 'obj_1', 'crs_1');
    assert.equal(href, `https://tutor.invalid/${kind}/obj_1?course=crs_1`);
    assert.deepEqual(parseTutorHref(href), { kind, id: 'obj_1', courseId: 'crs_1' });
  }
  assert.equal(viewFor({ kind: 'mindmapNode' }), 'mindmap');
  assert.equal(viewFor({ kind: 'graphNode' }), 'graph');
  assert.equal(viewFor({ kind: 'relation' }), 'graph');
  assert.equal(viewFor({ kind: 'todo' }), 'data');
  assert.equal(viewFor({ kind: 'review' }), 'data');
  const ctx = seed();
  const links = linksFor(ctx.state, ctx.course.id, {
    mindmapNodeIds: [ctx.mindNodeId],
    graphNodeIds: [ctx.graphNode.id],
    relationIds: [ctx.relation.id],
  });
  assert.ok(links.some((l) => l.kind === 'mindmapNode' && l.id === ctx.mindNodeId && l.href.includes('/mindmapNode/')));
  assert.ok(links.some((l) => l.kind === 'graphNode' && l.id === ctx.graphNode.id));
  assert.ok(links.some((l) => l.kind === 'relation' && l.id === ctx.relation.id));
});

test('RPC catalog and serialize, including todos and review cards on SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'omt-ctx-'));
  try {
    const store = new SqliteTutorStore(join(dir, 'tutor.db'), { legacyJsonPath: null });
    store.open();
    const tools = Object.fromEntries(toolSpecs(store).map((t) => [t.name, t]));
    const w = async (action, payload) => tools.tutor_write.execute({ action, payload_json: JSON.stringify(payload) });
    const goal = (await w('goal.create', { title: 'G', expectedOutcome: 'O' })).result;
    const c = (await w('course.create', { goalId: goal.id, title: '二次函数' })).result;
    const plan = (await w('course.plan', { courseId: c.id, syllabusRevision: 0, topics: [
      { title: '图像', subtopics: [{ title: '开口方向' }] },
    ] })).result;
    await dispatch(store, { method: 'mutate', payload: { action: 'course.approve', input: { courseId: c.id, syllabusRevision: plan.syllabus.revision } } });
    const state = await store.read();
    const conceptId = state.courses[c.id].syllabus.topics[0].subtopics[0].conceptId;
    const created = await store.todo('create', { courseId: c.id, title: '复习开口', conceptId }, { actor: 'learner' });
    const todo = created.todo;
    const catalog = await dispatch(store, { method: 'contextCatalog', payload: { courseId: c.id } });
    assert.equal(catalog.courseId, c.id);
    assert.ok(catalog.items.some((i) => i.kind === 'concept' && i.id === conceptId));
    assert.ok(catalog.items.some((i) => i.kind === 'todo' && i.id === todo.id && i.title === '复习开口'));
    assert.ok(catalog.items.some((i) => i.kind === 'review' && i.title.includes('开口方向')));
    const review = catalog.items.find((i) => i.kind === 'review');
    const serTodo = await dispatch(store, { method: 'contextSerialize', payload: { ref: encodeRef({ kind: 'todo', courseId: c.id, id: todo.id }) } });
    assert.match(serTodo.text, /kind=todo/);
    assert.match(serTodo.text, /复习开口/);
    assert.equal(serTodo.snapshot.revision, todo.revision);
    const serReview = await dispatch(store, { method: 'contextSerialize', payload: { ref: encodeRef({ kind: 'review', courseId: c.id, id: review.id }) } });
    assert.match(serReview.text, /kind=review/);
    assert.match(serReview.text, /tutor_review_rate/);
    await assert.rejects(dispatch(store, { method: 'contextSerialize', payload: { ref: encodeRef({ kind: 'todo', courseId: c.id, id: 'nope' }) } }), /学习资源不存在/);
    const links = (await tools.tutor_links.execute({ courseId: c.id, todoIds: [todo.id], reviewIds: [review.id] })).links;
    assert.ok(links.some((l) => l.kind === 'todo' && l.id === todo.id));
    assert.ok(links.some((l) => l.kind === 'review' && l.id === review.id));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

