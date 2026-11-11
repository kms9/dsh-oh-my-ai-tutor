import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { newState, validateState, transition } from './core.mjs';

const queues = new Map();
export function defaultStatePath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'oh-my-ai-tutor', 'state.json');
}
export class JsonTutorStore {
  constructor(path = defaultStatePath()) { this.path = path; }
  async read() {
    try {
      const bytes = await readFile(this.path, 'utf8');
      if (bytes.length > 16_000_000) throw new Error('Tutor data exceeds 16MB; migrate to DSH SQLite storage domain');
      return validateState(JSON.parse(bytes));
    } catch (e) {
      if (e.code === 'ENOENT') return newState();
      throw e;
    }
  }
  async mutate(action, payload, expectedRevision) {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const task = previous.then(async () => {
      const state = await this.read();
      if (expectedRevision !== undefined && expectedRevision !== state.revision)
        throw Object.assign(new Error(`Tutor revision conflict: current=${state.revision}`), { code: 'conflict' });
      const next = transition(state, action, payload);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next.state, null, 2), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, this.path);
      return { revision: next.state.revision, result: next.result };
    });
    const barrier = task.then(() => undefined, () => undefined);
    queues.set(this.path, barrier);
    barrier.then(() => { if (queues.get(this.path) === barrier) queues.delete(this.path); });
    return task;
  }
}
