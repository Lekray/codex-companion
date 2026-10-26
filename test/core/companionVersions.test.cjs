'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const {
  createEngine,
  PatchError,
  LEGACY_SUPPORTED_VERSION,
} = require('../../scripts/companionPatchEngine.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');
const FIXTURE_ROOT = path.join(
  REPO_ROOT,
  '.artifacts',
  'webview-recovery',
  'integration',
  'installer-work',
  'version-fixtures',
);
const NEW_VERSION = '26.1099.1';
const OTHER_VERSION = '26.1099.2';
const FILES = [
  'package.json',
  'out/extension.js',
  'webview/assets/one.js',
  'webview/assets/two.js',
  'webview/assets/three.js',
  'webview/assets/four.js',
  'webview/assets/five.js',
  'webview/assets/six.js',
  'webview/assets/seven.js',
];
const RECOVERY_TARGET = 'webview/assets/bookmarked-thread-user-message-navigation.js';
const FILES10 = [...FILES, RECOVERY_TARGET];
const STAGES = ['original', 'history', 'titles', 'workflow', 'drafts'];
const FEATURES = [
  { id: 'project-history', stage: 'history', files: ['out/extension.js', 'webview/assets/one.js'] },
  { id: 'native-tab-titles', stage: 'titles', files: ['webview/assets/two.js'] },
  { id: 'workflow-notifications', stage: 'workflow', files: ['out/extension.js'] },
  { id: 'independent-drafts', stage: 'drafts', files: ['webview/assets/seven.js'] },
];
const FEATURES10 = [
  ...FEATURES,
  { id: 'webview-recovery', stage: 'drafts', files: [RECOVERY_TARGET] },
];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function filePath(root, rel) {
  return path.join(root, ...rel.split('/'));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function newRoot() {
  await fs.mkdir(FIXTURE_ROOT, { recursive: true });
  return fs.mkdtemp(path.join(FIXTURE_ROOT, 'version-'));
}

function originalTexts(version, files = FILES) {
  const texts = {};
  for (const rel of files) {
    texts[rel] = rel === 'package.json'
      ? JSON.stringify({ publisher: 'openai', name: 'chatgpt', version })
      : `// pristine ${rel}\n`;
  }
  return texts;
}

function transformFor(file, text, stage) {
  if (file === 'package.json') return text;
  return `${text}// ${stage}:${file}\n`;
}

function stageTexts(version, transform = transformFor, files = FILES) {
  const originals = originalTexts(version, files);
  const texts = { original: { ...originals } };
  for (const stage of STAGES.slice(1)) {
    texts[stage] = {};
    for (const rel of files) {
      texts[stage][rel] = transform(rel, texts[STAGES[STAGES.indexOf(stage) - 1]][rel], stage);
    }
  }
  return texts;
}

function buildSpec(version, transform = transformFor, files = FILES, features = FEATURES) {
  const texts = stageTexts(version, transform, files);
  return {
    SUPPORTED_VERSION: version,
    FILES: [...files],
    ORIGINAL_HASHES: Object.fromEntries(files.map(rel => [rel, sha256(Buffer.from(texts.original[rel]))])),
    STAGES: [...STAGES],
    FEATURES: features.map(feature => ({ ...feature, files: [...feature.files] })),
    transformStage: transform,
    texts,
  };
}

function buildManifest(spec) {
  const stages = {};
  for (const stage of spec.STAGES) {
    stages[stage] = Object.fromEntries(
      spec.FILES.map(rel => [rel, sha256(Buffer.from(spec.texts[stage][rel]))]),
    );
  }
  return {
    schema: 3,
    officialVersion: spec.SUPPORTED_VERSION,
    publisher: 'openai',
    name: 'chatgpt',
    files: [...spec.FILES],
    stages,
    features: spec.FEATURES.map(feature => ({ ...feature, files: [...feature.files] })),
  };
}

async function writeExt(root, spec, stage) {
  const extDir = path.join(root, 'ext');
  for (const rel of spec.FILES) {
    const target = filePath(extDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, spec.texts[stage][rel]);
  }
  return extDir;
}

function manifestPath(version) {
  return path.join(REPO_ROOT, 'resources', `patchBundleManifest-${version}.json`);
}

async function withManifests(manifests, fn) {
  const original = fsSync.readFileSync;
  const resolved = new Map(
    [...manifests.entries()].map(([version, manifest]) => [path.resolve(manifestPath(version)), JSON.stringify(manifest)]),
  );
  fsSync.readFileSync = function patched(target, ...args) {
    const key = typeof target === 'string' ? path.resolve(target) : null;
    if (key && resolved.has(key)) return resolved.get(key);
    return original.call(this, target, ...args);
  };
  try {
    return await fn();
  } finally {
    fsSync.readFileSync = original;
  }
}

async function withLocalAppData(root, fn) {
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  try {
    return await fn(process.env.LOCALAPPDATA);
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previous;
  }
}

async function snapshotDirectory(directory) {
  const snapshot = {};
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      const rel = path.relative(directory, full).split(path.sep).join('/');
      const stat = await fs.stat(full);
      snapshot[rel] = {
        sha256: sha256(await fs.readFile(full)),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    }
  }
  await walk(directory);
  return snapshot;
}

