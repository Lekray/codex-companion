import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import {
  buildThreadsQuery,
  canonicalPath,
  HistoryReadError,
  isThreadId,
  loadProjectHistory,
  matchWorkspace,
  PERMITTED_THREAD_COLUMNS,
  readProjectHistorySync,
  relativeFolder,
  resolveCodexHome,
} from '../../src/projectHistoryWorker';

const artifactRoot = resolve(__dirname, '../../../.artifacts/project-history-tests');
mkdirSync(artifactRoot, { recursive: true });
const tempRoot = mkdtempSync(join(artifactRoot, 'run-'));
after(() => rmSync(tempRoot, { recursive: true, force: true }));

function home(name: string): string {
  const path = join(tempRoot, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function database(path: string, create: string, rows: readonly unknown[][]): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(create);
    const placeholders = rows.length ? ` (${rows[0]!.map(() => '?').join(',')})` : '';
    if (placeholders) {
      const statement = db.prepare(`INSERT INTO threads VALUES${placeholders}`);
      for (const row of rows) statement.run(...(row as (string | number | null)[]));
    }
  } finally {
    db.close();
  }
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';
const G = '77777777-7777-4777-8777-777777777777';
const H = '88888888-8888-4888-8888-888888888888';

test('workspace matching keeps exact boundaries, drive roots, UNC and duplicates', () => {
  const roots = ['C:/Work/App'];
  assert.ok(matchWorkspace('c:\\work\\app', roots));
  assert.ok(matchWorkspace('C:/Work/App/src/index.ts', roots));
  assert.equal(matchWorkspace('C:/Work/Application', roots), undefined);
  assert.equal(matchWorkspace('C:/Work/App-extra', roots), undefined);
  assert.equal(matchWorkspace('relative/path', roots), undefined);
  assert.equal(matchWorkspace('C:relative', roots), undefined);
  assert.equal(matchWorkspace('', roots), undefined);
  assert.equal(matchWorkspace('bad\0path', roots), undefined);
  assert.ok(matchWorkspace('C:\\Windows\\System32', ['C:/']));
  assert.ok(matchWorkspace('\\\\server\\share\\dir', ['\\\\Server\\Share']));
  assert.equal(matchWorkspace('\\\\server\\share2\\dir', ['\\\\server\\share']), undefined);
  const duplicate = matchWorkspace('C:/Work/App/sub', ['C:/Work/App', 'C:/Work/App/']);
  assert.ok(duplicate);
  assert.equal(duplicate.folder, 'sub');
  assert.equal(relativeFolder('C:/Work/App', 'C:/Work/App'), 'App');
  assert.equal(canonicalPath('C:/Work/App/'), 'c:\\work\\app');
  assert.equal(isThreadId(A), true);
  assert.equal(isThreadId('../escape'), false);
});

test('query selects permitted metadata only and does not filter history_mode', () => {
  const query = buildThreadsQuery([
    ...PERMITTED_THREAD_COLUMNS,
    'model_provider',
    'history_mode',
    'preview',
    'first_user_message',
    'rollout_path',
  ]);
  assert.deepEqual(query.selected, [...PERMITTED_THREAD_COLUMNS]);
  for (const privateColumn of ['model_provider', 'preview', 'first_user_message', 'rollout_path']) {
    assert.equal(query.sql.includes(`"${privateColumn}"`), false);
    assert.equal((query.selected as readonly string[]).includes(privateColumn), false);
  }
  assert.equal(/history_mode/i.test(query.sql), false);
});

test('extended Windows paths match ordinary roots without widening project boundaries', () => {
  const drive = String.raw`\\?\C:\Work\App\nested`;
  assert.equal(canonicalPath(drive), 'c:\\work\\app\\nested');
  assert.equal(matchWorkspace(drive, ['C:/Work/App'])?.folder, 'nested');
  assert.ok(matchWorkspace('C:/Work/App', [String.raw`\\?\C:\Work\App`]));
  assert.equal(matchWorkspace(String.raw`\\?\C:\Work\App-extra`, ['C:/Work/App']), undefined);
  assert.ok(matchWorkspace(String.raw`\\?\UNC\Server\Share\Project\child`, ['//server/share/project']));
  assert.equal(matchWorkspace(String.raw`\\?\UNC\server\share\project-extra`, ['//server/share/project']), undefined);
  assert.equal(relativeFolder('C:\\Work\\App\\.\\src\\', 'C:\\Work\\App\\'), 'src');
  assert.equal(relativeFolder('C:\\Work\\App\\.', 'C:\\Work\\App'), 'App');
  assert.equal(relativeFolder('C:\\Work\\App\\', 'C:\\Work\\App\\.\\'), 'App');
  assert.equal(relativeFolder('C:\\', 'C:\\'), 'C:\\');
  assert.equal(relativeFolder('C:\\Windows', 'C:\\'), 'Windows');
  assert.equal(relativeFolder(String.raw`\\?\UNC\Server\Share\Project\.\child` + '\\', '//server/share/project/'), 'child');
  assert.equal(relativeFolder('//server/share/project/child/', String.raw`\\?\UNC\server\share\project`), 'child');
  assert.equal(relativeFolder('c:\\work\\app\\Sub', 'C:\\Work\\App'), 'Sub');
  assert.equal(relativeFolder('/work/app/src/../lib/', '/work/app/'), 'lib');
  assert.equal(relativeFolder('/work/app', '/work/app/'), 'app');
  assert.equal(relativeFolder('/', '/'), '/');
  assert.equal(relativeFolder('/etc', '/'), 'etc');
  assert.equal(relativeFolder('/Work/App', '/work/app'), '/Work/App');
});

test('reads matching rows, excludes archives but retains chats with unset event flags', () => {
  const root = 'C:\\Work\\App';
  const nested = 'C:\\Work\\App\\nested';
  const directory = home('full');
  const path = join(directory, 'state_5.sqlite');
  database(path, `CREATE TABLE threads (
    "id" TEXT, "cwd" TEXT, "name" TEXT, "title" TEXT,
    "updated_at" INTEGER, "updated_at_ms" INTEGER, "recency_at_ms" INTEGER,
    "archived" INTEGER, "has_user_event" INTEGER, "model_provider" TEXT,
    "history_mode" TEXT, "preview" TEXT, "first_user_message" TEXT, "rollout_path" TEXT
  )`, [
    [A, root, 'Renamed conversation', 'Old title', 1000, 2000, 9_000_000, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [B, nested, '', 'Nested conversation', 9000, null, null, 0, 1, 'openai', 'legacy', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [C, root, null, '', 10, null, null, 0, 1, 'openai', 'legacy', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [D, root, 'Archived conversation', '', 20_000, null, null, 1, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [E, root, 'Eventless conversation', '', 21_000, null, null, 0, 0, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [F, 'C:\\Work\\App-extra', 'Sibling conversation', '', 22_000, null, null, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [G, 'C:\\Other', 'Foreign conversation', '', 23_000, null, null, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    ['not-a-uuid', root, 'Invalid conversation', '', 24_000, null, null, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
    [A, 'relative\\folder', 'Relative conversation', '', 25_000, null, null, 0, 1, 'openai', 'paginated', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL', 'PRIVATE_SENTINEL'],
  ]);
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');
  const entries = readProjectHistorySync(directory, [root]);
  const after = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(after, before);
  assert.deepEqual(entries.map(entry => entry.id), [E, A, B, C]);
  assert.equal(entries[1]!.name, 'Renamed conversation');
  assert.equal(entries[1]!.updatedAt, 9_000_000);
  assert.equal(entries[2]!.name, '');
  assert.equal(entries[2]!.title, 'Nested conversation');
  assert.equal(entries[3]!.name, '');
  assert.equal(entries[3]!.title, '');
  assert.equal(entries[2]!.folder, 'nested');
  assert.deepEqual(readdirSync(directory), ['state_5.sqlite']);
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['cwd', 'folder', 'id', 'name', 'root', 'title', 'updatedAt']);
  }
  assert.equal(JSON.stringify(entries).includes('PRIVATE_SENTINEL'), false);
});

test('works with optional columns absent and reports unsupported schemas', () => {
  const root = 'C:\\Work\\Minimal';
  const minimal = home('minimal');
  database(join(minimal, 'state_5.sqlite'),
    'CREATE TABLE threads ("id" TEXT, "cwd" TEXT, "title" TEXT, "updated_at" INTEGER)',
    [[A, root, 'Minimal conversation', 42]]);
  const entries = readProjectHistorySync(minimal, [root]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.updatedAt, 42_000);
  assert.equal(entries[0]!.title, 'Minimal conversation');

  const millis = home('millis');
  database(join(millis, 'state_5.sqlite'),
    'CREATE TABLE threads ("id" TEXT, "cwd" TEXT, "updated_at" INTEGER, "updated_at_ms" INTEGER)',
    [[A, root, 5, 6000]]);
  assert.equal(readProjectHistorySync(millis, [root])[0]!.updatedAt, 6000);

  const unsupported = home('unsupported');
  database(join(unsupported, 'state_5.sqlite'), 'CREATE TABLE threads ("id" TEXT)', []);
  assert.throws(() => readProjectHistorySync(unsupported, [root]),
    error => error instanceof HistoryReadError && error.code === 'unsupported');

  assert.throws(() => readProjectHistorySync(home('empty'), [root]),
    error => error instanceof HistoryReadError && error.code === 'missing');
});

test('missing and invalid timestamps are null and sort last while zero stays valid', () => {
  const root = 'C:\\Work\\Timestamp';
  const directory = home('timestamps');
  database(join(directory, 'state_5.sqlite'), `CREATE TABLE threads (
    "id" TEXT, "cwd" TEXT, "updated_at" INTEGER, "updated_at_ms" INTEGER, "recency_at_ms" INTEGER
  )`, [
    [A, root, 1, 5000, 9_000_000],
    [B, root, 1, 5000, null],
    [C, root, 4, null, null],
    [D, root, null, null, null],
    [E, root, 0, null, null],
    [F, root, 1, 7000, 1e300],
    [G, root, 8, null, 1e300],
    [H, root, null, null, null],
  ]);
  const entries = readProjectHistorySync(directory, [root]);
  assert.deepEqual(entries.map(entry => entry.id), [A, G, F, B, C, E, D, H]);
  assert.equal(entries[0]!.updatedAt, 9_000_000);
  assert.equal(entries[1]!.updatedAt, 8000);
  assert.equal(entries[2]!.updatedAt, 7000);
  assert.equal(entries[3]!.updatedAt, 5000);
  assert.equal(entries[4]!.updatedAt, 4000);
  assert.equal(entries[5]!.updatedAt, 0);
  assert.equal(entries[6]!.updatedAt, null);
  assert.equal(entries[7]!.updatedAt, null);
});

test('filesystem errors distinguish missing history from an invalid Codex home', () => {
  const root = 'C:\\Work\\Filesystem';
  assert.throws(() => readProjectHistorySync(join(tempRoot, 'absent-home'), [root]),
    error => error instanceof HistoryReadError && error.code === 'missing');
  const fileHome = join(tempRoot, 'file-home');
  writeFileSync(fileHome, 'not a directory');
  assert.throws(() => readProjectHistorySync(fileHome, [root]),
    error => error instanceof HistoryReadError && error.code === 'unavailable');
});

test('uses state_5 when both current and older indexes exist', () => {
  const root = 'C:\\Work\\Index';
  const directory = home('indexes');
  database(join(directory, 'state_4.sqlite'), 'CREATE TABLE threads ("id" TEXT, "cwd" TEXT)', [[B, root]]);
  database(join(directory, 'state_5.sqlite'), 'CREATE TABLE threads ("id" TEXT, "cwd" TEXT)', [[A, root]]);
  const entries = readProjectHistorySync(directory, [root]);
  assert.deepEqual(entries.map(entry => entry.id), [A]);
  assert.equal(resolveCodexHome({ CODEX_HOME: directory }, 'ignored'), directory);
});

test('worker thread returns only matching entries', async () => {
  const root = 'C:\\Work\\Worker';
  const directory = home('worker');
  database(join(directory, 'state_5.sqlite'),
    'CREATE TABLE threads ("id" TEXT, "cwd" TEXT, "name" TEXT, "recency_at_ms" INTEGER)',
    [[A, root, 'Worker conversation', 100], [B, 'C:\\Elsewhere', 'Other', 200], [C, root, 'No timestamp', null]]);
  const result = await loadProjectHistory({ home: directory, roots: [root] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.entries.map(entry => entry.id), [A, C]);
    assert.equal(result.entries[0]!.updatedAt, 100);
    assert.equal(result.entries[1]!.updatedAt, null);
  }
});

test('owned worker is terminated on timeout', async () => {
  const hangingWorker = join(tempRoot, 'hanging-worker.js');
  writeFileSync(hangingWorker, 'setInterval(() => {}, 1000);\n');
  const result = await loadProjectHistory({
    home: home('timeout'),
    roots: ['C:\\Work\\Timeout'],
    workerFile: hangingWorker,
    timeoutMs: 150,
  });
  assert.deepEqual(result, { ok: false, code: 'timeout' });
});
