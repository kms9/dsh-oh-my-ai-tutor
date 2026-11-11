import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'lib'), { recursive: true });
const shared = { absWorkingDir: root, bundle: true, logLevel: 'info', legalComments: 'eof', loader: { '.css': 'text' }, jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"' }, target: ['chrome120', 'safari17'], minify: !process.argv.includes('--no-minify'), metafile: true };
// DSH client bundle: CJS wrapped for window.__ModuleLoader__; React comes from the host's shared module table.
const client = await build({ ...shared, entryPoints: ['src/client/client.jsx'], outfile: 'lib/client.js', format: 'cjs', platform: 'browser',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-oh-my-ai-tutor",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: ';return module.exports;}});' } });
// Standalone harness bundle (bundles its own React) for e2e and design comparison.
await build({ ...shared, entryPoints: ['src/client/standalone.jsx'], outfile: 'lib/standalone.js', format: 'iife', platform: 'browser' });
// Size report: the DSH client bundle must stay small (mind-elixir is the only runtime dependency we bundle).
const { gzipSync } = await import('node:zlib');
const { readFile } = await import('node:fs/promises');
const bytes = await readFile(join(root, 'lib/client.js'));
const byPkg = {};
for (const [file, info] of Object.entries(client.metafile.outputs['lib/client.js'].inputs)) {
  const pkg = file.includes('node_modules/') ? file.split('node_modules/')[1].split('/').slice(0, file.split('node_modules/')[1].startsWith('@') ? 2 : 1).join('/') : 'src';
  byPkg[pkg] = (byPkg[pkg] ?? 0) + info.bytesInOutput;
}
console.log(`lib/client.js ${(bytes.length / 1024).toFixed(1)} KB (gzip ${(gzipSync(bytes).length / 1024).toFixed(1)} KB):`,
  Object.entries(byPkg).map(([k, v]) => `${k} ${(v / 1024).toFixed(1)} KB`).join(', '));
console.log('built lib/client.js (DSH web client) and lib/standalone.js (harness)');