async function createOldNineBackup(root, localAppData, version) {
  const oldExt = path.join(root, 'old-nine-ext');
  const texts = originalTexts(version);
  for (const rel of FILES) {
    const target = filePath(oldExt, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, texts[rel]);
  }
  const backup = path.join(localAppData, 'codex-companion', 'patches', version, 'chunks-v1');
  await fs.mkdir(backup, { recursive: true });
  const files = {};
  for (const rel of FILES) {
    const target = filePath(backup, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, texts[rel]);
    files[rel] = sha256(Buffer.from(texts[rel]));
  }
  await fs.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({
    schema: 1,
    kind: 'codex-companion-pristine-backup',
    officialVersion: version,
    publisher: 'openai',
    name: 'chatgpt',
    extensionPath: oldExt,
    files,
  }, null, 2));
  return backup;
}

test('default engine keeps the accepted legacy manifest and version', () => {
  const manifest = require('../../resources/patchBundleManifest.json');
  for (const engine of [createEngine(), createEngine(null), createEngine(undefined)]) {
    assert.equal(engine.supportedVersion, LEGACY_SUPPORTED_VERSION);
    assert.equal(LEGACY_SUPPORTED_VERSION, '26.1007.21434');
    assert.deepEqual(engine.getManifest(), manifest);
  }
});

test('version specs are exact and fail closed on malformed metadata', () => {
  const spec = buildSpec(NEW_VERSION);
  assert.throws(() => createEngine({}), error => error instanceof PatchError && error.code === 'spec-invalid');
  assert.throws(
    () => createEngine({ ...spec, FILES: spec.FILES.slice(1) }),
    error => error.code === 'spec-invalid',
  );
  assert.throws(
    () => createEngine({ ...spec, STAGES: ['original', 'history', 'titles', 'workflow'] }),
    error => error.code === 'spec-invalid',
  );
  assert.throws(
    () => createEngine({ ...spec, ORIGINAL_HASHES: { ...spec.ORIGINAL_HASHES, [FILES[1]]: 'not-a-hash' } }),
    error => error.code === 'spec-invalid',
  );
  assert.throws(
    () => createEngine({ ...spec, FEATURES: [{ id: 'x', stage: 'unknown', files: [FILES[1]] }] }),
    error => error.code === 'spec-invalid',
  );
  assert.throws(() => createEngine({ ...spec, transformStage: null }), error => error.code === 'spec-invalid');
});

