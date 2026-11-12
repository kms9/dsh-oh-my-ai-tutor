// Render test for the knowledge-graph node renderers (no browser): bundle graph-flow.jsx with esbuild, then render each
// registered node type with react-dom/server. Guards the bug where `extension` nodes fell back to React Flow's empty box.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider } from '@xyflow/react';
import { buildGraph, NODE_KINDS } from '../src/client/graph-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'node_modules', '.cache', 'omt-test', 'graph-flow.mjs');
await mkdir(join(out, '..'), { recursive: true });
const r = await build({ absWorkingDir: root, entryPoints: ['src/client/graph-flow.jsx'], bundle: true, write: false, format: 'esm', platform: 'node',
  packages: 'external', jsx: 'transform', loader: { '.css': 'text' }, logLevel: 'silent' });
await writeFile(out, r.outputFiles[0].text);
const { nodeTypes } = await import(pathToFileURL(out).href);

const render = (n) => renderToStaticMarkup(React.createElement(ReactFlowProvider, null,
  React.createElement(nodeTypes[n.kind], { id: n.id, data: { n, color: '#6273dd' } })));

test('every node kind the graph emits is a registered React Flow node type', () => {
  assert.deepEqual(Object.keys(nodeTypes).sort(), [...NODE_KINDS].sort());
  const g = buildGraph({ nodes: [{ id: 'g1', label: '扩展', conceptId: null, topicId: 't1' }, { id: 'g2', label: '知识点', conceptId: 'c1', mastery: 'developing' }], edges: [] },
    [{ id: 't1', title: '主题', subtopics: [{ id: 's1', conceptIds: ['c1'] }] }]);
  for (const n of g.nodes) assert.ok(nodeTypes[n.kind], `kind ${n.kind} registered`);
});

test('extension node renders a labelled, dashed-style node without a mastery class', () => {
  const html = render({ id: 'g1', kind: 'extension', label: '易错点：符号', mastery: null, topicId: 't1' });
  assert.match(html, /class="kg-node kg-dot kg-extension\s/);
  assert.match(html, /易错点：符号/);
  assert.doesNotMatch(html, /unverified|developing|demonstrated/);
  assert.match(html, /扩展节点/);
  // a knowledge point keeps its mastery ring class; a fold shows its count
  assert.match(render({ id: 'g2', kind: 'concept', label: '定义', mastery: 'developing' }), /kg-concept developing/);
  assert.match(render({ id: 'fold:t1', kind: 'fold', title: '主题', label: '主题 · 3个', count: 3, members: [] }), /kg-fold[\s\S]*\+3/);
});
