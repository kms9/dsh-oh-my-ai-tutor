import { defineTool } from '@deepseek-ai/dsh-tools';
import { toolSpecs } from './tools.mjs';
import { createRpcHandler, ENDPOINT } from './rpc.mjs';
import { TUTOR_POLICY } from './prompt.mjs';
import { TutorStoreHub } from './workspace-store.mjs';

export const name = 'dsh-oh-my-ai-tutor';
export const inject = ['tools', 'systemPrompt'];

const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };

/** Model-callable domain tools + (when the web host has a connection) the workbench RPC route used by the sidebar UI. */
export function apply(ctx, config = {}) {
  // Route B: one SQLite file per workspace under $DSH_HOME/oh-my-ai-tutor/<workspace-key>/tutor.db.
  // The session's immutable header.cwd is the only path anchor (never process.cwd() or a later cd).
  // No workspace → the existing global $DSH_HOME/oh-my-ai-tutor/tutor.db. config.dbPath / statePath still wins.
  // `storage: json` keeps the JSON file store (no data panel / to-dos), also isolated per workspace.
  const hub = new TutorStoreHub(config, {
    sessions: () => { try { return ctx.get?.('sessions') ?? ctx.sessions; } catch { return null; } },
  });
  ctx.effect(() => () => hub.close());
  for (const spec of toolSpecs((exec) => hub.resolveFromExec(exec))) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: spec.name, description: spec.description, parameters: spec.parameters, output,
      execute: (args, exec) => spec.execute(args, exec),
    })));
  }
  // Optional: headless profiles have no browser connection; the workbench simply is not served there.
  ctx.inject(['connection'], (web) => {
    web.effect(() => web.connection.fetch.register({
      path: `/api/${ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
      fetch: createRpcHandler((payload) => hub.resolveForWorkbench({ sessionId: payload?.sessionId ?? payload?.payload?.sessionId, cwd: payload?.cwd ?? payload?.payload?.cwd })),
    }));
  });
  // Opt-in only: never force a Tutor persona into unrelated DSH conversations.
  if (config.enableGlobalTutorPolicy === true) {
    ctx.systemPrompt.section({ name: 'oh-my-ai-tutor:teaching-policy', order: 125, text: () => TUTOR_POLICY });
  }
}
