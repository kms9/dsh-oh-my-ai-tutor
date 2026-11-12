// Route B: learning state lives under $DSH_HOME/oh-my-ai-tutor/, isolated per workspace.
// The workspace directory itself holds teaching materials only — never the main tutor.db.
//
// Anchor: the session's immutable workspace path (SessionHeader.cwd). Never process.cwd()
// and never a later `cd` / worktree working directory. No cwd → the existing global
// $DSH_HOME/oh-my-ai-tutor/tutor.db. A configured dbPath / statePath still wins.
//
// Rename / move: DSH does not rewrite workspace paths. A registry (path + git / package
// fingerprint, in the style of dsh-workspace-recollection) reattaches a bucket when the
// old path is gone. If the old path still exists, a copy gets its own empty bucket so the
// two trees are not mixed.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { SqliteTutorStore, defaultDbPath, copyDb } from './sqlite-store.mjs';
import { JsonTutorStore, defaultStatePath } from './store.mjs';

export const REGISTRY_VERSION = 1;
const KEY_PREFIX = 'ws-';

export function tutorHome(env = process.env) {
  return join(env.DSH_HOME || join(homedir(), '.dsh'), 'oh-my-ai-tutor');
}

/**
 * Normalise a workspace path. Absolute paths only — a relative value is rejected (we must
 * not resolve it against process.cwd()). Existing paths are realpath'd; missing ones keep
 * their normalised absolute form so a moved folder can still be looked up later.
 */
export function normalizeWorkspacePath(cwd) {
  if (typeof cwd !== 'string') return null;
  const raw = cwd.trim();
  if (!raw || !isAbsolute(raw)) return null;
  const norm = normalize(raw);
  try { if (existsSync(norm)) return realpathSync(norm); } catch { /* unreadable */ }
  return norm;
}

export function workspaceKey(normalizedPath) {
  return KEY_PREFIX + createHash('sha256').update(normalizedPath).digest('hex').slice(0, 16);
}

export function normalizeRemote(url) {
  let u = String(url ?? '').trim();
  const scp = /^git@([^:]+):(.+)$/.exec(u);
  if (scp) u = `ssh://${scp[1]}/${scp[2]}`;
  return u.replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
}

function gitDirOf(repoRoot) {
  const marker = join(repoRoot, '.git');
  if (!existsSync(marker)) return null;
  try {
    if (lstatSync(marker).isFile()) {
      const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(marker, 'utf8'));
      if (!m) return null;
      const p = m[1];
      return isAbsolute(p) ? p : join(repoRoot, p);
    }
  } catch { return null; }
  return marker;
}

function remotesOf(repoRoot) {
  const gitDir = gitDirOf(repoRoot);
  if (!gitDir) return [];
  const cfg = join(gitDir, 'config');
  if (!existsSync(cfg)) return [];
  const urls = [];
  try {
    for (const m of readFileSync(cfg, 'utf8').matchAll(/^\s*url\s*=\s*(.+)$/gm)) urls.push(normalizeRemote(m[1]));
  } catch { return []; }
  return [...new Set(urls.filter(Boolean))].sort();
}

/** Walk up from dir looking for .git (file or directory). */
export function gitRoot(dir) {
  let cur = dir;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function manifestId(dir) {
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    try { const n = JSON.parse(readFileSync(pkg, 'utf8')).name; if (n) return { file: 'package.json', id: String(n) }; } catch { /* ignore */ }
  }
  const py = join(dir, 'pyproject.toml');
  if (existsSync(py)) {
    try {
      const t = readFileSync(py, 'utf8');
      const m = /^name\s*=\s*["']([^"']+)["']/m.exec(t);
      if (m) return { file: 'pyproject.toml', id: m[1] };
    } catch { /* ignore */ }
  }
  const go = join(dir, 'go.mod');
  if (existsSync(go)) {
    try { const m = /^module\s+(\S+)/m.exec(readFileSync(go, 'utf8')); if (m) return { file: 'go.mod', id: m[1] }; } catch { /* ignore */ }
  }
  const cargo = join(dir, 'Cargo.toml');
  if (existsSync(cargo)) {
    try { const m = /^name\s*=\s*["']([^"']+)["']/m.exec(readFileSync(cargo, 'utf8')); if (m) return { file: 'Cargo.toml', id: m[1] }; } catch { /* ignore */ }
  }
  return null;
}

