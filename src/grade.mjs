// Objective vs subjective questions. choice / multi / fill carry an answer key that is written when the question is
// asked and frozen before the learner answers; the store (not the model) grades them against that key. short answers
// stay model-graded and provisional ('model-unverified'). The key never reaches a learner-facing surface while the
// question is still open (see publicQuestion / redactAssessment).

export const QUESTION_TYPES = Object.freeze(['choice', 'multi', 'fill', 'short']);
export const OBJECTIVE_TYPES = Object.freeze(['choice', 'multi', 'fill']);
export const FILL_MATCH = Object.freeze(['normalized', 'numeric', 'exact']);
export const JUDGED_BY_KEY = 'answer-key';
export const JUDGED_BY_MODEL = 'model-unverified';

const MAX_OPTIONS = 12, MAX_ACCEPTED = 20, MAX_OPTION_TEXT = 1000, MAX_ACCEPTED_TEXT = 500;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (obj, keys, what) => {
  const extra = Object.keys(obj).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${what} has unknown field(s): ${extra.join(', ')} (allowed: ${keys.join(', ')})`);
};

/** Unicode-normalised, trimmed, whitespace-collapsed, case-folded text (full-width letters/digits fold via NFKC). */
export function normalizeText(v) {
  return String(v ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** A plain number: 5, -5, 5.0, .5, 1e3, or a simple fraction like 1/2 or -3/4. null when it is not one. */
export function parseNumber(v) {
  const s = String(v ?? '').normalize('NFKC').replace(/[\u2212\u2013\u2014]/g, '-').replace(/\s+/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!s) return null;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(s)) { const n = Number(s); return Number.isFinite(n) ? n : null; }
  const f = /^([+-]?\d+)\/([+-]?\d+)$/.exec(s);
  if (f) { const d = Number(f[2]); if (d === 0) return null; const n = Number(f[1]) / d; return Number.isFinite(n) ? n : null; }
  return null;
}
const numEq = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function normalizeOptions(raw, type) {
  if (!Array.isArray(raw) || raw.length < 2) throw new Error(`${type} questions need options: an array of at least 2 {id, text} (e.g. [{"id":"A","text":"..."},{"id":"B","text":"..."}])`);
  if (raw.length > MAX_OPTIONS) throw new Error(`At most ${MAX_OPTIONS} options`);
  const ids = new Set(), texts = new Set();
  return raw.map((o, i) => {
    if (!isObj(o)) throw new Error(`options[${i}] must be an object {id, text}`);
    only(o, ['id', 'text'], `options[${i}]`);
    const id = typeof o.id === 'string' ? o.id.normalize('NFKC').trim() : '';
    if (!/^[A-Za-z0-9]{1,3}$/.test(id)) throw new Error(`options[${i}].id must be a short label like "A" (letters/digits, max 3)`);
    const text = typeof o.text === 'string' ? o.text.trim() : '';
    if (!text) throw new Error(`options[${i}].text is required`);
    if (text.length > MAX_OPTION_TEXT) throw new Error(`options[${i}].text is too long (max ${MAX_OPTION_TEXT})`);
    if (ids.has(id.toLowerCase())) throw new Error(`Duplicate option id: ${id}`);
    if (texts.has(normalizeText(text))) throw new Error(`Duplicate option text: ${text}`);
    ids.add(id.toLowerCase()); texts.add(normalizeText(text));
    return { id, text };
  });
}
const optionById = (options, id) => options.find((o) => o.id.toLowerCase() === String(id ?? '').normalize('NFKC').trim().toLowerCase());

/**
 * Validates lesson.ask's type / options / answerKey and returns the frozen spec stored on the pending question.
 * type defaults to 'short'. choice / multi / fill without a valid key (and options) are refused.
 */
export function questionSpec(payload = {}) {
  const type = payload.type === undefined || payload.type === null ? 'short' : payload.type;
  if (!QUESTION_TYPES.includes(type)) throw new Error(`type must be one of ${QUESTION_TYPES.join(' | ')}`);
  const { options: rawOptions, answerKey: key } = payload;
  if (type === 'short') {
    if (rawOptions !== undefined) throw new Error('short questions take no options (use type "choice" or "multi")');
    if (key !== undefined) throw new Error('short questions are model-graded and take no answerKey (use "choice", "multi" or "fill" for a keyed question)');
    return { type };
  }
  if (type === 'fill' && rawOptions !== undefined) throw new Error('fill questions take no options');
  if (!isObj(key)) throw new Error(`${type} questions need an answerKey written now, before the learner answers (${KEY_HINT[type]})`);
  if (type === 'fill') {
    only(key, ['accepted', 'match'], 'answerKey');
    const match = key.match === undefined ? 'normalized' : key.match;
    if (!FILL_MATCH.includes(match)) throw new Error(`answerKey.match must be one of ${FILL_MATCH.join(' | ')}`);
    if (!Array.isArray(key.accepted) || !key.accepted.length) throw new Error(`fill answerKey.accepted must be a non-empty array of acceptable answers (${KEY_HINT.fill})`);
    if (key.accepted.length > MAX_ACCEPTED) throw new Error(`At most ${MAX_ACCEPTED} accepted answers`);
    const accepted = key.accepted.map((a, i) => {
      const s = typeof a === 'number' && Number.isFinite(a) ? String(a) : typeof a === 'string' ? a.trim() : '';
      if (!s) throw new Error(`answerKey.accepted[${i}] must be a non-empty string`);
      if (s.length > MAX_ACCEPTED_TEXT) throw new Error(`answerKey.accepted[${i}] is too long (max ${MAX_ACCEPTED_TEXT})`);
      if (match === 'numeric' && parseNumber(s) === null) throw new Error(`answerKey.accepted[${i}] is not a number ("${s}"); numeric matching needs numbers like 5, 2.5 or 1/2`);
      return s;
    });
    return { type, answerKey: { accepted: [...new Set(accepted)], match } };
  }
  const options = normalizeOptions(rawOptions, type);
  only(key, ['correct'], 'answerKey');
  if (type === 'choice') {
    if (typeof key.correct !== 'string') throw new Error(`choice answerKey.correct must be one option id (${KEY_HINT.choice})`);
    const o = optionById(options, key.correct);
    if (!o) throw new Error(`answerKey.correct "${key.correct}" is not one of the option ids (${options.map((x) => x.id).join(', ')})`);
    return { type, options, answerKey: { correct: o.id } };
  }
  if (!Array.isArray(key.correct) || !key.correct.length) throw new Error(`multi answerKey.correct must be a non-empty array of option ids (${KEY_HINT.multi})`);
  const correct = key.correct.map((c) => {
    const o = typeof c === 'string' ? optionById(options, c) : null;
    if (!o) throw new Error(`answerKey.correct "${c}" is not one of the option ids (${options.map((x) => x.id).join(', ')})`);
    return o.id;
  });
  if (new Set(correct).size !== correct.length) throw new Error('answerKey.correct has duplicate option ids');
  return { type, options, answerKey: { correct: options.map((o) => o.id).filter((id) => correct.includes(id)) } };
}
const KEY_HINT = {
  choice: 'options:[{id:"A",text},{id:"B",text}], answerKey:{correct:"A"}',
  multi: 'options:[{id:"A",text},...], answerKey:{correct:["A","C"]}',
  fill: 'answerKey:{accepted:["5","-5"], match?:"normalized"|"numeric"|"exact"}',
};

export const isObjective = (q) => Boolean(q && OBJECTIVE_TYPES.includes(q.type) && q.answerKey);

// chat-style wrappers around a choice answer: 选A / 选择 A / 答案是A / 我选 B / (A) / A. / A。
const LEAD = /^(?:我(?:的答案)?(?:选择?|是)|答案(?:是|为)?|应该?(?:选|是)|选择?|answer(?:\s*is)?|my answer is|i choose|i pick)\s*[:：]?\s*/i;
const stripLead = (s) => s.replace(LEAD, '').replace(/^[(（[【]\s*/, '').replace(/\s*[)）\]】]$/, '').replace(/[.。．!！,，、;；:：\s]+$/, '').trim();

/** One option id from a learner's answer: the id itself, the option text, or "A. text"; null when not unambiguous. */
function parseChoice(answer, options) {
  const raw = String(answer ?? '').normalize('NFKC').trim();
  for (const s of [...new Set([raw, raw.replace(/[.。．!！,，、;；:：\s]+$/, ''), stripLead(raw)])].filter(Boolean)) {
    const byId = optionById(options, s);
    if (byId) return byId.id;
    const byText = options.filter((o) => normalizeText(o.text) === normalizeText(s));
    if (byText.length === 1) return byText[0].id;
  }
  // "A. text" / "A、text" / "A text": the id and the text must agree
  const m = /^([A-Za-z0-9]{1,3})\s*[.、)）:：\s]\s*(.+)$/.exec(stripLead(raw));
  if (m) {
    const o = optionById(options, m[1]);
    if (o && normalizeText(m[2].replace(/[.。．!！,，、;；:：\s]+$/, '')) === normalizeText(o.text)) return o.id;
  }
  return null;
}
/** A set of option ids from "A,C" / "A C" / "A和C" / "AC" / option texts; null when any part is not an option. */
function parseMulti(answer, options) {
  const raw = stripLead(String(answer ?? '').normalize('NFKC').trim());
  if (!raw) return null;
  const whole = parseChoice(raw, options);
  const tokens = raw.split(/\s*(?:[,，、;；/&+|]|和|与|及|以及|\band\b|\s)\s*/i).map((t) => stripLead(t)).filter(Boolean);
  const ids = [];
  let ok = tokens.length > 0;
  for (const t of tokens) { const id = parseChoice(t, options); if (!id) { ok = false; break; } ids.push(id); }
  if (ok) return [...new Set(ids)];
  // compact "AC" when every option id is one character
  if (options.every((o) => o.id.length === 1) && /^[A-Za-z0-9]+$/.test(raw)) {
    const chars = [...raw].map((c) => optionById(options, c)?.id);
    if (chars.every(Boolean)) return [...new Set(chars)];
  }
  // a set of option texts joined by separators that also appear inside texts: try a greedy text cover
  const n = normalizeText(raw);
  const hits = options.filter((o) => n.includes(normalizeText(o.text)));
  if (hits.length) {
    let rest = n;
    for (const o of [...hits].sort((a, b) => b.text.length - a.text.length)) rest = rest.split(normalizeText(o.text)).join(' ');
    if (!rest.replace(/[\s,，、;；/&+|和与及]|以及|\band\b/gi, '')) return hits.map((o) => o.id);
  }
  return whole ? [whole] : null;
}

/**
 * Grades one answer against a frozen spec. Returns { score: 0|1, correct, parsed, matched } — `parsed` is what the
 * store understood the learner to have chosen (option ids, or null), `matched` the accepted answer that matched.
 */
export function gradeAnswer(spec, studentAnswer) {
  if (!isObjective(spec)) throw new Error('gradeAnswer needs a choice / multi / fill question with an answer key');
  const answer = String(studentAnswer ?? '');
  if (spec.type === 'choice') {
    const id = parseChoice(answer, spec.options);
    const correct = id !== null && id === spec.answerKey.correct;
    return { score: correct ? 1 : 0, correct, parsed: id, matched: correct ? id : null };
  }
  if (spec.type === 'multi') {
    const ids = parseMulti(answer, spec.options);
    const want = new Set(spec.answerKey.correct);
    const correct = Array.isArray(ids) && ids.length === want.size && ids.every((x) => want.has(x));
    const parsed = ids ? spec.options.map((o) => o.id).filter((x) => ids.includes(x)) : null;
    return { score: correct ? 1 : 0, correct, parsed, matched: correct ? parsed : null };
  }
  const { accepted, match = 'normalized' } = spec.answerKey;
  let hit = null;
  if (match === 'exact') hit = accepted.find((a) => a.trim() === answer.trim()) ?? null;
  else if (match === 'numeric') {
    const x = parseNumber(answer);
    if (x !== null) hit = accepted.find((a) => { const y = parseNumber(a); return y !== null && numEq(x, y); }) ?? null;
  } else {
    const n = normalizeText(answer);
    hit = n ? accepted.find((a) => normalizeText(a) === n) ?? null : null;
  }
  return { score: hit !== null ? 1 : 0, correct: hit !== null, parsed: null, matched: hit };
}

/** The expected answer in readable form (only for surfaces where the question is already answered/closed). */
export function expectedAnswer(spec) {
  if (!isObjective(spec)) return null;
  if (spec.type === 'fill') return { accepted: spec.answerKey.accepted, match: spec.answerKey.match ?? 'normalized',
    text: spec.answerKey.accepted.join(' / ') };
  const ids = spec.type === 'choice' ? [spec.answerKey.correct] : spec.answerKey.correct;
  const opts = ids.map((id) => spec.options.find((o) => o.id === id)).filter(Boolean);
  return { correct: spec.answerKey.correct, text: opts.map((o) => `${o.id}. ${o.text}`).join('；') };
}

/** Learner-/model-facing view of a question while it is open: everything but the answer key. */
export function publicQuestion(q) {
  if (!q || typeof q !== 'object') return q ?? null;
  const { answerKey, ...rest } = q;
  return { ...rest, type: q.type ?? 'short', ...(answerKey ? { hasAnswerKey: true } : {}) };
}
/** An assessment as shown outside the store: its key is hidden while its question is still open. */
export function redactAssessment(a, openQuestionIds) {
  if (!a || !a.answerKey || !a.questionId || !openQuestionIds.has(a.questionId)) return a;
  const { answerKey, expectedAnswer: _e, ...rest } = a;
  return { ...rest, hasAnswerKey: true, keyWithheld: true };
}
