import test from 'node:test';
import assert from 'node:assert/strict';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { toolSpecs } from '../src/tools.mjs';

test('every tutor tool parameter schema is accepted by dsh-tools so the plugin can activate', () => {
  const store = { mutate: async () => ({}), read: async () => ({}) };
  const tools = toolSpecs(store);
  assert.ok(tools.length > 0);
  for (const t of tools) {
    assert.doesNotThrow(
      () => parameterSchemaSpecToJsonSchema(t.parameters),
      `tool ${t.name} failed dsh-tools schema conversion`,
    );
  }
});
