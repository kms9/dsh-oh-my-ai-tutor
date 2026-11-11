import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { boardSeedPosition, assignTopics, sectionFrames, arrangeOps, BOARD_CARD, sectionGrid, packSections } from '../src/board-layout.mjs';
import { edgeSides, graphClusters, bestGraphLayout, fitViewport } from '../src/client/flow-layout.mjs';
import { transition, validateState } from '../src/core.mjs';

const fixture = validateState(JSON.parse(await readFile(new URL('./fixtures/spaced-repetition.state.json', import.meta.url), 'utf8')));
const course = Object.values(fixture.courses)[0];
const topics = course.syllabus.topics;
const concepts = Object.values(fixture.concepts).filter((c) => c.courseId === course.id);
const overlap = (p, q) => !(p.x + p.width <= q.x || q.x + q.width <= p.x || p.y + p.height <= q.y || q.y + q.height <= p.y);

test('seed positions: every concept card sits inside its own topic section, no two cards overlap', () => {
  const grid = sectionGrid(topics.map((t) => ({ id: t.id, count: t.subtopics.length })));
  const cards = [];
  for (const t of topics) for (const s of t.subtopics) {
    const p = boardSeedPosition(topics, s.conceptId), r = grid.get(t.id);
    const card = { ...p, ...BOARD_CARD };
    assert.ok(card.x >= r.x && card.y >= r.y && card.x + card.width <= r.x + r.width && card.y + card.height <= r.y + r.height, `${s.title} inside its section`);
    for (const c of cards) assert.ok(!overlap(c, card), `${s.title} overlaps another card`);
    cards.push(card);
  }
  const rects = [...grid.values()];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i], rects[j]), 'sections do not overlap');
});

