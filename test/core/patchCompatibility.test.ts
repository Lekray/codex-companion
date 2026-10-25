import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { inspectOfficialPatch, type PatchAttestation } from '../../src/patchCompatibility';

const VERSION = '26.1007.21434';
const FILES = [
  'package.json',
  'out/extension.js',
  'webview/assets/app-initial-97d3534ad35f.js',
  'webview/assets/app-initial-c014f9ee4429.js',
] as const;

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ publisher: 'openai', name: 'chatgpt', version: VERSION, ...overrides });
}

const BASE: Record<string, string> = {
  'package.json': manifest(),
  'out/extension.js': 'official extension bundle',
  'webview/assets/app-initial-97d3534ad35f.js': 'first official webview bundle',
  'webview/assets/app-initial-c014f9ee4429.js': 'second official webview bundle',
};

function bundle(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...BASE, ...overrides };
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function attest(version: string, contents: Record<string, string | Buffer>, extra: Record<string, string> = {}): PatchAttestation {
  const files: Record<string, string> = { ...extra };
  for (const file of FILES) files[file] = sha256(contents[file] ?? '');
  return { schema: 1, officialVersion: version, features: ['history', 'tab-titles'], files };
}

function findProjectRoot(start: string): string {
  let current = start;
  for (;;) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error('Cannot locate the project root');
    current = parent;
  }
}

const FIXTURE_ROOT = join(findProjectRoot(__dirname), '.artifacts', 'workflow-v15', 'compatibility');

async function fixture(t: TestContext, files: Record<string, string | Buffer>): Promise<string> {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const directory = await mkdtemp(join(FIXTURE_ROOT, 'fixture-'));
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, ...name.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function filePath(root: string, file: string): string {
  return join(root, ...file.split('/'));
}

test('exact attested official build is compatible and remains byte-identical', async t => {
  const directory = await fixture(t, BASE);
  const before = await Promise.all(FILES.map(file => readFile(filePath(directory, file))));

  const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));

  assert.deepEqual(result, { ok: true, code: 'ok', version: VERSION, issues: [] });
  const after = await Promise.all(FILES.map(file => readFile(filePath(directory, file))));
  assert.deepEqual(after, before);
});

test('SHA256 hashes are accepted case-insensitively', async t => {
  const directory = await fixture(t, BASE);
  const attestation = attest(VERSION, BASE);
  for (const file of FILES) attestation.files[file] = attestation.files[file]!.toUpperCase();

  const result = await inspectOfficialPatch(directory, attestation);

  assert.equal(result.code, 'ok');
  assert.equal(result.ok, true);
});

test('unknown updated official version is reported before bundle reads', async t => {
  const updated = '26.1008.1';
  const directory = await fixture(t, { 'package.json': manifest({ version: updated }) });

  const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));

  assert.equal(result.ok, false);
  assert.equal(result.code, 'version');
  assert.equal(result.version, updated);
  assert.ok(result.issues.some(issue => issue.includes(updated) && issue.includes(VERSION)));
});

test('restored pristine patch is rejected by hash mismatch', async t => {
  const directory = await fixture(t, BASE);
  const patched = bundle({ 'out/extension.js': 'patched extension bundle' });

  const result = await inspectOfficialPatch(directory, attest(VERSION, patched));

  assert.equal(result.code, 'files');
  assert.equal(result.version, VERSION);
  assert.ok(result.issues.some(issue => issue.includes('out/extension.js')));
});

test('tampered bundle is rejected by hash mismatch', async t => {
  const tamperedFile = 'webview/assets/app-initial-c014f9ee4429.js';
  const directory = await fixture(t, bundle({ [tamperedFile]: 'tampered webview bundle' }));

  const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));

  assert.equal(result.code, 'files');
  assert.ok(result.issues.some(issue => issue.includes(tamperedFile)));
});

test('missing expected bundle file is reported as a file problem', async t => {
  const missingFile = 'out/extension.js';
  const directory = await fixture(t, BASE);
  await rm(filePath(directory, missingFile));

  const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));

  assert.equal(result.code, 'files');
  assert.equal(result.version, VERSION);
  assert.ok(result.issues.some(issue => issue.includes(missingFile)));
});

test('missing extension is reported without throwing', async t => {
  const invalid = await inspectOfficialPatch(undefined, attest(VERSION, BASE));
  assert.equal(invalid.code, 'missing');
  assert.equal(invalid.version, null);
  assert.ok(invalid.issues.length > 0);

  const emptyDirectory = await fixture(t, {});
  const missingManifest = await inspectOfficialPatch(emptyDirectory, attest(VERSION, BASE));
  assert.equal(missingManifest.code, 'missing');
  assert.equal(missingManifest.version, null);
});

