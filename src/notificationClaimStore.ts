import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CLAIM_SUFFIX = '.claim';
const CLAIMS_DB_FILE = 'claims-v2.sqlite';
const TRANSITION_RECEIPT_FILE = 'claims-v2-transition.json';
const RECEIPT_VERSION = 1;
const DEFAULT_RETRY_DELAY_MS = 20;
const DEFAULT_RETRY_MAX_MS = 2_000;

export interface ClaimStoreOptions {
  /** Current VSCode root PID. Defaults to process.env.VSCODE_PID. */
  currentPid?: number;
  /** Liveness probe. Defaults to process.kill(pid, 0); ESRCH alone means dead. */
  isAlive?: (pid: number) => boolean;
  /** Test seam for the async retry pause. */
  sleep?: (milliseconds: number) => Promise<void>;
  retryDelayMs?: number;
  retryMaxMs?: number;
}

type ClaimMode = 'legacy' | 'compact';
type Receipt =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; legacyVscodePid: number };

export type KillProbe = (pid: number, signal: 0) => unknown;

/**
 * Only ESRCH proves that a process is gone. EPERM and every other probe
 * failure are ambiguous, so they must keep the original legacy format.
 */
export function isProcessAlive(
  pid: number,
  kill: KillProbe = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Claims an event id exactly once. Legacy runtimes keep the original
 * `<digest>.claim` wx files; after the original VSCode root is proven dead,
 * new runtimes move to one bounded SQLite database while still checking the
 * exact legacy marker first.
 */
export async function claimStoredNotificationEvent(
  storageDir: string,
  eventId: string,
  options: ClaimStoreOptions = {},
): Promise<boolean> {
  const digest = createHash('sha256').update(eventId, 'utf8').digest('hex');
  await mkdir(storageDir, { recursive: true });
  const mode = await resolveClaimMode(storageDir, options);
  if (mode === 'legacy') {
    const won = await claimLegacy(storageDir, digest);
    if (!won) return false;
    // A sibling may start compact mode while this async legacy write is in
    // flight. The DB file is published before its final legacy check. Join
    // the same atomic claim when that happened, ignoring only our own marker.
    if (await pathExists(join(storageDir, CLAIMS_DB_FILE))) {
      return claimCompact(storageDir, digest, options, true);
    }
    return true;
  }
  return claimCompact(storageDir, digest, options);
}

async function resolveClaimMode(
  storageDir: string,
  options: ClaimStoreOptions,
): Promise<ClaimMode> {
  const receipt = await readTransitionReceipt(storageDir);
  if (receipt.kind === 'valid') {
    // Once the compact database exists, keep compact mode even if the
    // recorded PID was later reused. Legacy mode cannot see those claims.
    if (await pathExists(join(storageDir, CLAIMS_DB_FILE))) return 'compact';
    return isPidAlive(receipt.legacyVscodePid, options) ? 'legacy' : 'compact';
  }

  if (receipt.kind === 'invalid') {
    // A torn receipt can be observed while another window writes it. Without
    // a compact database legacy is safe; with one, the state is unprovable.
    if (await pathExists(join(storageDir, CLAIMS_DB_FILE))) {
      throw new Error(
        'Notification claim storage is inconsistent: compact database exists without a readable transition receipt.',
      );
    }
    return 'legacy';
  }

  if (await pathExists(join(storageDir, CLAIMS_DB_FILE))) {
    throw new Error(
      'Notification claim storage is inconsistent: compact database exists without a transition receipt.',
    );
  }

  const currentPid = resolveCurrentPid(options);
  if (currentPid === undefined) return 'legacy';

  if (await createTransitionReceipt(storageDir, currentPid)) return 'legacy';

  // Another window won the exclusive create. Re-read instead of guessing.
  const raced = await readTransitionReceipt(storageDir);
  if (raced.kind !== 'valid') return 'legacy';
  if (await pathExists(join(storageDir, CLAIMS_DB_FILE))) return 'compact';
  return isPidAlive(raced.legacyVscodePid, options) ? 'legacy' : 'compact';
}

function resolveCurrentPid(options: ClaimStoreOptions): number | undefined {
  if (options.currentPid !== undefined) {
    return isPositiveInteger(options.currentPid) ? options.currentPid : undefined;
  }
  const value = process.env.VSCODE_PID;
  if (value === undefined || value.trim() === '') return undefined;
  const pid = Number(value);
  return isPositiveInteger(pid) ? pid : undefined;
}

function isPidAlive(pid: number, options: ClaimStoreOptions): boolean {
  return (options.isAlive ?? isProcessAlive)(pid);
}

async function readTransitionReceipt(storageDir: string): Promise<Receipt> {
  let text: string;
  try {
    text = await readFile(join(storageDir, TRANSITION_RECEIPT_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid' };
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== RECEIPT_VERSION ||
    !isPositiveInteger(parsed.legacyVscodePid)
  ) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', legacyVscodePid: parsed.legacyVscodePid };
}

async function createTransitionReceipt(
  storageDir: string,
  legacyVscodePid: number,
): Promise<boolean> {
  const payload = `${JSON.stringify({
    version: RECEIPT_VERSION,
    legacyVscodePid,
  })}\n`;
  try {
    await writeFile(
      join(storageDir, TRANSITION_RECEIPT_FILE),
      payload,
      { encoding: 'utf8', flag: 'wx' },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function claimLegacy(storageDir: string, digest: string): Promise<boolean> {
  try {
    await writeFile(
      join(storageDir, `${digest}${CLAIM_SUFFIX}`),
      `${new Date().toISOString()}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

async function claimCompact(
  storageDir: string,
  digest: string,
  options: ClaimStoreOptions,
  ownsLegacyMarker = false,
): Promise<boolean> {
  // Old files are permanent and read-only: check only this exact digest,
  // never enumerate or read the directory contents.
  if (!ownsLegacyMarker && await pathExists(join(storageDir, `${digest}${CLAIM_SUFFIX}`))) {
    return false;
  }

  return withClaimDatabase(join(storageDir, CLAIMS_DB_FILE), options, db => {
    // Opening publishes the cross-format barrier. Recheck immediately before
    // the synchronous transaction so an in-flight new-runtime legacy writer
    // either wins here or joins SQLite after observing the barrier.
    if (!ownsLegacyMarker) {
      try {
        statSync(join(storageDir, `${digest}${CLAIM_SUFFIX}`));
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS notification_claims (' +
          'digest TEXT PRIMARY KEY NOT NULL, ' +
          'claimed_at TEXT NOT NULL' +
          ') WITHOUT ROWID',
      );
      const result = db.prepare(
        'INSERT OR IGNORE INTO notification_claims (digest, claimed_at) VALUES (?, ?)',
      ).run(digest, new Date().toISOString());
      db.exec('COMMIT');
      return Number(result.changes) === 1;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The transaction may already have been rolled back by SQLite.
      }
      throw error;
    }
  });
}

async function withClaimDatabase<T>(
  dbPath: string,
  options: ClaimStoreOptions,
  work: (database: DatabaseSync) => T,
): Promise<T> {
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const retryMaxMs = Math.max(0, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS);
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + retryMaxMs;

  for (;;) {
    let database: DatabaseSync | undefined;
    let value: T | undefined;
    let failure: unknown;
    let succeeded = false;
    try {
      // busy_timeout 0: never block the extension host waiting for SQLite.
      database = new DatabaseSync(dbPath, { timeout: 0 });
      value = work(database);
      succeeded = true;
    } catch (error) {
      failure = error;
    } finally {
      if (database !== undefined) {
        try {
          database.close();
        } catch {
          // A close failure must not hide the claim result.
        }
      }
    }

    if (succeeded) return value as T;
    if (!isSqliteLockError(failure) || Date.now() >= deadline) throw failure;
    // The handle is closed before yielding, so no SQLite lock survives the delay.
    await sleep(Math.min(retryDelayMs, deadline - Date.now()));
  }
}

function isSqliteLockError(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== 'number') return false;
  const primary = errcode & 0xff;
  return primary === 5 || primary === 6; // SQLITE_BUSY, SQLITE_LOCKED
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
