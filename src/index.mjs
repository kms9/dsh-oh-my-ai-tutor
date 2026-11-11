import { defineTool } from '@deepseek-ai/dsh-tools';
import { JsonTutorStore, defaultStatePath } from './store.mjs';
import { snapshot } from './core.mjs';
import { projectCourse } from './projections.mjs';
import { TUTOR_POLICY } from './prompt.mjs';

export const name = 'dsh-oh-my-ai-tutor';
export const inject = ['tools', 'systemPrompt'];

const obj = { type: 'object', additionalProperties: true };
const output = { schema: obj, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const actions = [
  'goal.create', 'source.register', 'course.create', 'course.linkSource', 'course.plan', 'course.approve',
  'lesson.create', 'lesson.approve', 'lesson.partWrite', 'lesson.cover', 'assessment.record',
  'lesson.reviewEnd', 'note.add', 'lesson.finish', 'relation.propose',
];

/** Prototype plugin: model-callable domain tools; native React learning workbench is a separate milestone. */
export function apply(ctx, config = {}) {
  const store = new JsonTutorStore(config.statePath || defaultStatePath());
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tutor_write',
    description: 'Persist a real learner tutoring event. Read the state first; only use approved transitions. Payload is JSON string. A learner answer must be actually supplied by the learner, never invented.',
    parameters: {
      action: { type: 'string', enum: actions, required: true },
      payload_json: { type: 'string', required: true, description: 'JSON object matching the chosen action; see the oh-my-ai-tutor SKILL.md.' },
      expectedRevision: { type: 'integer', description: 'Optional state revision for CAS; pass the one returned by tutor_read.' },
    }, output,
    async execute(args) {
      let payload;
      try { payload = JSON.parse(args.payload_json); } catch { throw new Error('payload_json must be valid JSON'); }
      if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('payload_json must be an object');
      return store.mutate(args.action, payload, args.expectedRevision);
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tutor_read',
    description: 'Read durable tutor domain state, optionally a single course. Does not read the DSH Session transcript.',
    parameters: { courseId: { type: 'string', description: 'Optional course id.' } }, output,
    async execute(args) { return snapshot(await store.read(), args.courseId); },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'tutor_visualize',
    description: 'Project one course as syllabus outline, Mermaid mindmap, semantic knowledge graph, or INITIAL whiteboard seed operations. Seed operations are not automatically applied.',
    parameters: {
      courseId: { type: 'string', required: true },
      view: { type: 'string', enum: ['outline', 'mindmap', 'graph', 'whiteboard-seed'], required: true },
    }, output,
    async execute(args) { return projectCourse(await store.read(), args.courseId, args.view); },
  })));
  // Opt-in only: never force a Tutor persona into unrelated DSH conversations.
  // Dedicated Tutor profiles may enable this, or load the explicit SKILL.md.
  if (config.enableGlobalTutorPolicy === true) {
    ctx.systemPrompt.section({ name: 'oh-my-ai-tutor:teaching-policy', order: 125, text: () => TUTOR_POLICY });
  }
}