/** Path-independent fingerprint of a workspace directory (git remotes / package name / top-level names). */
export function fingerprint(dir) {
  let entries = [];
  try { entries = readdirSync(dir).filter((n) => n !== '.' && n !== '..').sort().slice(0, 40); } catch { entries = []; }
  const root = dir && existsSync(dir) ? gitRoot(dir) : null;
  const remotes = root ? remotesOf(root) : [];
  return {
    git: remotes.length ? { root, remotes } : null,
    manifest: dir && existsSync(dir) ? manifestId(dir) : null,
    entries,
  };
}

/** Strong identity: a shared git remote, or the same package/module name. Weak (top-level names) never matches alone. */
export function strongFingerprintMatch(a, b) {
  if (!a || !b) return false;
  const ar = a.git?.remotes ?? [], br = b.git?.remotes ?? [];
  if (ar.length && br.length && ar.some((r) => br.includes(r))) return true;
  if (a.manifest?.id && b.manifest?.id && a.manifest.file === b.manifest.file && a.manifest.id === b.manifest.id) return true;
  return false;
}

function emptyRegistry() {
  return { version: REGISTRY_VERSION, global: { claimedBy: null }, workspaces: [] };
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* already tighter or unsupported */ }
}

function atomicWrite(path, text, mode = 0o600) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try { writeFileSync(fd, text); } finally { closeSync(fd); }
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  chmodSync(path, mode);
}

export function readRegistry(home) {
  const path = join(home, 'registry.json');
  if (!existsSync(path)) return emptyRegistry();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || raw.version !== REGISTRY_VERSION || !Array.isArray(raw.workspaces)) return emptyRegistry();
    return { version: REGISTRY_VERSION, global: raw.global ?? { claimedBy: null }, workspaces: raw.workspaces };
  } catch { return emptyRegistry(); }
}

export function writeRegistry(home, registry) {
  atomicWrite(join(home, 'registry.json'), JSON.stringify(registry, null, 2) + '\n', 0o600);
}

/**
 * Find or create the bucket for this workspace path. May adopt an existing bucket when a
 * strong fingerprint matches and the recorded path no longer exists.
 */
export function lookupOrCreate(home, workspacePath, { now = () => new Date().toISOString(), fp } = {}) {
  const path = normalizeWorkspacePath(workspacePath);
  if (!path) return { kind: 'global', reason: 'no-workspace' };
  const at = now();
  const print = fp ?? fingerprint(path);
  const reg = readRegistry(home);
  const byPath = reg.workspaces.find((w) => w.path === path);
  if (byPath) {
    byPath.fingerprint = print;
    byPath.updatedAt = at;
    writeRegistry(home, reg);
    return { kind: 'workspace', record: byPath, registry: reg };
  }
  const matches = reg.workspaces.filter((w) => strongFingerprintMatch(print, w.fingerprint));
  const missing = matches.filter((w) => !existsSync(w.path));
  if (missing.length) {
    missing.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    const rec = missing[0];
    rec.adoptedFrom = { path: rec.path, at, reason: rec.fingerprint?.git?.remotes?.length ? 'git-remote' : 'manifest' };
    rec.path = path;
    rec.fingerprint = print;
    rec.updatedAt = at;
    writeRegistry(home, reg);
    return { kind: 'workspace', record: rec, registry: reg, adopted: true };
  }
  const copyOf = matches.find((w) => existsSync(w.path));
  const rec = {
    key: workspaceKey(path),
    path,
    fingerprint: print,
    createdAt: at,
    updatedAt: at,
    adoptedFrom: null,
    fromGlobal: null,
    ...(copyOf ? { copySuspectOf: { key: copyOf.key, path: copyOf.path } } : {}),
  };
  // extremely unlikely hash collision on a different path
  if (reg.workspaces.some((w) => w.key === rec.key)) rec.key = workspaceKey(path + '\0' + at);
  reg.workspaces.push(rec);
  writeRegistry(home, reg);
  return { kind: 'workspace', record: rec, registry: reg, created: true, copySuspect: Boolean(copyOf) };
}

function sessionIdOf(exec) {
  return exec?.agent?.sessionId ?? exec?.agent?.session?.id ?? exec?.sessionId ?? null;
}

function cwdOfLiveSession(sessions, sessionId) {
  if (!sessionId || !sessions) return null;
  try {
    const live = typeof sessions.get === 'function' ? sessions.get(sessionId) : null;
    return normalizeWorkspacePath(live?.header?.cwd);
  } catch { return null; }
}

