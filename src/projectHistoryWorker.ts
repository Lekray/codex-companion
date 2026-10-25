import { readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix, resolve, win32 } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Worker } from 'node:worker_threads';

export const HISTORY_WORKER_TIMEOUT_MS = 8_000;
export const PERMITTED_THREAD_COLUMNS = [
  'id',
  'cwd',
  'name',
  'title',
  'updated_at',
  'updated_at_ms',
  'recency_at_ms',
  'archived',
] as const;

export type HistoryFailureCode = 'missing' | 'unsupported' | 'busy' | 'timeout' | 'unavailable';

export interface HistoryEntry {
  id: string;
  cwd: string;
  name: string;
  title: string;
  updatedAt: number | null;
  root: string;
  folder: string;
}

export type HistoryResult =
  | { ok: true; entries: HistoryEntry[] }
  | { ok: false; code: HistoryFailureCode };

export class HistoryReadError extends Error {
  constructor(readonly code: HistoryFailureCode) {
    super(code);
    this.name = 'HistoryReadError';
  }
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID.test(value);
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(home, '.codex');
}

/** Canonical comparison key. Windows drive/UNC paths are case-insensitive. */
export function canonicalPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = ordinaryWindowsPath(value.trim());
  if (!trimmed || trimmed.includes('\0')) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    if (!win32.isAbsolute(trimmed)) return undefined;
    return windowsKey(trimmed);
  }
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(trimmed)) {
    if (!win32.isAbsolute(trimmed)) return undefined;
    return windowsKey(trimmed);
  }
  if (trimmed.startsWith('/')) {
    if (!posix.isAbsolute(trimmed)) return undefined;
    const normalized = posix.normalize(trimmed);
    return normalized === '/' ? normalized : normalized.replace(/\/+$/, '');
  }
  return undefined;
}

