import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  SCHEMA3_FILES,
  SCHEMA3_OFFICIAL_VERSION,
  attestationFileForVersion,
  compatibilityFilesForVersion,
  inspectOfficialPatch,
  type PatchAttestation,
} from '../../src/patchCompatibility';
import { PatchCompatibilityUi, type CompatibilityUiDependencies } from '../../src/patchCompatibilityUi';
import {
  OFFICIAL_OPEN_COMMAND,
  VERIFIED_EDITOR_VERSION,
  VERIFIED_EDITOR_VERSIONS,
  openOfficialCodex,
} from '../../src/officialCodex';

const NEW_VERSION = SCHEMA3_OFFICIAL_VERSION;
const OLD_VERSION = '26.1007.21434';
const LEGACY_FILES = [
  'package.json',
  'out/extension.js',
  'webview/assets/app-initial-97d3534ad35f.js',
  'webview/assets/app-initial-c014f9ee4429.js',
] as const;

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function packageJson(version: string): string {
  return JSON.stringify({ publisher: 'openai', name: 'chatgpt', version });
}

function officialFiles(version: string): Record<string, string> {
  const files: Record<string, string> = { 'package.json': packageJson(version) };
  for (const rel of SCHEMA3_FILES) {
    if (rel !== 'package.json') files[rel] = `official bundle ${rel}`;
  }
  return files;
}

function legacyFiles(): Record<string, string> {
  const files: Record<string, string> = { 'package.json': packageJson(OLD_VERSION) };
  for (const rel of LEGACY_FILES) {
    if (rel !== 'package.json') files[rel] = `legacy bundle ${rel}`;
  }
  return files;
}

