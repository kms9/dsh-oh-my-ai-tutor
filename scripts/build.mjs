import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'lib'), { recursive: true });
const shared = { absWorkingDir: root, bundle: true, logLevel: 'info', legalComments: 'eof', loader: { '.css': 'text' }, jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"' }, target: ['chrome120', 'safari17'], minify: process.argv.includes('--minify') };
// DSH client bundle: CJS wrapped for window.__ModuleLoader__; React comes from the host's shared module table.
await build({ ...shared, entryPoints: ['src/client/client.jsx'], outfile: 'lib/client.js', format: 'cjs', platform: 'browser',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-oh-my-ai-tutor",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: ';return module.exports;}});' } });
// Standalone harness bundle (bundles its own React) for e2e and design comparison.
await build({ ...shared, entryPoints: ['src/client/standalone.jsx'], outfile: 'lib/standalone.js', format: 'iife', platform: 'browser' });
console.log('built lib/client.js (DSH web client) and lib/standalone.js (harness)');