function liveSessionCwds(sessions) {
  if (!sessions) return [];
  let list = [];
  try {
    list = typeof sessions.list === 'function' ? sessions.list() : [];
  } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  const out = [];
  for (const s of list) {
    const cwd = normalizeWorkspacePath(s?.header?.cwd);
    if (!cwd) continue;
    out.push({ sessionId: s.id ?? s.sessionId, cwd, updatedAt: s.updatedAt ?? s.header?.updatedAt ?? s.header?.createdAt ?? '' });
  }
  return out;
}

function fileName(storage) { return storage === 'json' ? 'state.json' : 'tutor.db'; }

/**
 * Opens (and caches) the SQLite / JSON store that belongs to a workspace or to the global
 * fallback. One hub per plugin process; web and headless that share $DSH_HOME and the same
 * workspace path therefore share the same file.
 */
export class TutorStoreHub {
  constructor(config = {}, opts = {}) {
    this.config = config;
    this.env = opts.env ?? process.env;
    this.home = opts.home ?? tutorHome(this.env);
    this.now = opts.now ?? (() => new Date().toISOString());
    this.storage = config.storage === 'json' ? 'json' : 'sqlite';
    this.fixedPath = this.storage === 'json' ? (config.statePath || null) : (config.dbPath || null);
    this.getSessions = opts.sessions ?? (() => null);
    this.legacyJsonPath = config.statePath || null;
    this.stores = new Map(); // cache key → store
    this.last = null; // last resolve info (for the workbench / tools to surface)
  }

  sessions() {
    try { return typeof this.getSessions === 'function' ? this.getSessions() : this.getSessions; } catch { return null; }
  }

  globalPath() {
    return this.storage === 'json' ? (this.legacyJsonPath || join(this.home, 'state.json')) : join(this.home, 'tutor.db');
  }

  /**
   * Resolve the store for a tool or workbench call. `cwd` must be the immutable workspace
   * path (SessionHeader.cwd). Relative paths and process.cwd() are ignored.
   */
  async resolve({ cwd, sessionId } = {}) {
    if (this.fixedPath) return this.#open('fixed', this.fixedPath, { kind: 'configured', path: null, key: 'fixed' });
    let path = normalizeWorkspacePath(cwd) ?? cwdOfLiveSession(this.sessions(), sessionId);
    if (!path) return this.#open('global', this.globalPath(), { kind: 'global', path: null, key: 'global', reason: 'no-workspace' });
    return this.#openWorkspace(path, { sessionId });
  }

  resolveFromExec(exec) {
    return this.resolve({ sessionId: sessionIdOf(exec) });
  }

  /**
   * Workbench: prefer an explicit sessionId; otherwise a unique live workspace; otherwise the
   * most recently updated live session (flagged ambiguous); otherwise the global fallback.
   */
  async resolveForWorkbench({ sessionId, cwd } = {}) {
    if (sessionId || cwd) return this.resolve({ sessionId, cwd });
    const live = liveSessionCwds(this.sessions());
    const unique = [...new Set(live.map((x) => x.cwd))];
    if (unique.length === 1) return this.#openWorkspace(unique[0], { sessionId: live[0].sessionId });
    if (unique.length > 1) {
      live.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      const store = await this.#openWorkspace(live[0].cwd, { sessionId: live[0].sessionId });
      if (store.workspace) store.workspace = { ...store.workspace, ambiguous: true, otherWorkspaces: unique.filter((p) => p !== live[0].cwd) };
      return store;
    }
    return this.resolve({});
  }

