import { defineTool } from '@deepseek-ai/dsh-tools';
import { JsonTutorStore, defaultStatePath } from './store.mjs';
import { toolSpecs } from './tools.mjs';
import { createRpcHandler, ENDPOINT } from './rpc.mjs';
import { TUTOR_POLICY } from './prompt.mjs';

export const name = 'dsh-oh-my-ai-tutor';
export const inject = ['tools', 'systemPrompt'];

const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

/** Model-callable domain tools + (when the web host has a connection) the workbench RPC route used by the sidebar UI. */
export function apply(ctx, config = {}) {
  const store = new JsonTutorStore(config.statePath || defaultStatePath());
  for (const spec of toolSpecs(store)) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: spec.name, description: spec.description, parameters: spec.parameters, output,
      execute: (args, exec) => spec.execute(args, exec),
    })));
  }
  // Optional: headless profiles have no browser connection; the workbench simply is not served there.
  ctx.inject(['connection'], (web) => {
    web.effect(() => web.connection.fetch.register({ path: `/api/${ENDPOINT}`, methods: ['POST'], requestBody: 'buffered', fetch: createRpcHandler(store) }));
  });
  // Opt-in only: never force a Tutor persona into unrelated DSH conversations.
  if (config.enableGlobalTutorPolicy === true) {
    ctx.systemPrompt.section({ name: 'oh-my-ai-tutor:teaching-policy', order: 125, text: () => TUTOR_POLICY });
  }
}