test('invalid attestations are rejected as manifest problems', async t => {
  const directory = await fixture(t, BASE);
  const valid = attest(VERSION, BASE);
  const missingFile = { ...valid.files };
  delete missingFile['out/extension.js'];
  const cases: Array<{ name: string; value: unknown }> = [
    { name: 'non-object', value: null },
    { name: 'wrong schema', value: { ...valid, schema: 2 } },
    { name: 'empty version', value: { ...valid, officialVersion: '' } },
    { name: 'non-string feature', value: { ...valid, features: [1] } },
    { name: 'files not an object', value: { ...valid, files: [] } },
    { name: 'missing file record', value: { ...valid, files: missingFile } },
    { name: 'traversal target', value: { ...valid, files: { ...valid.files, '../../escape.js': 'a'.repeat(64) } } },
    { name: 'invalid hash', value: { ...valid, files: { ...valid.files, 'out/extension.js': 'abc' } } },
    { name: 'non-hex hash', value: { ...valid, files: { ...valid.files, 'package.json': 'g'.repeat(64) } } },
  ];

  for (const item of cases) {
    const result = await inspectOfficialPatch(directory, item.value);
    assert.equal(result.ok, false, item.name);
    assert.equal(result.code, 'manifest', item.name);
    assert.equal(result.version, null, item.name);
    assert.ok(result.issues.length > 0, item.name);
  }
});

test('invalid manifests are reported without throwing', async t => {
  const cases: Array<{ name: string; content: string }> = [
    { name: 'invalid JSON', content: '{not json' },
    { name: 'wrong publisher', content: manifest({ publisher: 'someone-else' }) },
    { name: 'wrong name', content: manifest({ name: 'not-chatgpt' }) },
    { name: 'missing version', content: manifest({ version: undefined }) },
  ];

  for (const item of cases) {
    const directory = await fixture(t, { 'package.json': item.content });
    const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));
    assert.equal(result.ok, false, item.name);
    assert.equal(result.code, 'manifest', item.name);
    assert.equal(result.version, null, item.name);
    assert.ok(result.issues.length > 0, item.name);
  }
});

test('read failures are reported as io without throwing', async t => {
  const directory = await fixture(t, BASE);
  const fsPromises = createRequire(__filename)('node:fs/promises') as { readFile: typeof readFile };
  const originalReadFile = fsPromises.readFile;
  fsPromises.readFile = (async () => {
    const error = new Error('access denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  }) as typeof readFile;

  try {
    const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'io');
    assert.equal(result.version, null);
    assert.ok(result.issues.some(issue => issue.includes('package.json')));
  } finally {
    fsPromises.readFile = originalReadFile;
  }
});

test('inspection reads only allowlisted files and never an unrelated target', async t => {
  const unrelated = 'unrelated/secret.txt';
  const directory = await fixture(t, { ...BASE, [unrelated]: 'not part of the official bundle' });
  const fsPromises = createRequire(__filename)('node:fs/promises') as { readFile: typeof readFile };
  const originalReadFile = fsPromises.readFile;
  const reads: string[] = [];
  fsPromises.readFile = (async (...args: unknown[]) => {
    reads.push(resolve(String(args[0])));
    return (originalReadFile as (...readArgs: unknown[]) => Promise<Buffer>)(...args);
  }) as typeof readFile;

  try {
    const result = await inspectOfficialPatch(directory, attest(VERSION, BASE));
    assert.equal(result.code, 'ok');
    assert.deepEqual(reads, FILES.map(file => resolve(filePath(directory, file))));

    reads.length = 0;
    const extraTarget = attest(VERSION, BASE, { [unrelated]: sha256('not part of the official bundle') });
    const rejected = await inspectOfficialPatch(directory, extraTarget);
    assert.equal(rejected.code, 'manifest');
    assert.deepEqual(reads, []);
  } finally {
    fsPromises.readFile = originalReadFile;
  }
});

test('schema 2 requires and verifies the additional composer bundle', async t => {
  const extra='webview/assets/app-initial-7a199c66e670.js';
  const content={...BASE,[extra]:'pinned test composer bundle'};
  const expected:PatchAttestation={...attest(VERSION,content),schema:2,files:{...attest(VERSION,content).files,[extra]:sha256(content[extra])}};
  const directory=await fixture(t,content);
  assert.equal((await inspectOfficialPatch(directory,expected)).code,'ok');
  await writeFile(filePath(directory,extra),'modified composer bundle');
  const changed=await inspectOfficialPatch(directory,expected);
  assert.equal(changed.code,'files');assert(changed.issues.some(issue=>issue.includes(extra)));
  const incomplete={...expected,files:{...expected.files}};delete incomplete.files[extra];
  assert.equal((await inspectOfficialPatch(directory,incomplete)).code,'manifest');
  assert.equal((await inspectOfficialPatch(directory,{...expected,schema:1})).code,'manifest');
});