  async #openWorkspace(workspacePath, extra = {}) {
    const found = lookupOrCreate(this.home, workspacePath, { now: this.now });
    if (found.kind !== 'workspace') return this.resolve({});
    const rec = found.record;
    const dbPath = join(this.home, rec.key, fileName(this.storage));
    const info = {
      kind: 'workspace', key: rec.key, path: rec.path, sessionId: extra.sessionId ?? null,
      adoptedFrom: rec.adoptedFrom ?? null, copySuspect: rec.copySuspectOf ?? (found.copySuspect ? true : null),
      fromGlobal: rec.fromGlobal ?? null,
    };
    const store = this.#open(rec.key, dbPath, info);
    await this.#maybeClaimGlobal(store, rec);
    return this.stores.get(rec.key) ?? store;
  }

  #open(cacheKey, path, info) {
    let store = this.stores.get(cacheKey);
    if (!store) {
      ensureDir(dirname(path));
      if (this.storage === 'json') store = new JsonTutorStore(path);
      else {
        // only the global file may import a leftover state.json; a workspace bucket starts empty
        const legacy = info.kind === 'global' || info.kind === 'configured' ? (this.legacyJsonPath || defaultStatePath()) : null;
        store = new SqliteTutorStore(path, { legacyJsonPath: legacy, now: this.now });
        try { store.open(); } catch (e) { console.error(`[dsh-oh-my-ai-tutor] cannot open ${path}: ${e.message}`); }
      }
      this.stores.set(cacheKey, store);
    }
    store.workspace = { ...info, dbPath: path };
    this.last = store.workspace;
    return store;
  }

  /**
   * First workspace that opens after the upgrade, when the existing global tutor.db still has
   * courses and has not been claimed: copy (not move) into this bucket after a 0600 backup.
   * Later workspaces stay empty. The global file remains the no-workspace fallback so progress
   * never "disappears" from the old path. Markers are written on both databases and the registry.
   */
  async #maybeClaimGlobal(store, rec) {
    if (this.storage !== 'sqlite') return;
    if (rec.fromGlobal) return;
    const globalPath = this.globalPath();
    if (!existsSync(globalPath)) return;
    const reg = readRegistry(this.home);
    if (reg.global?.claimedBy && reg.global.claimedBy.key !== rec.key) return;
    let workspaceState;
    try { workspaceState = await store.read(); } catch { return; }
    if (workspaceState.revision > 0 && Object.keys(workspaceState.courses ?? {}).length > 0) return;

    const cachedGlobal = this.stores.get('global');
    let global = cachedGlobal;
    if (!global) {
      global = new SqliteTutorStore(globalPath, { legacyJsonPath: null, backupBeforeMigrate: false, now: this.now });
      try { global.open(); } catch { return; }
    }
    let globalState;
    try { globalState = await global.read(); } catch { if (!cachedGlobal) global.close(); return; }
    const courses = Object.keys(globalState.courses ?? {}).length;
    if (globalState.revision <= 0 || courses === 0) { if (!cachedGlobal) global.close(); return; }
    const existingClaim = (() => {
      try { return JSON.parse(global.db.prepare("SELECT value FROM meta WHERE key = 'migration.workspaceClaim'").get()?.value ?? 'null'); } catch { return null; }
    })();
    if (existingClaim?.toKey && existingClaim.toKey !== rec.key) { if (!cachedGlobal) global.close(); return; }

    const backup = join(this.home, `tutor.db.bak-claim-${this.now().replace(/[:.]/g, '-')}`);
    try { copyDb(global.db, backup); } catch (e) { if (!cachedGlobal) global.close(); throw e; }
    const dest = store.path;
    store.close();
    this.stores.delete(rec.key);
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dest + suffix;
      if (existsSync(f)) rmSync(f);
    }
    copyDb(global.db, dest);

    const at = this.now();
    const claim = { toKey: rec.key, toPath: dest, workspacePath: rec.path, at, backup, courses, revision: globalState.revision };
    global.db.prepare("INSERT INTO meta (key, value) VALUES ('migration.workspaceClaim', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(claim));
    if (!cachedGlobal) global.close();

    const again = new SqliteTutorStore(dest, { legacyJsonPath: null, backupBeforeMigrate: false, now: this.now });
    again.open();
    again.db.prepare("INSERT INTO meta (key, value) VALUES ('migration.fromGlobal', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ from: globalPath, at, backup, key: rec.key, courses, revision: globalState.revision }));
    this.stores.set(rec.key, again);
    again.workspace = { ...(store.workspace ?? {}), key: rec.key, path: rec.path, kind: 'workspace', dbPath: dest, fromGlobal: { at, backup } };

    rec.fromGlobal = { at, backup, from: globalPath };
    rec.updatedAt = at;
    const next = readRegistry(this.home);
    const row = next.workspaces.find((w) => w.key === rec.key);
    if (row) { row.fromGlobal = rec.fromGlobal; row.updatedAt = at; }
    next.global = { claimedBy: { key: rec.key, workspacePath: rec.path, at, backup } };
    writeRegistry(this.home, next);
    this.last = again.workspace;
  }

  close() {
    for (const s of this.stores.values()) try { s.close?.(); } catch { /* already closed */ }
    this.stores.clear();
  }
}

export { defaultDbPath, defaultStatePath };