test('schema 3 engine backs up and restores all nine pinned files under chunks-v1 only', async () => {
  const root = await newRoot();
  const spec = buildSpec(NEW_VERSION);
  const manifest = buildManifest(spec);
  const extDir = await writeExt(root, spec, 'original');

  await withLocalAppData(root, async localAppData => {
    await withManifests(new Map([[NEW_VERSION, manifest]]), async () => {
      const engine = createEngine(spec);
      const expectedBackup = path.join(localAppData, 'codex-companion', 'patches', NEW_VERSION, 'chunks-v1');

      const before = await engine.check({ extDir });
      assert.equal(before.supportedVersion, NEW_VERSION);
      assert.equal(before.state, 'original');
      assert.equal(before.code, 'original');
      assert.equal(before.files.length, 9);
      assert.equal(before.backup.path, expectedBackup);
      assert.equal(before.backup.status, 'missing');
      assert.equal(before.canInstall, true);
      assert.deepEqual(before.features.map(feature => feature.id), FEATURES.map(feature => feature.id));

      const installed = await engine.install({ extDir });
      assert.equal(installed.state, 'drafts');
      assert.equal(installed.changed, true);
      assert.equal(installed.backup.status, 'valid');
      for (const rel of FILES) {
        assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), manifest.stages.drafts[rel], rel);
      }

      const backupManifest = JSON.parse(await fs.readFile(path.join(expectedBackup, 'manifest.json'), 'utf8'));
      assert.deepEqual(Object.keys(backupManifest.files).sort(), [...FILES].sort());
      assert.deepEqual(backupManifest.files, manifest.stages.original);
      assert.equal(await exists(path.join(localAppData, 'codex-companion', 'patches', LEGACY_SUPPORTED_VERSION)), false);

      const restored = await engine.restore({ extDir });
      assert.equal(restored.state, 'original');
      for (const rel of FILES) {
        assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), manifest.stages.original[rel], rel);
      }
      assert.equal((await engine.restore({ extDir })).changed, false);
    });
  });
});

test('ten-file schema 3 engine uses chunks-v2, restores ten and no-ops without touching the old nine backup', async () => {
  const root = await newRoot();
  const spec = buildSpec(NEW_VERSION, transformFor, FILES10, FEATURES10);
  const manifest = buildManifest(spec);
  const extDir = await writeExt(root, spec, 'original');

  await withLocalAppData(root, async localAppData => {
    const oldBackup = await createOldNineBackup(root, localAppData, NEW_VERSION);
    const oldSnapshot = await snapshotDirectory(oldBackup);
    await withManifests(new Map([[NEW_VERSION, manifest]]), async () => {
      const engine = createEngine(spec);
      const expectedBackup = path.join(localAppData, 'codex-companion', 'patches', NEW_VERSION, 'chunks-v2');

      const before = await engine.check({ extDir });
      assert.equal(before.files.length, 10);
      assert.equal(before.state, 'original');
      assert.equal(before.backup.path, expectedBackup);
      assert.equal(before.backup.status, 'missing');
      assert.equal(before.canInstall, true);
      assert.deepEqual(before.features.map(feature => feature.id), FEATURES10.map(feature => feature.id));

      const installed = await engine.install({ extDir });
      assert.equal(installed.state, 'drafts');
      assert.equal(installed.changed, true);
      assert.equal(installed.backup.status, 'valid');
      for (const rel of FILES10) {
        assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), manifest.stages.drafts[rel], rel);
      }

      const backupManifest = JSON.parse(await fs.readFile(path.join(expectedBackup, 'manifest.json'), 'utf8'));
      assert.deepEqual(Object.keys(backupManifest.files).sort(), [...FILES10].sort());
      assert.deepEqual(backupManifest.files, manifest.stages.original);
      assert.deepEqual(await snapshotDirectory(oldBackup), oldSnapshot);

      const installedAgain = await engine.install({ extDir });
      assert.equal(installedAgain.changed, false);
      assert.equal(installedAgain.state, 'drafts');
      assert.deepEqual(await snapshotDirectory(oldBackup), oldSnapshot);

      const restored = await engine.restore({ extDir });
      assert.equal(restored.state, 'original');
      for (const rel of FILES10) {
        assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), manifest.stages.original[rel], rel);
      }
      const restoredAgain = await engine.restore({ extDir });
      assert.equal(restoredAgain.changed, false);
      assert.equal(restoredAgain.state, 'original');
      assert.deepEqual(await snapshotDirectory(oldBackup), oldSnapshot);
    });
  });
});