function attestation(
  version: string,
  files: Record<string, string>,
  schema: 1 | 2 | 3 = 3,
  targets: readonly string[] = SCHEMA3_FILES,
): PatchAttestation {
  const hashes: Record<string, string> = {};
  for (const rel of targets) hashes[rel] = sha256(files[rel] ?? '');
  return { schema, officialVersion: version, features: ['project-history'], files: hashes };
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

const FIXTURE_ROOT = join(
  findProjectRoot(__dirname),
  '.artifacts',
  'update-024',
  'installer-work',
  'compatibility-fixtures',
);

async function fixture(t: TestContext, files: Record<string, string>): Promise<string> {
  await mkdir(FIXTURE_ROOT, { recursive: true });
  const directory = await mkdtemp(join(FIXTURE_ROOT, 'fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const target = join(directory, ...name.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return directory;
}

function filePath(root: string, file: string): string {
  return join(root, ...file.split('/'));
}

function uiDependencies(
  extensionPath: string,
  officialPath: string,
  version: string,
): CompatibilityUiDependencies {
  const store = new Map<string, unknown>();
  return {
    extensionPath,
    officialExtensionPath: () => officialPath,
    bridgeState: () => 'ready',
    hasOfficialTabs: () => true,
    globalState: {
      get<T>(key: string, defaultValue: T): T {
        return store.has(key) ? store.get(key) as T : defaultValue;
      },
      update(key, value) {
        store.set(key, value);
        return Promise.resolve();
      },
    },
    showWarning: async () => undefined,
    openReport: async () => undefined,
    officialVersion: () => version,
    now: () => 1,
  };
}

test('exact nine-file schema 3 attestation for 26.1021 is compatible and read-only', async t => {
  const files = officialFiles(NEW_VERSION);
  const directory = await fixture(t, files);
  const before = await Promise.all(SCHEMA3_FILES.map(file => readFile(filePath(directory, file))));

  const result = await inspectOfficialPatch(directory, attestation(NEW_VERSION, files));

  assert.deepEqual(result, { ok: true, code: 'ok', version: NEW_VERSION, issues: [] });
  assert.deepEqual(
    await Promise.all(SCHEMA3_FILES.map(file => readFile(filePath(directory, file)))),
    before,
  );
});

test('schema 3 rejects another version and any non-exact target set', async t => {
  const files = officialFiles(NEW_VERSION);
  const directory = await fixture(t, files);
  const valid = attestation(NEW_VERSION, files);

  const wrongVersion = await inspectOfficialPatch(directory, { ...valid, officialVersion: OLD_VERSION });
  assert.equal(wrongVersion.code, 'manifest');

  const extraTarget = await inspectOfficialPatch(directory, {
    ...valid,
    files: { ...valid.files, 'webview/assets/extra.js': sha256('extra') },
  });
  assert.equal(extraTarget.code, 'manifest');

  const missing = { ...valid.files };
  delete missing['webview/assets/composer-scope-f0dbf0e746b6.js'];
  const missingTarget = await inspectOfficialPatch(directory, { ...valid, files: missing });
  assert.equal(missingTarget.code, 'manifest');

  const trailing = await inspectOfficialPatch(directory, { ...valid, files: { ...valid.files }, schema: 1 });
  assert.equal(trailing.code, 'manifest');
});

test('schema 3 verifies every changed or missing bundle after the version matches', async t => {
  const files = officialFiles(NEW_VERSION);
  const directory = await fixture(t, files);
  const expected = attestation(NEW_VERSION, files);
  const changedFile = 'webview/assets/composer-content-8ab21f1a1982.js';

  await writeFile(filePath(directory, changedFile), 'tampered bundle');
  const changed = await inspectOfficialPatch(directory, expected);
  assert.equal(changed.code, 'files');
  assert.ok(changed.issues.some(issue => issue.includes(changedFile)));

  await writeFile(filePath(directory, changedFile), files[changedFile]!);
  const missingFile = 'webview/assets/message-bus-4113ba7287d7.js';
  await rm(filePath(directory, missingFile));
  const missing = await inspectOfficialPatch(directory, expected);
  assert.equal(missing.code, 'files');
  assert.ok(missing.issues.some(issue => issue.includes(missingFile)));
});

test('attestation resources stay legacy by default and select the 26.1021 file exactly', () => {
  assert.equal(attestationFileForVersion(undefined), 'patchAttestation.json');
  assert.equal(attestationFileForVersion(null), 'patchAttestation.json');
  assert.equal(attestationFileForVersion(OLD_VERSION), 'patchAttestation.json');
  assert.equal(attestationFileForVersion('26.2000.1'), 'patchAttestation.json');
  assert.equal(
    attestationFileForVersion(NEW_VERSION),
    `patchAttestation-${NEW_VERSION}.json`,
  );
  assert.deepEqual(compatibilityFilesForVersion(OLD_VERSION), [
    ...LEGACY_FILES,
    'webview/assets/app-initial-7a199c66e670.js',
  ]);
  assert.deepEqual(compatibilityFilesForVersion(NEW_VERSION), [...SCHEMA3_FILES]);
  assert.deepEqual(compatibilityFilesForVersion('26.2000.1'), compatibilityFilesForVersion(OLD_VERSION));
});

test('compatibility UI reads the versioned attestation resource for 26.1021', async t => {
  const officialPath = await fixture(t, officialFiles(NEW_VERSION));
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(
    join(extensionPath, 'resources', `patchAttestation-${NEW_VERSION}.json`),
    JSON.stringify(attestation(NEW_VERSION, officialFiles(NEW_VERSION))),
  );
  const ui = new PatchCompatibilityUi(uiDependencies(extensionPath, officialPath, NEW_VERSION), false);
  try {
    const status = await ui.check(true);
    assert.equal(status?.kind, 'ready');
    assert.equal(status?.version, NEW_VERSION);
    assert.equal(status?.report.code, 'ok');
  } finally {
    ui.dispose();
  }
});

test('compatibility UI keeps the legacy resource for the legacy version', async t => {
  const files = legacyFiles();
  const officialPath = await fixture(t, files);
  const extensionPath = await fixture(t, {});
  await mkdir(join(extensionPath, 'resources'), { recursive: true });
  await writeFile(
    join(extensionPath, 'resources', 'patchAttestation.json'),
    JSON.stringify(attestation(OLD_VERSION, files, 1, LEGACY_FILES)),
  );
  const ui = new PatchCompatibilityUi(uiDependencies(extensionPath, officialPath, OLD_VERSION), false);
  try {
    const status = await ui.check(true);
    assert.equal(status?.kind, 'ready');
    assert.equal(status?.version, OLD_VERSION);
  } finally {
    ui.dispose();
  }
});

test('official distinct-editor adapter accepts both verified versions and keeps the old export', async () => {
  assert.equal(VERIFIED_EDITOR_VERSION, OLD_VERSION);
  assert.ok(VERIFIED_EDITOR_VERSIONS.has(OLD_VERSION));
  assert.ok(VERIFIED_EDITOR_VERSIONS.has(NEW_VERSION));

  const identities: string[] = [];
  const mode = await openOfficialCodex({
    extension: () => ({ version: NEW_VERSION, activate: async () => undefined }),
    commands: async () => [OFFICIAL_OPEN_COMMAND],
    execute: async () => {
      assert.fail('The verified 26.1021 build must use the distinct-editor route');
    },
    openDistinctEditor: async id => {
      identities.push(id);
    },
  }, false);

  assert.equal(mode, 'distinct');
  assert.equal(identities.length, 1);
  assert.match(identities[0]!, /^[0-9a-f-]{36}$/);
});