test('board.seed through the store uses the section layout (schema unchanged: plain x/y/width/height)', () => {
  const { state } = transition(fixture, 'board.seed', { courseId: course.id, baseRevision: 0 }, { actor: 'learner' });
  const els = state.boards[course.id].elements.filter((e) => e.type === 'concept');
  assert.equal(els.length, concepts.filter((c) => c.status === 'active').length);
  for (const e of els) {
    assert.deepEqual(Object.keys(e).filter((k) => !['id', 'type', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt', 'conceptId', 'x', 'y', 'width', 'height', 'color'].includes(k)), []);
    assert.deepEqual({ x: e.x, y: e.y }, boardSeedPosition(topics, e.conceptId));
  }
  const frames = sectionFrames(state.boards[course.id].elements, topics, concepts);
  assert.equal(frames.length, topics.length, 'one section per topic');
  for (let i = 0; i < frames.length; i++) for (let j = i + 1; j < frames.length; j++) assert.ok(!overlap(frames[i], frames[j]));
});

test('sections: notes join the topic of a connected card, else the section they sit in, else stay free', () => {
  const t0 = topics[0], t1 = topics[1];
  const c0 = { id: 'c0', type: 'concept', conceptId: t0.subtopics[0].conceptId, x: 100, y: 100, ...BOARD_CARD };
  const c1 = { id: 'c1', type: 'concept', conceptId: t1.subtopics[0].conceptId, x: 900, y: 100, ...BOARD_CARD };
  const inside = { id: 'n1', type: 'note', text: 'a', x: 110, y: 110, ...BOARD_CARD };
  const linked = { id: 'n2', type: 'note', text: 'b', x: 2000, y: 2000, ...BOARD_CARD };
  const free = { id: 'n3', type: 'note', text: 'c', x: 4000, y: 4000, ...BOARD_CARD };
  const arrow = { id: 'a1', type: 'arrow', from: 'n2', to: 'c1' };
  const m = assignTopics([c0, c1, inside, linked, free, arrow], topics, concepts);
  assert.equal(m.get('c0'), t0.id); assert.equal(m.get('c1'), t1.id);
  assert.equal(m.get('n1'), t0.id); assert.equal(m.get('n2'), t1.id); assert.equal(m.get('n3'), null);
});

test('按主题整理: one batch of plain updates; after applying it every card is in its section and a second run is a no-op', () => {
  // old two-column grid boards (before sections) get rearranged
  const els = [];
  topics.flatMap((t) => t.subtopics).forEach((s, i) => els.push({ id: `card-${i}`, type: 'concept', conceptId: s.conceptId, x: 22 + (i % 2) * 216, y: 30 + Math.floor(i / 2) * 112, width: 164, height: 66 }));
  els.push({ id: 'note-1', type: 'note', text: '计划', x: 22, y: 2000, width: 164, height: 66 }, { id: 'arrow-1', type: 'arrow', from: 'note-1', to: 'card-0' });
  const ops = arrangeOps(els, topics, concepts);
  assert.ok(ops.length > 0 && ops.length <= 100);
  for (const op of ops) assert.equal(op.op, 'update');
  const moved = els.map((e) => { const o = ops.find((x) => x.id === e.id); return o ? { ...e, ...o, op: undefined } : e; });
  assert.deepEqual(arrangeOps(moved, topics, concepts), [], 'idempotent');
  const m = assignTopics(moved, topics, concepts);
  assert.equal(m.get('note-1'), m.get('card-0'), 'the connected note sits in its card topic section');
  const cards = moved.filter((e) => e.type !== 'arrow');
  for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) assert.ok(!overlap(cards[i], cards[j]), `${cards[i].id} / ${cards[j].id}`);
});

test('flow helpers: edge sides, graph clusters, readable fit', () => {
  assert.deepEqual(edgeSides({ x: 0, y: 0, width: 100, height: 50 }, { x: 300, y: 10, width: 100, height: 50 }), ['r', 'l']);
  assert.deepEqual(edgeSides({ x: 0, y: 300, width: 100, height: 50 }, { x: 10, y: 0, width: 100, height: 50 }), ['t', 'b']);
  const nodes = concepts.map((c) => ({ id: c.id, label: c.title, topicId: c.topicId }));
  const l = graphClusters(nodes, [], topics, 2, 2);
  assert.equal(l.positions.size, nodes.length);
  const rects = [...l.positions.values()];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) assert.ok(!overlap(rects[i], rects[j]));
  const wide = bestGraphLayout(nodes, [], topics, 1400, 700), tall = bestGraphLayout(nodes, [], topics, 400, 1400);
  assert.ok(wide.columns > tall.columns, 'wide canvases get more clusters per row');
  const v = fitViewport({ x: 0, y: 0, width: 2000, height: 1000 }, 500, 400, { minZoom: 0.8 });
  assert.equal(v.zoom, 0.8); assert.equal(v.overflow, true);
  const f = fitViewport({ x: 0, y: 0, width: 300, height: 200 }, 800, 600, { minZoom: 0.8, maxZoom: 1.15 });
  assert.equal(f.zoom, 1.15); assert.equal(f.overflow, false);
});

/** Pairwise-disjoint frames, every card drawn inside its own frame and over no other frame. */
function assertPacked(els, label, columns = 2) {
  const L = packSections(els, topics, concepts, undefined, { columns });
  const f = L.frames;
  for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) assert.ok(!overlap(f[i], f[j]), `${label}: sections ${f[i].title} / ${f[j].title} overlap`);
  for (const c of els.filter((e) => e.type !== 'arrow')) {
    const o = L.offsetOf(c.id); const r = { x: c.x + o.dx, y: c.y + o.dy, width: c.width, height: c.height };
    const own = L.assignment.get(c.id);
    for (const fr of f) {
      if (fr.id === own) assert.ok(r.x >= fr.x && r.y >= fr.y + 30 && r.x + r.width <= fr.x + fr.width && r.y + r.height <= fr.y + fr.height, `${label}: ${c.id} inside its section (below the title)`);
      else assert.ok(!overlap(r, fr), `${label}: ${c.id} drawn over section ${fr.title}`);
    }
  }
  return L;
}
const oldGrid = () => {
  // the layout of the real-DSH board before v5 (a two-column grid in concept order, topics interleaved per row)
  const els = topics.flatMap((t) => t.subtopics).map((s, i) => ({ id: `card-${i}`, type: 'concept', conceptId: s.conceptId, x: 22 + (i % 2) * 216, y: 30 + Math.floor(i / 2) * 112, width: 164, height: 66 }));
  els.push({ id: 'note-plan', type: 'note', text: '计划', x: 360, y: 544, width: 164, height: 66 }, { id: 'note-far', type: 'note', text: '先试两周', x: 22, y: 904, width: 164, height: 66 },
    { id: 'a1', type: 'arrow', from: 'note-far', to: 'card-9' });
  return els;
};

