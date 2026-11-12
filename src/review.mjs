// FSRS review scheduling for knowledge points (ts-fsrs 6.0.0, MIT). Pure helpers; persistence is in sqlite-store.mjs.
// One review card per knowledge point. Day-level scheduling (no minute learning steps): a tutoring review is a
// conversation about a knowledge point, not a flash card you flip again in ten minutes.
import { fsrs, generatorParameters, createEmptyCard, Rating, State } from 'ts-fsrs';

export const RATINGS = Object.freeze({ again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy });
/** Short Chinese labels shown on the rating buttons (FSRS Again / Hard / Good / Easy). */
export const RATING_LABEL = Object.freeze({ 1: '忘了', 2: '吃力', 3: '想起来了', 4: '轻松' });
export const STATE_NAME = Object.freeze({ [State.New]: 'new', [State.Learning]: 'learning', [State.Review]: 'review', [State.Relearning]: 'relearning' });
const STATE_NUM = Object.freeze({ new: State.New, learning: State.Learning, review: State.Review, relearning: State.Relearning });
export const STATE_LABEL = Object.freeze({ new: '未开始', learning: '学习中', review: '复习中', relearning: '重新学习' });

export const scheduler = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false, maximum_interval: 365, request_retention: 0.9 }));

/** Rating from a recorded attempt: score 0..1 (hints lower it by one grade, never below Hard unless the score failed). */
export function ratingFromAttempt({ score, hintCount = 0 }) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  let r = s < 0.6 ? Rating.Again : s < 0.75 ? Rating.Hard : s < 0.9 ? Rating.Good : Rating.Easy;
  if (hintCount > 0 && r > Rating.Hard) r -= 1;
  return r;
}
/** Rating from a mastery label when a knowledge point has no scored attempt. */
export function ratingFromMastery(mastery) {
  return mastery === 'demonstrated' ? Rating.Good : mastery === 'developing' ? Rating.Hard : null;
}

/** DB row → ts-fsrs card */
export function cardFromRow(row) {
  if (!row || row.state === 'new' || !row.last_review_at) return createEmptyCard(new Date(row?.created_at ?? Date.now()));
  return {
    due: new Date(row.due_at), stability: row.stability ?? 0, difficulty: row.difficulty ?? 0, elapsed_days: 0,
    scheduled_days: row.scheduled_days ?? 0, learning_steps: row.learning_steps ?? 0, reps: row.reps ?? 0, lapses: row.lapses ?? 0,
    state: STATE_NUM[row.state] ?? State.New, last_review: new Date(row.last_review_at),
  };
}
/** ts-fsrs card → DB columns */
export function rowFromCard(card) {
  return { due_at: card.due.toISOString(), stability: round(card.stability), difficulty: round(card.difficulty), scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps ?? 0, reps: card.reps, lapses: card.lapses, state: STATE_NAME[card.state], last_review_at: card.last_review ? card.last_review.toISOString() : null };
}
const round = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);

/** One review: returns the next card and the log. `at` must not be before the card's last review. */
export function review(card, rating, at) {
  if (![1, 2, 3, 4].includes(rating)) throw new Error('rating must be 1 (忘了) | 2 (吃力) | 3 (想起来了) | 4 (轻松)');
  const when = card.last_review && at < card.last_review ? card.last_review : at;
  return scheduler.next(card, when, rating);
}
/** What each rating would do now (for the buttons: "想起来了 · 4 天后"). */
export function preview(card, at) {
  const rec = scheduler.repeat(card, card.last_review && at < card.last_review ? card.last_review : at);
  return Object.fromEntries([1, 2, 3, 4].map((r) => [r, { due: rec[r].card.due.toISOString(), days: rec[r].card.scheduled_days }]));
}

/**
 * Initial card for a knowledge point that already has evidence: replay its scored attempts in time order
 * (or one mastery-based review when there is no scored attempt). Returns null when there is no evidence.
 */
export function replay(attempts, { mastery, createdAt, masteryAt } = {}) {
  const scored = attempts.map((a) => ({ at: new Date(a.recorded_at ?? a.recordedAt), rating: ratingFromAttempt({ score: a.score, hintCount: a.hint_count ?? a.hintCount ?? 0 }), id: a.id ?? a.assessment_id }))
    .filter((a) => a.rating && Number.isFinite(a.at.getTime())).sort((a, b) => a.at - b.at);
  let card = createEmptyCard(new Date(createdAt ?? scored[0]?.at ?? Date.now()));
  const logs = [];
  if (scored.length) {
    for (const a of scored) { const r = review(card, a.rating, a.at); card = r.card; logs.push({ ...r.log, assessmentId: a.id }); }
    return { card, logs, source: 'attempts' };
  }
  const mr = ratingFromMastery(mastery);
  if (!mr) return null;
  const r = review(card, mr, new Date(masteryAt ?? createdAt ?? Date.now()));
  return { card: r.card, logs: [{ ...r.log, assessmentId: null }], source: 'mastery' };
}

/**
 * Spread initial cards that came out overdue so a migration never dumps them all on today:
 * the most overdue first, at most `perDay` per day starting today (local day of `now` is not known here; whole days from now).
 */
export function spreadOverdue(cards, now, perDay = 3) {
  const overdue = cards.filter((c) => c.card.due <= now).sort((a, b) => a.card.due - b.card.due);
  overdue.forEach((c, i) => {
    const day = Math.floor(i / perDay);
    c.card = { ...c.card, due: new Date(now.getTime() + day * 86400000) };
    c.spread = day;
  });
  return cards;
}
