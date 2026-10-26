import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  claimStoredNotificationEvent,
  isProcessAlive,
  type ClaimStoreOptions,
} from '../../src/notificationClaimStore';

const RECEIPT = 'claims-v2-transition.json';
const DB = 'claims-v2.sqlite';
const compiledClaimStore = join(__dirname, '..', '..', 'src', 'notificationClaimStore.js');

const CHILD_FIXTURE = [
  "'use strict';",
  "const { claimStoredNotificationEvent } = require(process.argv[2]);",
  "claimStoredNotificationEvent(process.argv[3], process.argv[4], {",
  '  currentPid: 4242,',
  '  isAlive: () => false,',
  '}).then(',
  "  value => process.stdout.write(value ? '1' : '0'),",
  "  error => { console.error(error && error.stack ? error.stack : String(error)); process.exitCode = 1; },",
  ');',
  '',
].join('\n');

function digestOf(eventId: string): string {
  return createHash('sha256').update(eventId, 'utf8').digest('hex');
}

async function withTempDir(
  label: string,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), `codex-companion-${label}-`));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function writeReceipt(dir: string, legacyVscodePid: number): Promise<void> {
  await writeFile(
    join(dir, RECEIPT),
    JSON.stringify({ version: 1, legacyVscodePid }),
    'utf8',
  );
}

async function writeChildFixture(dir: string): Promise<string> {
  const fixture = join(dir, 'claim-child.cjs');
  await writeFile(fixture, CHILD_FIXTURE, 'utf8');
  return fixture;
}