test('packed sections: the interleaved pre-v5 board is drawn with no overlapping sections and no card over another section', () => {
  const els = oldGrid();
  // the stored frames really do overlap (this is what the v5 screenshots showed)
  const stored = sectionFrames(els, topics, concepts);
  assert.ok(stored.some((a, i) => stored.some((b, j) => j > i && overlap(a, b))), 'stored layout overlaps');
  assertPacked(els, 'pre-v5');
  assertPacked(els, 'pre-v5, 3 columns (whole workbench)', 3);
});

test('packed sections: seeded and 按主题整理 boards are drawn exactly where they are stored (all offsets 0)', () => {
  const { state } = transition(fixture, 'board.seed', { courseId: course.id, baseRevision: 0 }, { actor: 'learner' });
  const seeded = state.boards[course.id].elements;
  const L = assertPacked(seeded, 'seeded');
  for (const e of seeded) if (e.type !== 'arrow') assert.deepEqual(L.offsetOf(e.id), { dx: 0, dy: 0 }, e.id);
  const els = oldGrid();
  const ops = arrangeOps(els, topics, concepts);
  const arranged = els.map((e) => { const o = ops.find((x) => x.id === e.id); return o ? { ...e, ...o, op: undefined } : e; });
  const A = assertPacked(arranged, 'arranged');
  for (const e of arranged) if (e.type !== 'arrow') assert.deepEqual(A.offsetOf(e.id), { dx: 0, dy: 0 }, e.id);
});

test('packed sections: a card dragged far away, AI notes beside cards and random boards never overlap', () => {
  const { state } = transition(fixture, 'board.seed', { courseId: course.id, baseRevision: 0 }, { actor: 'learner' });
  const seeded = state.boards[course.id].elements;
  // learner dragged a card deep into the neighbouring section; AI put a note 230 px to the right of a card + arrow
  const dragged = seeded.map((e, i) => (i === 2 ? { ...e, x: e.x + 500, y: e.y + 260 } : e));
  const target = seeded[0];
  dragged.push({ id: 'n-ai', type: 'note', text: 'AI', x: target.x + 230, y: target.y, ...BOARD_CARD }, { id: 'a-ai', type: 'arrow', from: 'n-ai', to: target.id });
  const L = assertPacked(dragged, 'dragged');
  assert.equal(L.assignment.get('n-ai'), L.assignment.get(target.id), 'a connected AI note stays with its card');
  let seed = 7; const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  for (let k = 0; k < 150; k++) {
    const els = seeded.map((e) => ({ ...e, x: Math.round(rnd() * 1400), y: Math.round(rnd() * 1400) }));
    for (let n = 0; n < 4; n++) els.push({ id: `rn-${n}`, type: 'note', text: 'n', x: Math.round(rnd() * 1600), y: Math.round(rnd() * 1600), ...BOARD_CARD });
    assertPacked(els, `random ${k}`);
    assertPacked(els, `random ${k}, 3 columns`, 3);
  }
});