function ordinaryWindowsPath(value: string): string {
  const windows = value.replace(/\//g, '\\');
  if (windows.toLowerCase().startsWith('\\\\?\\unc\\')) return '\\\\' + windows.slice(8);
  if (/^\\\\\?\\[A-Za-z]:\\/.test(windows)) return windows.slice(4);
  return value;
}

function windowsKey(value: string): string {
  const normalized = win32.normalize(value).toLowerCase();
  return /^[a-z]:\\$/.test(normalized) ? normalized : normalized.replace(/\\+$/, '');
}

function pathWithin(root: string, target: string): boolean {
  if (root === target) return true;
  if (root.endsWith('\\') || root.endsWith('/')) return target.startsWith(root);
  return target.startsWith(root + (root.includes('\\') ? '\\' : '/'));
}

export function relativeFolder(cwd: string, root: string): string {
  const target = canonicalPath(cwd);
  const base = canonicalPath(root);
  if (!target || !base) return cwd;
  const windows = target.includes('\\');
  const normalizedCwd = normalizedDisplayPath(cwd, windows);
  const normalizedRoot = normalizedDisplayPath(root, windows);
  if (target === base) {
    const name = windows ? win32.basename(normalizedRoot) : posix.basename(normalizedRoot);
    return name || root;
  }
  const separator = windows ? '\\' : '/';
  const cwdKey = windows ? normalizedCwd.toLowerCase() : normalizedCwd;
  const rootKey = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const prefix = rootKey.endsWith(separator) ? rootKey : rootKey + separator;
  if (cwdKey.startsWith(prefix)) {
    return normalizedCwd.slice(prefix.length);
  }
  return cwd;
}

function normalizedDisplayPath(value: string, windows: boolean): string {
  if (windows) {
    const normalized = win32.normalize(ordinaryWindowsPath(value).replace(/\//g, '\\'));
    return normalized.replace(/\\+$/, '');
  }
  const normalized = posix.normalize(value);
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function matchWorkspace(cwd: unknown, roots: readonly string[]): { root: string; folder: string } | undefined {
  const target = canonicalPath(cwd);
  if (!target || typeof cwd !== 'string') return undefined;
  for (const root of roots) {
    const base = canonicalPath(root);
    if (!base || !pathWithin(base, target)) continue;
    return { root, folder: relativeFolder(cwd, root) };
  }
  return undefined;
}

export interface ThreadsQuery {
  sql: string;
  selected: readonly string[];
}

/** Builds a read-only metadata query. Private text columns are never part of the list. */
export function buildThreadsQuery(columns: readonly string[]): ThreadsQuery {
  const present = new Set(columns);
  if (!present.has('id') || !present.has('cwd')) throw new HistoryReadError('unsupported');
  const selected = PERMITTED_THREAD_COLUMNS.filter(column => present.has(column));
  const conditions = ['"id" IS NOT NULL', '"cwd" IS NOT NULL'];
  if (present.has('archived')) conditions.push('COALESCE("archived", 0) <> 1');
  // has_user_event is not maintained for all current paginated histories.
  // Real conversations in the verified index can legitimately have value 0.
  const timestamps: string[] = [];
  if (present.has('recency_at_ms')) timestamps.push('"recency_at_ms"');
  if (present.has('updated_at_ms')) timestamps.push('"updated_at_ms"');
  if (present.has('updated_at')) timestamps.push('("updated_at" * 1000)');
  const order = timestamps.length ? `COALESCE(${timestamps.join(', ')}, 0) DESC, ` : '';
  return {
    sql: `SELECT ${selected.map(column => `"${column}"`).join(', ')} FROM "threads" WHERE ${conditions.join(' AND ')} ORDER BY ${order}"id" ASC`,
    selected,
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    return Number.isFinite(converted) ? converted : undefined;
  }
  return undefined;
}

function timestamp(value: unknown): number | undefined {
  const number = numeric(value);
  if (number === undefined) return undefined;
  return Number.isFinite(new Date(number).getTime()) ? number : undefined;
}

export function shapeThreadRows(rows: readonly Record<string, unknown>[], roots: readonly string[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    if (!isThreadId(row.id)) continue;
    const cwd = text(row.cwd);
    const workspace = matchWorkspace(cwd, roots);
    if (!workspace) continue;
    const seconds = numeric(row.updated_at);
    const updatedAt = timestamp(row.recency_at_ms)
      ?? timestamp(row.updated_at_ms)
      ?? timestamp(seconds === undefined ? undefined : seconds * 1000)
      ?? null;
    entries.push({
      id: row.id,
      cwd,
      name: text(row.name),
      title: text(row.title),
      updatedAt,
      root: workspace.root,
      folder: workspace.folder,
    });
  }
  entries.sort((left, right) => {
    if (left.updatedAt === null) return right.updatedAt === null ? left.id.localeCompare(right.id) : 1;
    if (right.updatedAt === null) return -1;
    return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
  });
  return entries;
}

export function locateHistoryDatabase(home: string): string | undefined {
  const current = join(home, 'state_5.sqlite');
  if (isFile(current)) return current;
  let entries: Dirent[];
  try {
    entries = readdirSync(home, { withFileTypes: true }) as Dirent[];
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new HistoryReadError('unavailable');
  }
  let best: { version: number; path: string } | undefined;
  for (const entry of entries) {
    const match = /^state_(\d+)\.sqlite$/i.exec(entry.name);
    if (!match || !entry.isFile()) continue;
    const version = Number(match[1]);
    const path = join(home, entry.name);
    if (!Number.isInteger(version) || !isFile(path) || (best && version <= best.version)) continue;
    best = { version, path };
  }
  return best?.path;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new HistoryReadError('unavailable');
  }
}

function classify(error: unknown): HistoryReadError {
  if (error instanceof HistoryReadError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | undefined)?.code;
  const errcode = (error as { errcode?: unknown } | undefined)?.errcode;
  if ((typeof errcode === 'number' && (errcode === 5 || errcode === 6))
    || /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/i.test(message)) {
    return new HistoryReadError('busy');
  }
  return new HistoryReadError('unavailable');
}

/**
 * Opens the current index read-only, selects permitted metadata only, and
 * returns rows that belong to one of the local workspace roots.
 */
export function readProjectHistorySync(home: string, roots: readonly string[]): HistoryEntry[] {
  const cleanedRoots = [...new Set(roots.filter(root => typeof root === 'string' && canonicalPath(root) !== undefined))];
  const databasePath = locateHistoryDatabase(home);
  if (!databasePath) throw new HistoryReadError('missing');
  let database: DatabaseSync;
  try {
    // Lazy load so the extension host only touches node:sqlite inside the worker.
    const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');
    database = new Database(databasePath, { readOnly: true });
  } catch (error) {
    throw classify(error);
  }
  try {
    database.exec('PRAGMA busy_timeout = 2000');
    database.exec('PRAGMA query_only = ON');
    const columns = (database.prepare('PRAGMA table_info("threads")').all() as Record<string, unknown>[])
      .map(column => typeof column.name === 'string' ? column.name : '')
      .filter(Boolean);
    if (!columns.length) throw new HistoryReadError('unsupported');
    const query = buildThreadsQuery(columns);
    const rows = database.prepare(query.sql).all() as Record<string, unknown>[];
    return shapeThreadRows(rows, cleanedRoots);
  } catch (error) {
    throw classify(error);
  } finally {
    try { database.close(); } catch { /* The read-only connection is best-effort closed. */ }
  }
}

export interface LoadHistoryOptions {
  home: string;
  roots: readonly string[];
  timeoutMs?: number;
  workerFile?: string;
}

/**
 * Reads the index in an owned worker thread. Only the selected worker is
 * terminated on timeout; other Codex processes are never touched.
 */
export function loadProjectHistory(options: LoadHistoryOptions): Promise<HistoryResult> {
  const workerFile = options.workerFile ?? join(__dirname, 'projectHistoryWorker.js');
  return new Promise(resolvePromise => {
    let worker: Worker;
    try {
      worker = new Worker(workerFile, { workerData: { home: options.home, roots: [...options.roots] } });
    } catch {
      resolvePromise({ ok: false, code: 'unavailable' });
      return;
    }
    let settled = false;
    const finish = (result: HistoryResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolvePromise(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), options.timeoutMs ?? HISTORY_WORKER_TIMEOUT_MS);
    worker.once('message', (message: unknown) => {
      if (!message || typeof message !== 'object') {
        finish({ ok: false, code: 'unavailable' });
        return;
      }
      const value = message as { ok?: unknown; entries?: unknown; code?: unknown };
      if (value.ok === true && Array.isArray(value.entries)) {
        const entries = value.entries.filter(isHistoryEntry);
        finish(entries.length === value.entries.length
          ? { ok: true, entries }
          : { ok: false, code: 'unavailable' });
        return;
      }
      finish({ ok: false, code: failureCode(value.code) });
    });
    worker.once('error', () => finish({ ok: false, code: 'unavailable' }));
    worker.once('exit', () => {
      if (!settled) finish({ ok: false, code: 'unavailable' });
    });
  });
}

function failureCode(value: unknown): HistoryFailureCode {
  return value === 'missing' || value === 'unsupported' || value === 'busy' || value === 'timeout' || value === 'unavailable'
    ? value
    : 'unavailable';
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<HistoryEntry>;
  return isThreadId(entry.id)
    && typeof entry.cwd === 'string'
    && typeof entry.name === 'string'
    && typeof entry.title === 'string'
    && validTimestamp(entry.updatedAt)
    && typeof entry.root === 'string'
    && typeof entry.folder === 'string';
}

function validTimestamp(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime()));
}

if (!isMainThread && parentPort) {
  const data = workerData as { home?: unknown; roots?: unknown } | undefined;
  try {
    if (!data || typeof data.home !== 'string' || !Array.isArray(data.roots)) throw new HistoryReadError('unavailable');
    const roots = data.roots.filter((root): root is string => typeof root === 'string');
    parentPort.postMessage({ ok: true, entries: readProjectHistorySync(data.home, roots) });
  } catch (error) {
    parentPort.postMessage({ ok: false, code: error instanceof HistoryReadError ? error.code : 'unavailable' });
  }
}