test('ten-file engine rejects corrupted or omitted new target and leaves chunks-v2 backup read-only', async () => {
  const root = await newRoot();
  const spec = buildSpec(NEW_VERSION, transformFor, FILES10, FEATURES10);
  const manifest = buildManifest(spec);
  const extDir = await writeExt(root, spec, 'original');

  await withLocalAppData(root, async localAppData => {
    await withManifests(new Map([[NEW_VERSION, manifest]]), async () => {
      const engine = createEngine(spec);
      const installed = await engine.install({ extDir });
      assert.equal(installed.state, 'drafts');
      const backup = path.join(localAppData, 'codex-companion', 'patches', NEW_VERSION, 'chunks-v2');
      const backupSnapshot = await snapshotDirectory(backup);
      const target = filePath(extDir, RECOVERY_TARGET);
      const installedBytes = await fs.readFile(target);

      await fs.writeFile(target, 'tampered recovery target');
      const corrupted = await engine.check({ extDir });
      assert.equal(corrupted.state, 'incompatible');
      assert.equal(corrupted.code, 'unknown-stage');
      assert.equal(corrupted.canInstall, false);
      assert.equal(corrupted.canRestore, false);
      await assert.rejects(engine.install({ extDir }), error => error.code === 'unknown-stage');
      await assert.rejects(engine.restore({ extDir }), error => error.code === 'unknown-stage');
      assert.equal(await fs.readFile(target, 'utf8'), 'tampered recovery target');
      assert.deepEqual(await snapshotDirectory(backup), backupSnapshot);

      await fs.writeFile(target, installedBytes);
      await fs.rm(target);
      const omitted = await engine.check({ extDir });
      assert.equal(omitted.state, 'incompatible');
      assert.equal(omitted.code, 'missing-file');
      assert.equal(omitted.canInstall, false);
      assert.equal(omitted.canRestore, false);
      await assert.rejects(engine.install({ extDir }), error => error.code === 'missing-file');
      await assert.rejects(engine.restore({ extDir }), error => error.code === 'missing-file');
      assert.equal(await exists(target), false);
      assert.deepEqual(await snapshotDirectory(backup), backupSnapshot);
    });
  });
});

test('schema 3 engine refuses legacy adoption of an already patched install', async () => {
  const root = await newRoot();
  const spec = buildSpec(NEW_VERSION);
  const manifest = buildManifest(spec);
  const extDir = await writeExt(root, spec, 'workflow');

  await withLocalAppData(root, async localAppData => {
    await withManifests(new Map([[NEW_VERSION, manifest]]), async () => {
      const engine = createEngine(spec);
      const before = await engine.check({ extDir });
      assert.equal(before.state, 'workflow');
      assert.equal(before.canInstall, false);
      await assert.rejects(engine.install({ extDir }), error => error.code === 'workflow');
      for (const rel of FILES) {
        assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), manifest.stages.workflow[rel], rel);
      }
      assert.equal(
        await exists(path.join(localAppData, 'codex-companion', 'patches', NEW_VERSION, 'chunks-v1')),
        false,
      );
    });
  });
});

test('schema 3 manifest must match the pinned spec file set, hashes, stages and features', async () => {
  const root = await newRoot();
  const spec = buildSpec(NEW_VERSION);
  const manifest = buildManifest(spec);
  const extDir = await writeExt(root, spec, 'original');
  const cases = [
    { ...manifest, officialVersion: OTHER_VERSION },
    { ...manifest, files: manifest.files.slice(1) },
    { ...manifest, stages: { ...manifest.stages, original: { ...manifest.stages.original, [FILES[1]]: 'a'.repeat(64) } } },
    { ...manifest, features: manifest.features.slice(1) },
  ];

  for (const value of cases) {
    await withManifests(new Map([[NEW_VERSION, value]]), async () => {
      const engine = createEngine(spec);
      await assert.rejects(engine.check({ extDir }), error => error.code === 'manifest-invalid');
    });
  }
});

test('engine selection is per call and has no shared current version', async () => {
  const root = await newRoot();
  const specA = buildSpec(NEW_VERSION);
  const specB = buildSpec(OTHER_VERSION);
  const extA = await writeExt(path.join(root, 'a'), specA, 'original');
  const extB = await writeExt(path.join(root, 'b'), specB, 'original');

  await withManifests(new Map([
    [NEW_VERSION, buildManifest(specA)],
    [OTHER_VERSION, buildManifest(specB)],
  ]), async () => {
    const engineA = createEngine(specA);
    const engineB = createEngine(specB);
    const [reportA, reportB] = await Promise.all([
      engineA.check({ extDir: extA, backupDir: path.join(root, 'backup-a') }),
      engineB.check({ extDir: extB, backupDir: path.join(root, 'backup-b') }),
    ]);
    assert.equal(reportA.supportedVersion, NEW_VERSION);
    assert.equal(reportB.supportedVersion, OTHER_VERSION);
    assert.equal(reportA.state, 'original');
    assert.equal(reportB.state, 'original');
  });
});