function runChild(
  fixture: string,
  storageDir: string,
  eventId: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fixture, compiledClaimStore, storageDir, eventId],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`claim child exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
}

async function runChildren(
  fixture: string,
  storageDir: string,
  eventIds: string[],
): Promise<string[]> {
  const settled = await Promise.allSettled(
    eventIds.map(eventId => runChild(fixture, storageDir, eventId)),
  );
  const failed = settled.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return settled.map(result => result.status === 'fulfilled' ? result.value : '');
}

test('a live original root keeps the legacy per-event wx format', async () => {
  await withTempDir('legacy-live', async dir => {
    await writeReceipt(dir, 4321);
    const options: ClaimStoreOptions = {
      currentPid: 9999,
      isAlive: pid => pid === 4321,
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        claimStoredNotificationEvent(dir, 'legacy-event', options)),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await claimStoredNotificationEvent(dir, 'legacy-event', options), false);
    assert.equal(await claimStoredNotificationEvent(dir, 'other-event', options), true);

    const names = await readdir(dir);
    assert.deepEqual(
      names.sort(),
      [RECEIPT, `${digestOf('legacy-event')}.claim`, `${digestOf('other-event')}.claim`].sort(),
    );
    assert.match(
      await readFile(join(dir, `${digestOf('legacy-event')}.claim`), 'utf8'),
      /^\d{4}-\d{2}-\d{2}T/,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, RECEIPT), 'utf8')),
      { version: 1, legacyVscodePid: 4321 },
    );
  });
});

test('a missing or invalid current PID stays legacy and creates no receipt', async () => {
  await withTempDir('invalid-pid', async dir => {
    const options: ClaimStoreOptions = { currentPid: 0 };
    assert.equal(await claimStoredNotificationEvent(dir, 'event', options), true);
    assert.equal(await claimStoredNotificationEvent(dir, 'event', options), false);
    assert.deepEqual(await readdir(dir), [`${digestOf('event')}.claim`]);
  });
});

test('after restart a dead original root compacts but still sees legacy markers', async () => {
  await withTempDir('restart', async dir => {
    assert.equal(
      await claimStoredNotificationEvent(dir, 'already-old', { currentPid: 0 }),
      true,
    );
    await writeReceipt(dir, 1111);
    const compact: ClaimStoreOptions = { currentPid: 2222, isAlive: () => false };

    assert.equal(await claimStoredNotificationEvent(dir, 'already-old', compact), false);
    assert.equal(await claimStoredNotificationEvent(dir, 'new-after-restart', compact), true);
    assert.equal(await claimStoredNotificationEvent(dir, 'new-after-restart', compact), false);
    assert.equal(await claimStoredNotificationEvent(dir, 'already-old', compact), false);

    const names = await readdir(dir);
    assert.ok(names.includes(`${digestOf('already-old')}.claim`));
    assert.ok(!names.includes(`${digestOf('new-after-restart')}.claim`));
    assert.ok(names.includes(DB));
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, RECEIPT), 'utf8')),
      { version: 1, legacyVscodePid: 1111 },
    );
  });
});

test('compact mode is preserved after initialization even if the PID is reused', async () => {
  await withTempDir('pid-reuse', async dir => {
    await writeReceipt(dir, 1111);
    const compact: ClaimStoreOptions = { currentPid: 2222, isAlive: () => false };
    assert.equal(await claimStoredNotificationEvent(dir, 'seed', compact), true);

    const reused: ClaimStoreOptions = { currentPid: 1111, isAlive: () => true };
    assert.equal(await claimStoredNotificationEvent(dir, 'after-reuse', reused), true);
    assert.equal(await claimStoredNotificationEvent(dir, 'after-reuse', reused), false);

    const names = await readdir(dir);
    assert.ok(names.includes(DB));
    assert.ok(!names.some(name => name.endsWith('.claim')));
  });
});

test('compact mode keeps a bounded file count and deduplicates after reopen', async () => {
  await withTempDir('compact', async dir => {
    await writeReceipt(dir, 777);
    const options: ClaimStoreOptions = { currentPid: 888, isAlive: () => false };
    const events = Array.from({ length: 24 }, (_, index) => `compact-event-${index}`);

    for (const event of events) {
      assert.equal(await claimStoredNotificationEvent(dir, event, options), true);
    }
    assert.deepEqual((await readdir(dir)).sort(), [DB, RECEIPT].sort());

    for (const event of events) {
      assert.equal(await claimStoredNotificationEvent(dir, event, options), false);
    }
    assert.equal(await claimStoredNotificationEvent(dir, 'fresh-event', options), true);

    const db = new DatabaseSync(join(dir, DB), { timeout: 0 });
    try {
      const rows = db.prepare(
        'SELECT digest, claimed_at FROM notification_claims',
      ).all();
      assert.equal(rows.length, events.length + 1);
      for (const row of rows) {
        assert.match(String(row.digest), /^[a-f0-9]{64}$/);
        assert.match(String(row.claimed_at), /^\d{4}-\d{2}-\d{2}T/);
      }
      const schema = db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notification_claims'",
      ).get();
      assert.match(String(schema?.sql ?? ''), /WITHOUT ROWID/i);
      const journal = db.prepare('PRAGMA journal_mode').get();
      assert.equal(String(journal?.journal_mode).toLowerCase(), 'delete');
    } finally {
      db.close();
    }
  });
});

test('concurrent first use creates exactly one transition receipt and stays legacy', async () => {
  await withTempDir('receipt-race', async dir => {
    const pid = 24680;
    const options: ClaimStoreOptions = {
      currentPid: pid,
      isAlive: candidate => candidate === pid,
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        claimStoredNotificationEvent(dir, 'same-event', options)),
    );
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await claimStoredNotificationEvent(dir, 'same-event', options), false);
    assert.equal(await claimStoredNotificationEvent(dir, 'other-event', options), true);

    assert.deepEqual(
      JSON.parse(await readFile(join(dir, RECEIPT), 'utf8')),
      { version: 1, legacyVscodePid: pid },
    );
    const names = await readdir(dir);
    assert.ok(!names.includes(DB));
    assert.equal(names.filter(name => name.endsWith('.claim')).length, 2);
  });
});

test('partial or malformed transition receipts stay legacy while no database exists', async () => {
  const contents = [
    '',
    '{"version":1,',
    '{"version":2,"legacyVscodePid":5}',
    '{"version":1,"legacyVscodePid":0}',
    '{"version":1,"legacyVscodePid":"5"}',
    'null',
    '[]',
  ];
  for (const [index, content] of contents.entries()) {
    await withTempDir(`bad-receipt-${index}`, async dir => {
      await writeFile(join(dir, RECEIPT), content, 'utf8');
      const options: ClaimStoreOptions = { currentPid: 1234, isAlive: () => true };
      assert.equal(await claimStoredNotificationEvent(dir, 'event', options), true);
      assert.equal(await claimStoredNotificationEvent(dir, 'event', options), false);

      const names = await readdir(dir);
      assert.ok(names.includes(`${digestOf('event')}.claim`));
      assert.ok(!names.includes(DB));
    });
  }
});

test('a database without a readable receipt fails closed instead of falling back', async () => {
  await withTempDir('bad-receipt-db', async dir => {
    await writeReceipt(dir, 1111);
    const compact: ClaimStoreOptions = { currentPid: 2222, isAlive: () => false };
    assert.equal(await claimStoredNotificationEvent(dir, 'seed', compact), true);

    await writeFile(join(dir, RECEIPT), '{"version":1,', 'utf8');
    await assert.rejects(
      claimStoredNotificationEvent(dir, 'next', compact),
      /inconsistent/i,
    );
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('.claim')));
  });

  await withTempDir('missing-receipt-db', async dir => {
    await writeReceipt(dir, 1111);
    const compact: ClaimStoreOptions = { currentPid: 2222, isAlive: () => false };
    assert.equal(await claimStoredNotificationEvent(dir, 'seed', compact), true);

    await rm(join(dir, RECEIPT));
    await assert.rejects(
      claimStoredNotificationEvent(dir, 'next', compact),
      /inconsistent/i,
    );
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('.claim')));
  });
});

test('liveness treats only ESRCH as conclusively dead', () => {
  assert.equal(isProcessAlive(process.pid), true);

  const esrch = Object.assign(new Error('gone'), { code: 'ESRCH' });
  assert.equal(isProcessAlive(1234, () => { throw esrch; }), false);

  const eperm = Object.assign(new Error('denied'), { code: 'EPERM' });
  assert.equal(isProcessAlive(1234, () => { throw eperm; }), true);

  const other = Object.assign(new Error('ambiguous'), { code: 'EINVAL' });
  assert.equal(isProcessAlive(1234, () => { throw other; }), true);
});

test('the same event is claimed exactly once across child Node processes', async () => {
  await withTempDir('children-same', async root => {
    const storage = join(root, 'storage');
    await mkdir(storage);
    await writeReceipt(storage, 1111);
    const fixture = await writeChildFixture(root);

    const results = await runChildren(
      fixture,
      storage,
      Array.from({ length: 6 }, () => 'shared-event'),
    );
    assert.deepEqual(results.sort(), ['0', '0', '0', '0', '0', '1']);
    assert.equal(
      await claimStoredNotificationEvent(storage, 'shared-event', {
        currentPid: 2222,
        isAlive: () => false,
      }),
      false,
    );

    const names = await readdir(storage);
    assert.ok(names.includes(DB));
    assert.ok(!names.some(name => name.endsWith('.claim')));
  });
});

test('concurrent child processes initialize the compact schema safely', async () => {
  await withTempDir('children-schema', async root => {
    const storage = join(root, 'storage');
    await mkdir(storage);
    await writeReceipt(storage, 1111);
    const fixture = await writeChildFixture(root);
    const events = ['schema-a', 'schema-b', 'schema-c', 'schema-d'];

    const results = await runChildren(fixture, storage, events);
    assert.deepEqual(results, ['1', '1', '1', '1']);
    for (const event of events) {
      assert.equal(
        await claimStoredNotificationEvent(storage, event, {
          currentPid: 2222,
          isAlive: () => false,
        }),
        false,
      );
    }
    assert.equal(
      await claimStoredNotificationEvent(storage, 'schema-new', {
        currentPid: 2222,
        isAlive: () => false,
      }),
      true,
    );
  });
});

test('in-flight legacy writers join the compact claim during cutover', async () => {
  await withTempDir('cutover', async root => {
    for (let i = 0; i < 32; i++) {
      const dir = join(root, String(i));
      await mkdir(dir);
      await writeReceipt(dir, 1111);
      const results = await Promise.all([
        claimStoredNotificationEvent(dir, 'cutover-event', { currentPid: 2222, isAlive: () => true }),
        claimStoredNotificationEvent(dir, 'cutover-event', { currentPid: 3333, isAlive: () => false }),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await claimStoredNotificationEvent(dir, 'cutover-event', { isAlive: () => false }), false);
    }
  });
});

test('busy locks are retried asynchronously until the writer releases', async () => {
  await withTempDir('locked-retry', async dir => {
    await writeReceipt(dir, 1111);
    const options: ClaimStoreOptions = { currentPid: 2222, isAlive: () => false };
    assert.equal(await claimStoredNotificationEvent(dir, 'seed', options), true);

    const lock = new DatabaseSync(join(dir, DB), { timeout: 0 });
    lock.exec('BEGIN EXCLUSIVE');
    let released = false;
    const releaseLock = (): void => {
      if (released) return;
      released = true;
      try {
        lock.exec('COMMIT');
      } finally {
        lock.close();
      }
    };

    let sleeps = 0;
    try {
      const claimed = await claimStoredNotificationEvent(dir, 'after-lock', {
        ...options,
        retryDelayMs: 5,
        retryMaxMs: 2_000,
        sleep: async milliseconds => {
          sleeps += 1;
          if (sleeps === 3) releaseLock();
          await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
        },
      });
      assert.equal(claimed, true);
      assert.equal(released, true);
      assert.ok(sleeps >= 3, `expected asynchronous retries, saw ${sleeps}`);
    } finally {
      releaseLock();
    }
  });
});

test('a held lock fails closed after the bounded retry window', async () => {
  await withTempDir('locked-timeout', async dir => {
    await writeReceipt(dir, 1111);
    const options: ClaimStoreOptions = { currentPid: 2222, isAlive: () => false };
    assert.equal(await claimStoredNotificationEvent(dir, 'seed', options), true);

    const lock = new DatabaseSync(join(dir, DB), { timeout: 0 });
    lock.exec('BEGIN EXCLUSIVE');
    let sleeps = 0;
    try {
      await assert.rejects(
        claimStoredNotificationEvent(dir, 'too-long', {
          ...options,
          retryDelayMs: 10,
          retryMaxMs: 150,
          sleep: async milliseconds => {
            sleeps += 1;
            await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
          },
        }),
        error => {
          const errcode = (error as { errcode?: unknown }).errcode;
          return typeof errcode === 'number' && ((errcode & 0xff) === 5 || (errcode & 0xff) === 6);
        },
      );
      assert.ok(sleeps >= 1, `expected bounded retries, saw ${sleeps}`);
      assert.ok(!(await readdir(dir)).some(name => name.endsWith('.claim')));
    } finally {
      try {
        lock.exec('COMMIT');
      } catch {
        // The test assertion above may have already closed the handle.
      }
      try {
        lock.close();
      } catch {
        // The test assertion above may have already closed the handle.
      }
    }
  });
});

test('corrupt or unopenable compact databases reject instead of falling back', async () => {
  await withTempDir('corrupt-db', async dir => {
    await writeReceipt(dir, 1111);
    await writeFile(join(dir, DB), 'this is not sqlite', 'utf8');
    await assert.rejects(
      claimStoredNotificationEvent(dir, 'event', {
        currentPid: 2222,
        isAlive: () => false,
      }),
    );
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('.claim')));
  });

  await withTempDir('unopenable-db', async dir => {
    await writeReceipt(dir, 1111);
    await mkdir(join(dir, DB));
    await assert.rejects(
      claimStoredNotificationEvent(dir, 'event', {
        currentPid: 2222,
        isAlive: () => false,
      }),
    );
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('.claim')));
  });
});