function loadWrapper() {
  return require('../../scripts/companionPatches.cjs');
}

function loadRealNewSpec() {
  try {
    const value = require('../../scripts/official261021.cjs');
    if (!value || typeof value.SUPPORTED_VERSION !== 'string') return null;
    if (!Array.isArray(value.FILES) || value.FILES.length !== 11) return null;
    if (!value.ORIGINAL_HASHES || typeof value.ORIGINAL_HASHES !== 'object') return null;
    return value;
  } catch {
    return null;
  }
}

function realNewResourcesAvailable(spec) {
  const manifest = manifestPath(spec.SUPPORTED_VERSION);
  try {
    return fsSync.statSync(manifest).size > 0;
  } catch {
    return false;
  }
}

test('public facade keeps the legacy getManifest export and default backup path', () => {
  const facade = loadWrapper();
  assert.equal(typeof facade.check, 'function');
  assert.equal(typeof facade.PatchError, 'function');
  assert.deepEqual(facade.getManifest(), require('../../resources/patchBundleManifest.json'));
  assert.equal(
    facade.defaultBackupPathForVersion(LEGACY_SUPPORTED_VERSION),
    path.join(
      process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'),
      'codex-companion',
      'patches',
      LEGACY_SUPPORTED_VERSION,
      'drafts-v1',
    ),
  );
  assert.ok(facade.supportedVersions().includes(LEGACY_SUPPORTED_VERSION));
});

test('unknown installed versions fail closed read-only through the public facade', async () => {
  const facade = loadWrapper();
  const root = await newRoot();
  const extDir = path.join(root, 'ext');
  const backupDir = path.join(root, 'backup');
  await fs.mkdir(path.join(extDir, 'out'), { recursive: true });
  await fs.writeFile(filePath(extDir, 'package.json'), JSON.stringify({
    publisher: 'openai',
    name: 'chatgpt',
    version: '26.9999.99999',
  }));
  await fs.writeFile(filePath(extDir, 'out/extension.js'), 'foreign host bundle');
  const before = await fs.readFile(filePath(extDir, 'out/extension.js'));

  const report = await facade.check({ extDir, backupDir });
  assert.equal(report.code, 'unknown-version');
  assert.equal(report.version, '26.9999.99999');
  assert.equal(report.canInstall, false);
  assert.equal(report.canRestore, false);
  await assert.rejects(facade.install({ extDir, backupDir }));
  await assert.rejects(facade.restore({ extDir, backupDir }));
  assert.deepEqual(await fs.readFile(filePath(extDir, 'out/extension.js')), before);
  assert.equal(await exists(backupDir), false);
  assert.equal(await exists(path.join(extDir, '.companion-patches.install.lock')), false);
});

test('public facade routes the new official version to its own pinned engine', async t => {
  const facade = loadWrapper();
  const spec = loadRealNewSpec();
  if (!spec || !realNewResourcesAvailable(spec)) {
    t.skip('requires the integrated 26.1021 adapter spec and schema 3 manifest resource');
    return;
  }
  const root = await newRoot();
  const extDir = path.join(root, 'ext');
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(filePath(extDir, 'package.json'), JSON.stringify({
    publisher: 'openai',
    name: 'chatgpt',
    version: spec.SUPPORTED_VERSION,
  }));
  const report = await facade.check({ extDir, backupDir: path.join(root, 'backup') });
  assert.equal(report.supportedVersion, spec.SUPPORTED_VERSION);
  assert.equal(report.version, spec.SUPPORTED_VERSION);
  assert.deepEqual(report.files.map(file => file.path), [...spec.FILES]);
  assert.equal(
    facade.defaultBackupPathForVersion(spec.SUPPORTED_VERSION),
    path.join(
      process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'),
      'codex-companion',
      'patches',
      spec.SUPPORTED_VERSION,
      'chunks-v3',
    ),
  );
});
