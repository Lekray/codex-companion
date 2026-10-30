'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');
const engine = require('../../scripts/companionPatches.cjs');
const history = require('../../scripts/patchOfficialHistory.cjs');
const titles = require('../../scripts/patchOfficialTitles.cjs');
const { applyStatusTransforms } = require('../../scripts/officialStatusTransform.cjs');
const { applyModelTransforms } = require('../../scripts/officialModelTransform.cjs');
const MANIFEST = require('../../resources/patchBundleManifest.json');

const BASE = path.join(REPO_ROOT, 'dist', 'autoscroll-integration', 'installer');
const LEGACY_ORIGINAL_DIR = path.join(REPO_ROOT, '.artifacts', 'openai-project-history', 'original');
const ORIGINAL_FIVE_DIR = path.join(REPO_ROOT, '.artifacts', 'productivity-021', 'original-five');
const ORIGINAL_DIR = MANIFEST.schema === 2 ? ORIGINAL_FIVE_DIR : LEGACY_ORIGINAL_DIR;
const LEGACY_ENGINE = path.join(
  REPO_ROOT,
  '.artifacts',
  'stable-020',
  'portable',
  'extension',
  'scripts',
  'companionPatches.cjs',
);
const FIFTH_FILE = 'webview/assets/app-initial-7a199c66e670.js';
const SCHEMA2 = MANIFEST.schema === 2;
const STAGE_NAMES = Object.keys(MANIFEST.stages);
const LATEST_STAGE = STAGE_NAMES[STAGE_NAMES.length - 1];
const TARGET_FILES = MANIFEST.files.filter(file => file !== 'package.json');
const BACKUP_MANIFEST_RENAME = MANIFEST.files.length + 1;
const FIRST_TARGET_RENAME = BACKUP_MANIFEST_RENAME + 1;
const LAST_TARGET_RENAME = BACKUP_MANIFEST_RENAME + TARGET_FILES.length;
const LAST_TARGET = TARGET_FILES[TARGET_FILES.length - 1];
const ROOTS = [];

process.env.LOCALAPPDATA = path.join(BASE, 'local-appdata');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function filePath(root, rel) {
  return path.join(root, ...rel.split('/'));
}

function backupStoragePath(backupDir, rel) {
  return path.join(backupDir, 'files', ...rel.split('/'));
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function statesForHashes(hashes) {
  const states = {};
  for (const rel of MANIFEST.files) {
    states[rel] = STAGE_NAMES.find(stage => MANIFEST.stages[stage][rel] === hashes[rel]) || 'foreign';
  }
  return states;
}

function stageStates(stage) {
  const hashes = {};
  for (const rel of MANIFEST.files) hashes[rel] = MANIFEST.stages[stage][rel];
  return statesForHashes(hashes);
}

function expectedFeatureStatuses(states) {
  return MANIFEST.features.map(feature => {
    const ranks = feature.files.map(rel => STAGE_NAMES.indexOf(states[rel]));
    if (ranks.some(rank => rank < 0)) return 'unverified';
    const minimum = STAGE_NAMES.indexOf(feature.stage);
    const above = ranks.filter(rank => rank >= minimum).length;
    if (above === ranks.length) return 'installed';
    if (above === 0) return 'missing';
    return 'partial';
  });
}

function buildStageBytes() {
  const original = new Map();
  for (const rel of MANIFEST.files) {
    const bytes = fsSync.readFileSync(filePath(ORIGINAL_DIR, rel));
    assert.equal(sha256(bytes), MANIFEST.stages.original[rel], `original fixture ${rel}`);
    original.set(rel, bytes);
  }

  let draft = null;
  if (SCHEMA2) {
    const moduleValue = require('../../scripts/officialDraftTransform.cjs');
    assert.equal(typeof moduleValue.applyDraftTransforms, 'function');
    draft = moduleValue.applyDraftTransforms;
  }

  const stages = Object.fromEntries(STAGE_NAMES.map(stage => [stage, new Map()]));
  for (const rel of MANIFEST.files) {
    const originalText = original.get(rel).toString('utf8');
    const historyText = history.PATCHED_FILES.includes(rel)
      ? history.generatePatchedText(rel, originalText)
      : originalText;
    const titleText = titles.PATCHED_FILES.includes(rel)
      ? titles.generatePatchedText(rel, historyText)
      : historyText;
    const workflowText = titles.PATCHED_FILES.includes(rel)
      ? applyModelTransforms(rel, applyStatusTransforms(rel, titleText))
      : titleText;
    const draftsText = draft ? draft(rel, workflowText) : workflowText;
    const texts = {
      original: originalText,
      history: historyText,
      titles: titleText,
      workflow: workflowText,
      drafts: draftsText,
    };
    for (const stage of STAGE_NAMES) stages[stage].set(rel, Buffer.from(texts[stage], 'utf8'));
  }
  for (const stage of STAGE_NAMES) {
    for (const rel of MANIFEST.files) {
      assert.equal(sha256(stages[stage].get(rel)), MANIFEST.stages[stage][rel], `${stage}:${rel} fixture hash`);
    }
  }
  return stages;
}

const STAGES = buildStageBytes();

after(async () => {
  for (const root of ROOTS) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function newRoot() {
  await fs.mkdir(BASE, { recursive: true });
  const root = await fs.mkdtemp(path.join(BASE, 'case-'));
  ROOTS.push(root);
  return root;
}

async function writeExt(root, stage, overrides = {}) {
  const extDir = path.join(root, 'ext');
  await fs.mkdir(path.join(extDir, 'out'), { recursive: true });
  await fs.mkdir(path.join(extDir, 'webview', 'assets'), { recursive: true });
  for (const rel of MANIFEST.files) {
    await fs.writeFile(filePath(extDir, rel), overrides[rel] ?? STAGES[stage].get(rel));
  }
  return extDir;
}

async function extensionHashes(extDir) {
  const hashes = {};
  for (const rel of MANIFEST.files) hashes[rel] = sha256(await fs.readFile(filePath(extDir, rel)));
  return hashes;
}

async function snapshotTree(root) {
  const result = {};
  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, rel);
      } else {
        const stat = await fs.stat(absolute);
        result[rel] = { hash: sha256(await fs.readFile(absolute)), mtimeMs: stat.mtimeMs };
      }
    }
  }
  await walk(root, '');
  return result;
}

function lockPathFor(backupDir) {
  return `${path.resolve(backupDir)}.install.lock`;
}

function patchRename(failAt) {
  const original = fs.rename;
  let count = 0;
  fs.rename = async function patchedRename(...args) {
    count += 1;
    if (count === failAt) {
      const error = new Error('injected rename failure');
      error.code = 'EINJECTED';
      throw error;
    }
    return original.apply(this, args);
  };
  return {
    restore() {
      fs.rename = original;
    },
    get count() {
      return count;
    },
  };
}

function patchRenameFrom(failFrom) {
  const original = fs.rename;
  let count = 0;
  fs.rename = async function patchedRename(...args) {
    count += 1;
    if (count >= failFrom) {
      const error = new Error('persistent injected rename failure');
      error.code = 'EINJECTED';
      throw error;
    }
    return original.apply(this, args);
  };
  return {
    restore() {
      fs.rename = original;
    },
  };
}

function patchAfterLastWrite(afterRenames, targetRel) {
  const originalRename = fs.rename;
  const originalRead = fs.readFile;
  const targetName = path.basename(targetRel);
  let renames = 0;
  let failNext = false;
  fs.rename = async function patchedRename(...args) {
    const result = await originalRename.apply(this, args);
    renames += 1;
    if (renames === afterRenames) failNext = true;
    return result;
  };
  fs.readFile = async function patchedRead(target, ...args) {
    if (failNext && String(target).endsWith(targetName)) {
      failNext = false;
      const error = new Error('injected post-write read failure');
      error.code = 'EINJECTED';
      throw error;
    }
    return originalRead.call(this, target, ...args);
  };
  return {
    restore() {
      fs.rename = originalRename;
      fs.readFile = originalRead;
    },
  };
}

async function captureMain(argv) {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  const originalExit = process.exitCode;
  process.stdout.write = chunk => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  process.exitCode = undefined;
  try {
    const result = await engine.main(argv);
    return {
      result,
      stdout: stdout.join(''),
      stderr: stderr.join(''),
      exitCode: process.exitCode,
    };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    process.exitCode = originalExit;
  }
}

test('check, clean install, immutable backup, exact restore and no-op repeats', async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const backupDir = path.join(root, 'backup');
  const extBefore = await snapshotTree(extDir);
  const packagePath = filePath(extDir, 'package.json');
  const packageMtime = (await fs.stat(packagePath)).mtimeMs;

  const before = await engine.check({ extDir, backupDir });
  assert.equal(before.schema, 1);
  assert.equal(before.version, '26.1007.21434');
  assert.equal(before.supportedVersion, '26.1007.21434');
  assert.equal(before.state, 'original');
  assert.equal(before.code, 'original');
  assert.deepEqual(before.files.map(file => file.path), MANIFEST.files);
  assert.ok(before.files.every(file => file.state === 'original' && file.hash === MANIFEST.stages.original[file.path]));
  assert.deepEqual(
    before.features.map(feature => feature.status),
    expectedFeatureStatuses(stageStates('original')),
  );
  assert.equal(before.backup.path, backupDir);
  assert.equal(before.backup.status, 'missing');
  assert.deepEqual(before.backup.issues, []);
  assert.equal(before.canInstall, true);
  assert.equal(before.canRestore, true);
  assert.equal(await exists(backupDir), false, 'check must not create the backup');
  assert.equal(await exists(lockPathFor(backupDir)), false, 'check must not create a lock');
  assert.deepEqual(await snapshotTree(extDir), extBefore, 'check must not modify the extension');

  const installed = await engine.install({ extDir, backupDir });
  assert.equal(installed.operation, 'install');
  assert.equal(installed.changed, true);
  assert.equal(installed.state, LATEST_STAGE);
  assert.equal(installed.code, LATEST_STAGE);
  assert.equal(installed.backup.status, 'valid');
  assert.deepEqual(
    installed.features.map(feature => feature.status),
    MANIFEST.features.map(() => 'installed'),
  );
  const installedHashes = await extensionHashes(extDir);
  for (const rel of MANIFEST.files) assert.equal(installedHashes[rel], MANIFEST.stages[LATEST_STAGE][rel], rel);
  assert.equal(installedHashes['package.json'], MANIFEST.stages.original['package.json']);
  assert.equal((await fs.stat(packagePath)).mtimeMs, packageMtime, 'install must not write package.json');

  for (const rel of MANIFEST.files) {
    assert.equal(
      sha256(await fs.readFile(backupStoragePath(backupDir, rel))),
      MANIFEST.stages.original[rel],
      `backup ${rel}`,
    );
  }
  const backupManifest = JSON.parse((await fs.readFile(path.join(backupDir, 'manifest.json'))).toString('utf8'));
  assert.equal(backupManifest.schema, 1);
  assert.equal(backupManifest.kind, 'codex-companion-pristine-backup');
  assert.equal(backupManifest.officialVersion, '26.1007.21434');
  assert.equal(backupManifest.publisher, 'openai');
  assert.equal(backupManifest.name, 'chatgpt');
  assert.equal(path.resolve(backupManifest.extensionPath), path.resolve(await fs.realpath(extDir)));
  assert.deepEqual(backupManifest.files, MANIFEST.stages.original);
  assert.equal(await exists(lockPathFor(backupDir)), false, 'lock must be released');

  const backupBefore = await snapshotTree(backupDir);
  const repeatInstall = await engine.install({ extDir, backupDir });
  assert.equal(repeatInstall.changed, false);
  assert.equal(repeatInstall.state, LATEST_STAGE);
  assert.deepEqual(await snapshotTree(backupDir), backupBefore, 'repeat install must not touch the backup');

  const restored = await engine.restore({ extDir, backupDir });
  assert.equal(restored.operation, 'restore');
  assert.equal(restored.changed, true);
  assert.equal(restored.state, 'original');
  assert.equal(restored.code, 'original');
  const restoredHashes = await extensionHashes(extDir);
  for (const rel of MANIFEST.files) assert.equal(restoredHashes[rel], MANIFEST.stages.original[rel], rel);
  assert.equal((await fs.stat(packagePath)).mtimeMs, packageMtime, 'restore must not write package.json');
  assert.deepEqual(await snapshotTree(backupDir), backupBefore, 'restore must keep the backup immutable');

  const repeatRestore = await engine.restore({ extDir, backupDir });
  assert.equal(repeatRestore.changed, false);
  assert.equal(repeatRestore.state, 'original');
  assert.deepEqual(await snapshotTree(backupDir), backupBefore);
});

test('feature evidence follows the min-stage mapping at history and titles', async () => {
  const root = await newRoot();
  const historyExt = await writeExt(root, 'history');
  const historyReport = await engine.check({ extDir: historyExt, backupDir: path.join(root, 'backup-h') });
  assert.equal(historyReport.state, 'history');
  assert.deepEqual(
    historyReport.features.map(feature => feature.status),
    expectedFeatureStatuses(stageStates('history')),
  );

  const titlesExt = await writeExt(root, 'titles');
  const titlesReport = await engine.check({ extDir: titlesExt, backupDir: path.join(root, 'backup-t') });
  assert.equal(titlesReport.state, 'titles');
  assert.deepEqual(
    titlesReport.features.map(feature => feature.status),
    expectedFeatureStatuses(stageStates('titles')),
  );
});

test('adopt an already workflow extension only with a verified source', async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'workflow');
  const backupDir = path.join(root, 'backup');
  const legacyBackupDir = path.join(root, 'no-legacy');

  const without = await engine.check({ extDir, backupDir, legacyBackupDir });
  assert.equal(without.state, 'workflow');
  assert.equal(without.backup.status, 'missing');
  assert.equal(without.canInstall, false);
  assert.equal(without.canRestore, false);
  assert.ok(without.issues.length > 0);
  await assert.rejects(engine.install({ extDir, backupDir, legacyBackupDir }), error => {
    assert.equal(error.report.state, 'workflow');
    return true;
  });
  assert.equal(await exists(backupDir), false);

  const withOriginal = await engine.check({ extDir, backupDir, originalDir: ORIGINAL_DIR });
  assert.equal(withOriginal.canInstall, true);
  assert.equal(withOriginal.canRestore, false);
  assert.equal(withOriginal.backup.status, 'missing');

  const adopted = await engine.install({ extDir, backupDir, originalDir: ORIGINAL_DIR });
  assert.equal(adopted.operation, 'install');
  assert.equal(adopted.changed, SCHEMA2);
  assert.equal(adopted.state, LATEST_STAGE);
  assert.equal(adopted.backup.status, 'valid');
  const adoptedHashes = await extensionHashes(extDir);
  for (const rel of MANIFEST.files) assert.equal(adoptedHashes[rel], MANIFEST.stages[LATEST_STAGE][rel], rel);
  for (const rel of MANIFEST.files) {
    assert.equal(sha256(await fs.readFile(backupStoragePath(backupDir, rel))), MANIFEST.stages.original[rel]);
  }

  const restored = await engine.restore({ extDir, backupDir });
  assert.equal(restored.changed, true);
  assert.equal(restored.state, 'original');
  for (const rel of MANIFEST.files) {
    assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), MANIFEST.stages.original[rel], rel);
  }
});

test('upgrade whole history and titles predecessors', async () => {
  const root = await newRoot();

  const historyExt = await writeExt(root, 'history');
  const historyBackup = path.join(root, 'backup-history');
  const upgradedHistory = await engine.install({
    extDir: historyExt,
    backupDir: historyBackup,
    originalDir: ORIGINAL_DIR,
  });
  assert.equal(upgradedHistory.changed, true);
  assert.equal(upgradedHistory.state, LATEST_STAGE);
  assert.equal(upgradedHistory.backup.status, 'valid');
  const historyHashes = await extensionHashes(historyExt);
  for (const rel of MANIFEST.files) assert.equal(historyHashes[rel], MANIFEST.stages[LATEST_STAGE][rel], rel);
  await engine.restore({ extDir: historyExt, backupDir: historyBackup });
  for (const rel of MANIFEST.files) {
    assert.equal(sha256(await fs.readFile(filePath(historyExt, rel))), MANIFEST.stages.original[rel], rel);
  }

  const historyExtNoOriginal = await writeExt(root, 'history');
  const historyWithoutBackup = {
    extDir: historyExtNoOriginal,
    backupDir: path.join(root, 'backup-history-none'),
    legacyBackupDir: path.join(root, 'no-legacy-history'),
  };
  const historyBeforeRefusal = await extensionHashes(historyExtNoOriginal);
  assert.equal((await engine.check(historyWithoutBackup)).canInstall, false);
  await assert.rejects(engine.install(historyWithoutBackup), /valid backup|original-dir|legacy/);
  assert.equal(await exists(path.join(root, 'backup-history-none')), false);
  assert.deepEqual(await extensionHashes(historyExtNoOriginal), historyBeforeRefusal);

  const titlesExt = await writeExt(root, 'titles');
  const titlesNoOriginal = await engine.check({
    extDir: titlesExt,
    backupDir: path.join(root, 'backup-titles-none'),
    legacyBackupDir: path.join(root, 'no-legacy-titles'),
  });
  assert.equal(titlesNoOriginal.state, 'titles');
  assert.equal(titlesNoOriginal.canInstall, false);
  assert.equal(titlesNoOriginal.canRestore, false);
  const titlesBeforeRefusal = await extensionHashes(titlesExt);
  await assert.rejects(engine.install({
    extDir: titlesExt,
    backupDir: path.join(root, 'backup-titles-none'),
    legacyBackupDir: path.join(root, 'no-legacy-titles'),
  }), /valid backup|original-dir|legacy/);
  assert.equal(await exists(path.join(root, 'backup-titles-none')), false);
  assert.deepEqual(await extensionHashes(titlesExt), titlesBeforeRefusal);
  await assert.rejects(
    engine.restore({ extDir: titlesExt, backupDir: path.join(root, 'backup-titles-none') }),
    /valid pristine backup/,
  );

  const titlesExt2 = await writeExt(root, 'titles');
  const titlesBackup = path.join(root, 'backup-titles');
  const upgradedTitles2 = await engine.install({
    extDir: titlesExt2,
    backupDir: titlesBackup,
    originalDir: ORIGINAL_DIR,
  });
  assert.equal(upgradedTitles2.backup.status, 'valid');
  await engine.restore({ extDir: titlesExt2, backupDir: titlesBackup });
  for (const rel of MANIFEST.files) {
    assert.equal(sha256(await fs.readFile(filePath(titlesExt2, rel))), MANIFEST.stages.original[rel], rel);
  }
});

test('mixed, foreign, unknown version and missing files refuse before any write', async () => {
  const root = await newRoot();

  {
    const extDir = await writeExt(root, 'original', {
      'out/extension.js': STAGES.history.get('out/extension.js'),
      'webview/assets/app-initial-97d3534ad35f.js': STAGES.history.get(
        'webview/assets/app-initial-97d3534ad35f.js',
      ),
      'webview/assets/app-initial-c014f9ee4429.js': STAGES.titles.get(
        'webview/assets/app-initial-c014f9ee4429.js',
      ),
    });
    const backupDir = path.join(root, 'backup-mixed');
    const before = await extensionHashes(extDir);
    const report = await engine.check({ extDir, backupDir, legacyBackupDir: path.join(root, 'no-legacy-mixed') });
    assert.equal(report.state, 'mixed');
    assert.equal(report.code, 'mixed');
    assert.equal(report.canInstall, false);
    assert.deepEqual(
      report.features.map(feature => feature.status),
      expectedFeatureStatuses(statesForHashes(before)),
    );
    await assert.rejects(engine.install({ extDir, backupDir, legacyBackupDir: path.join(root, 'no-legacy-mixed') }), error => {
      assert.equal(error.report.state, 'mixed');
      return true;
    });
    assert.deepEqual(await extensionHashes(extDir), before);
    assert.equal(await exists(backupDir), false);
  }

  {
    const extDir = await writeExt(root, 'original');
    const backupDir = path.join(root, 'backup-foreign');
    const target = filePath(extDir, 'webview/assets/app-initial-c014f9ee4429.js');
    await fs.appendFile(target, '\n// foreign edit\n');
    const before = await extensionHashes(extDir);
    const report = await engine.check({ extDir, backupDir });
    assert.equal(report.state, 'incompatible');
    assert.equal(report.code, 'unknown-stage');
    await assert.rejects(engine.install({ extDir, backupDir }));
    assert.deepEqual(await extensionHashes(extDir), before);
    assert.equal(await exists(backupDir), false);
  }

  {
    const extDir = await writeExt(root, 'original');
    const backupDir = path.join(root, 'backup-version');
    const packagePath = filePath(extDir, 'package.json');
    const packageJson = JSON.parse((await fs.readFile(packagePath)).toString('utf8'));
    packageJson.version = '26.9999.99999';
    await fs.writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    const before = await extensionHashes(extDir);
    const report = await engine.check({ extDir, backupDir });
    assert.equal(report.state, 'incompatible');
    assert.equal(report.code, 'unknown-version');
    assert.equal(report.version, '26.9999.99999');
    await assert.rejects(engine.install({ extDir, backupDir, originalDir: ORIGINAL_DIR }));
    assert.deepEqual(await extensionHashes(extDir), before);
    assert.equal(await exists(backupDir), false);
  }

  {
    const extDir = await writeExt(root, 'original');
    const backupDir = path.join(root, 'backup-missing');
    await fs.unlink(filePath(extDir, 'webview/assets/app-initial-97d3534ad35f.js'));
    const before = await extensionHashes(extDir).catch(() => null);
    const report = await engine.check({ extDir, backupDir });
    assert.equal(report.state, 'incompatible');
    assert.equal(report.code, 'missing-file');
    await assert.rejects(engine.install({ extDir, backupDir }));
    assert.equal(before, null);
    assert.equal(await exists(backupDir), false);
  }
});

test('corrupt or wrong-target backups refuse and stay untouched', async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const backupDir = path.join(root, 'backup');
  await engine.install({ extDir, backupDir });
  const corruptPath = backupStoragePath(backupDir, 'out/extension.js');
  const corruptBytes = Buffer.from(await fs.readFile(corruptPath));
  corruptBytes[0] ^= 0xff;
  await fs.writeFile(corruptPath, corruptBytes);
  const before = await extensionHashes(extDir);

  const report = await engine.check({ extDir, backupDir, originalDir: ORIGINAL_DIR });
  assert.equal(report.state, LATEST_STAGE);
  assert.equal(report.backup.status, 'invalid');
  assert.equal(report.canInstall, false);
  assert.equal(report.canRestore, false);
  assert.ok(report.backup.issues.some(issue => issue.includes('out/extension.js')));

  await assert.rejects(
    engine.install({ extDir, backupDir, originalDir: ORIGINAL_DIR }),
    /backup/i,
  );
  assert.deepEqual(await extensionHashes(extDir), before, 'corrupt backup must not change extension');
  assert.deepEqual(await fs.readFile(corruptPath), corruptBytes, 'corrupt backup must stay untouched');
  await assert.rejects(engine.restore({ extDir, backupDir }), /backup/i);
  assert.deepEqual(await extensionHashes(extDir), before);

  const otherRoot = await newRoot();
  const otherExt = await writeExt(otherRoot, 'workflow');
  const wrongTarget = await engine.check({ extDir: otherExt, backupDir });
  assert.equal(wrongTarget.state, 'workflow');
  assert.equal(wrongTarget.backup.status, 'invalid');
  assert.equal(wrongTarget.canInstall, false);
  assert.equal(wrongTarget.canRestore, false);
  const otherBefore = await extensionHashes(otherExt);
  await assert.rejects(engine.restore({ extDir: otherExt, backupDir }), /backup|bound/i);
  assert.deepEqual(await extensionHashes(otherExt), otherBefore);
});

test('overlapping and symlinked paths are refused without writes', async t => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');

  const insideBackup = path.join(extDir, 'backup');
  const insideReport = await engine.check({ extDir, backupDir: insideBackup });
  assert.equal(insideReport.state, 'incompatible');
  assert.equal(insideReport.code, 'unsafe-path');
  assert.equal(insideReport.canInstall, false);
  await assert.rejects(engine.install({ extDir, backupDir: insideBackup }));
  assert.equal(await exists(insideBackup), false);

  const outerRoot = await newRoot();
  const nestedExt = await writeExt(outerRoot, 'original');
  const outerReport = await engine.check({ extDir: nestedExt, backupDir: outerRoot });
  assert.equal(outerReport.state, 'incompatible');
  assert.equal(outerReport.code, 'unsafe-path');
  await assert.rejects(engine.install({ extDir: nestedExt, backupDir: outerRoot }));

  const symlinkBackup = path.join(root, 'backup-link');
  try {
    await fs.symlink(extDir, symlinkBackup, 'junction');
  } catch (error) {
    t.skip(`directory symlinks are unavailable: ${error.code || error.message}`);
    return;
  }
  const symlinkReport = await engine.check({ extDir, backupDir: symlinkBackup });
  assert.equal(symlinkReport.state, 'incompatible');
  assert.equal(symlinkReport.code, 'unsafe-path');
  await assert.rejects(engine.install({ extDir, backupDir: symlinkBackup }));
});

test('a symlinked target directory cannot redirect writes outside the extension', async t => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const outside = path.join(root, 'outside');
  await fs.mkdir(path.join(outside, 'assets'), { recursive: true });
  await fs.copyFile(
    filePath(extDir, 'webview/assets/app-initial-c014f9ee4429.js'),
    path.join(outside, 'assets/app-initial-c014f9ee4429.js'),
  );
  await fs.rm(path.join(extDir, 'webview'), { recursive: true, force: true });
  try {
    await fs.symlink(outside, path.join(extDir, 'webview'), 'junction');
  } catch (error) {
    t.skip(`directory symlinks are unavailable: ${error.code || error.message}`);
    return;
  }
  const backupDir = path.join(root, 'backup');
  const report = await engine.check({ extDir, backupDir });
  assert.equal(report.state, 'incompatible');
  assert.equal(report.code, 'unsafe-path');
  assert.equal(report.canInstall, false);
  await assert.rejects(engine.install({ extDir, backupDir }));
  assert.equal(await exists(backupDir), false);
});

test('injected write failures roll back to exact predecessors in every phase', async () => {
  async function prepare() {
    const root = await newRoot();
    const extDir = await writeExt(root, 'original');
    const backupDir = path.join(root, 'backup');
    const before = await extensionHashes(extDir);
    return { extDir, backupDir, before };
  }

  {
    const { extDir, backupDir, before } = await prepare();
    const patch = patchRename(2);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), /injected/);
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), before, 'backup-phase failure must leave extension intact');
    assert.equal(await exists(path.join(backupDir, 'manifest.json')), false);
    assert.equal((await engine.check({ extDir, backupDir })).backup.status, 'missing');
  }

  {
    const { extDir, backupDir, before } = await prepare();
    const patch = patchRename(FIRST_TARGET_RENAME);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), /injected/);
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), before, 'first target failure must leave extension intact');
    assert.equal((await engine.check({ extDir, backupDir })).backup.status, 'valid');
  }

  {
    const { extDir, backupDir, before } = await prepare();
    const patch = patchRename(BACKUP_MANIFEST_RENAME);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), /injected/);
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), before, 'backup manifest failure must leave extension intact');
    assert.equal((await engine.check({ extDir, backupDir })).backup.status, 'missing');
  }

  {
    const { extDir, backupDir, before } = await prepare();
    const patch = patchRename(LAST_TARGET_RENAME);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), error => {
        assert.equal(error.rollbackErrors, undefined);
        return /injected/.test(error.message);
      });
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), before, 'last target failure must roll back all writes');
    assert.equal((await engine.check({ extDir, backupDir })).backup.status, 'valid');
  }

  {
    const { extDir, backupDir, before } = await prepare();
    const patch = patchAfterLastWrite(LAST_TARGET_RENAME, LAST_TARGET);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), error => {
        assert.equal(error.rollbackErrors, undefined);
        return /post-write|verification|injected/i.test(error.message);
      });
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), before, 'failure after the last write must roll back');
    assert.equal((await engine.check({ extDir, backupDir })).backup.status, 'valid');
  }

  {
    const root = await newRoot();
    const extDir = await writeExt(root, 'original');
    const backupDir = path.join(root, 'backup');
    await engine.install({ extDir, backupDir });
    const patchedHashes = await extensionHashes(extDir);
    const patch = patchRename(2);
    try {
      await assert.rejects(engine.restore({ extDir, backupDir }), /injected/);
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), patchedHashes, 'restore failure must roll back to patched bytes');
    assert.equal((await engine.check({ extDir, backupDir })).backup.status, 'valid');
  }

  {
    const { extDir, backupDir } = await prepare();
    const patch = patchRenameFrom(LAST_TARGET_RENAME);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), error => {
        assert.ok(Array.isArray(error.rollbackErrors) && error.rollbackErrors.length > 0);
        assert.match(error.message, /rollback errors/i);
        return true;
      });
    } finally {
      patch.restore();
    }
  }
});

test('install lock blocks concurrent installers and is released only by its owner', async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const backupDir = path.join(root, 'backup');
  const before = await extensionHashes(extDir);
  const lockPath = lockPathFor(backupDir);
  await fs.writeFile(lockPath, '{"pid":999999}\n');

  await assert.rejects(engine.install({ extDir, backupDir }), error => {
    assert.equal(error.code, 'locked');
    assert.match(error.message, /manually/);
    return true;
  });
  assert.deepEqual(await extensionHashes(extDir), before);
  assert.equal(await exists(backupDir), false);
  assert.equal(await exists(lockPath), true, 'a stale lock must never be removed automatically');

  await fs.unlink(lockPath);
  const installed = await engine.install({ extDir, backupDir });
  assert.equal(installed.state, LATEST_STAGE);
  assert.equal(await exists(lockPath), false, 'successful install must release its own lock');
});

test('CLI parsing is strict and check exit codes follow state', async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const backupDir = path.join(root, 'backup');

  const duplicate = await captureMain([
    'check',
    '--extension',
    extDir,
    '--extension',
    extDir,
    '--backup',
    backupDir,
  ]);
  assert.equal(duplicate.exitCode, 1);
  assert.equal(JSON.parse(duplicate.stderr).error.code, 'invalid-arguments');
  assert.equal(duplicate.stdout, '');

  const duplicateLegacy = await captureMain([
    'check',
    '--extension',
    extDir,
    '--legacy-backup',
    path.join(root, 'legacy-a'),
    '--legacy-backup',
    path.join(root, 'legacy-b'),
  ]);
  assert.equal(duplicateLegacy.exitCode, 1);
  assert.equal(JSON.parse(duplicateLegacy.stderr).error.code, 'invalid-arguments');

  const unknown = await captureMain(['check', '--extension', extDir, '--nope', 'x']);
  assert.equal(unknown.exitCode, 1);
  assert.equal(JSON.parse(unknown.stderr).error.code, 'invalid-arguments');

  const ok = await captureMain(['check', '--extension', extDir, '--backup', backupDir]);
  assert.equal(ok.exitCode, 0);
  assert.equal(JSON.parse(ok.stdout).state, 'original');

  const mixedRoot = await newRoot();
  const mixedExt = await writeExt(mixedRoot, 'original', {
    'out/extension.js': STAGES.history.get('out/extension.js'),
    'webview/assets/app-initial-c014f9ee4429.js': STAGES.titles.get(
      'webview/assets/app-initial-c014f9ee4429.js',
    ),
  });
  const mixed = await captureMain([
    'check',
    '--extension',
    mixedExt,
    '--backup',
    path.join(mixedRoot, 'backup'),
  ]);
  assert.equal(mixed.exitCode, 1);
  assert.equal(JSON.parse(mixed.stdout).state, 'mixed');

  const installed = await captureMain(['install', '--extension', extDir, '--backup', backupDir]);
  assert.equal(installed.exitCode, 0);
  assert.equal(JSON.parse(installed.stdout).state, LATEST_STAGE);
  assert.equal(JSON.parse(installed.stdout).operation, 'install');
});

test('same target with different backups shares an installation lock', async () => {
  const root = await newRoot(), extDir = await writeExt(root, 'original');
  const backupA = path.join(root, 'backup-a'), backupB = path.join(root, 'backup-b');
  const originalRename = fs.rename;
  let enteredResolve, releaseResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const release = new Promise(resolve => { releaseResolve = resolve; });
  fs.rename = async function(source, destination) {
    if (destination === filePath(extDir, 'out/extension.js')) { enteredResolve(); await release; }
    return originalRename.call(this, source, destination);
  };
  const first = engine.install({ extDir, backupDir: backupA });
  try {
    await entered;
    await assert.rejects(engine.install({ extDir, backupDir: backupB }), error => error.code === 'locked');
    assert.equal(await exists(backupB), false);
  } finally {
    releaseResolve();
    await first;
    fs.rename = originalRename;
  }
  assert.equal(await exists(path.join(extDir, '.companion-patches.install.lock')), false);
});

test('rollback preserves foreign bytes that appeared during the operation', async () => {
  const root = await newRoot(), extDir = await writeExt(root, 'original');
  const backupDir = path.join(root, 'backup'), host = filePath(extDir, 'out/extension.js');
  const originalRename = fs.rename, externalBytes = Buffer.from('external updater bytes');
  fs.rename = async function(source, destination) {
    const value = await originalRename.call(this, source, destination);
    if (destination === host) await fs.writeFile(host, externalBytes);
    return value;
  };
  try {
    await assert.rejects(engine.install({ extDir, backupDir }), error => {
      assert.ok(error.rollbackErrors?.some(message => message.includes('changed externally')));
      return true;
    });
  } finally { fs.rename = originalRename; }
  assert.deepEqual(await fs.readFile(host), externalBytes);
  for (const file of MANIFEST.files.filter(file => file !== 'out/extension.js')) {
    assert.equal(sha256(await fs.readFile(filePath(extDir, file))), MANIFEST.stages.original[file]);
  }
});

test('an explicitly invalid original source is refused before backup or target writes', async () => {
  const root = await newRoot(), extDir = await writeExt(root, 'original'), backupDir = path.join(root, 'backup');
  const options = { extDir, backupDir, originalDir: path.join(root, 'missing-originals') };
  const before = await extensionHashes(extDir);
  assert.equal((await engine.check(options)).canInstall, false);
  await assert.rejects(engine.install(options));
  assert.equal(await exists(backupDir), false);
  assert.deepEqual(await extensionHashes(extDir), before);
});

test('schema2 legacy adoption upgrades old workflow, preserves legacy bytes and restores all five originals', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  const oldEngine = require(LEGACY_ENGINE);
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const legacyDir = path.join(root, 'legacy');
  const newBackupDir = path.join(root, 'new-backup');

  await oldEngine.install({ extDir, backupDir: legacyDir });
  const oldHashes = await extensionHashes(extDir);
  for (const rel of MANIFEST.files) {
    const expected = rel === FIFTH_FILE ? MANIFEST.stages.original[rel] : MANIFEST.stages.workflow[rel];
    assert.equal(oldHashes[rel], expected, rel);
  }
  const legacyBefore = await snapshotTree(legacyDir);

  const report = await engine.check({ extDir, backupDir: newBackupDir, legacyBackupDir: legacyDir });
  assert.equal(report.state, 'workflow');
  assert.equal(report.backup.status, 'missing');
  assert.equal(report.canInstall, true);
  assert.deepEqual(
    report.features.map(feature => feature.status),
    expectedFeatureStatuses(statesForHashes(oldHashes)),
  );

  const installed = await engine.install({ extDir, backupDir: newBackupDir, legacyBackupDir: legacyDir });
  assert.equal(installed.changed, true);
  assert.equal(installed.state, 'drafts');
  assert.equal(installed.backup.status, 'valid');
  const installedHashes = await extensionHashes(extDir);
  for (const rel of MANIFEST.files) assert.equal(installedHashes[rel], MANIFEST.stages.drafts[rel], rel);
  assert.deepEqual(await snapshotTree(legacyDir), legacyBefore, 'legacy backup must stay byte-identical');

  const backupManifest = JSON.parse((await fs.readFile(path.join(newBackupDir, 'manifest.json'))).toString('utf8'));
  assert.deepEqual(Object.keys(backupManifest.files).sort(), [...MANIFEST.files].sort());
  assert.deepEqual(backupManifest.files, MANIFEST.stages.original);

  const restored = await engine.restore({ extDir, backupDir: newBackupDir });
  assert.equal(restored.state, 'original');
  for (const rel of MANIFEST.files) {
    assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), MANIFEST.stages.original[rel], rel);
  }
  assert.equal((await engine.restore({ extDir, backupDir: newBackupDir })).changed, false);

  const reinstalled = await engine.install({ extDir, backupDir: newBackupDir });
  assert.equal(reinstalled.state, 'drafts');
  assert.equal(reinstalled.changed, true);
  assert.equal((await engine.install({ extDir, backupDir: newBackupDir })).changed, false);
  assert.deepEqual(await snapshotTree(legacyDir), legacyBefore);
});

test('schema2 defaults to drafts-v1 and the old version parent for legacy adoption', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  const oldEngine = require(LEGACY_ENGINE);
  const root = await newRoot();
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = path.join(root, 'localappdata');
  try {
    const defaultLegacy = path.join(
      process.env.LOCALAPPDATA,
      'codex-companion',
      'patches',
      MANIFEST.officialVersion,
    );
    const defaultNew = path.join(defaultLegacy, 'drafts-v1');
    const extDir = await writeExt(root, 'original');
    await oldEngine.install({ extDir, backupDir: defaultLegacy });
    const legacyBefore = await snapshotTree(defaultLegacy);

    const report = await engine.check({ extDir });
    assert.equal(report.backup.path, defaultNew);
    assert.equal(report.backup.status, 'missing');
    assert.equal(report.canInstall, true);

    const installed = await engine.install({ extDir });
    assert.equal(installed.backup.path, defaultNew);
    assert.equal(installed.state, 'drafts');
    assert.equal(installed.backup.status, 'valid');
    const legacyFilesOnly = async () => Object.fromEntries(Object.entries(await snapshotTree(defaultLegacy))
      .filter(([file]) => !file.startsWith('drafts-v1/')));
    assert.deepEqual(await legacyFilesOnly(), legacyBefore, 'old default backup files must stay unchanged');
    assert.equal(Object.keys(await snapshotTree(defaultNew)).length, MANIFEST.files.length + 1);

    await engine.restore({ extDir });
    for (const rel of MANIFEST.files) {
      assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), MANIFEST.stages.original[rel], rel);
    }

    const reinstalled = await engine.install({ extDir });
    assert.equal(reinstalled.state, 'drafts');
    assert.equal(reinstalled.changed, true);
    assert.deepEqual(await legacyFilesOnly(), legacyBefore);
  } finally {
    process.env.LOCALAPPDATA = previousLocalAppData;
  }
});

test('schema2 modified fifth bundle refuses legacy fallback without writes', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  const oldEngine = require(LEGACY_ENGINE);
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const legacyDir = path.join(root, 'legacy');
  const newBackupDir = path.join(root, 'new-backup');
  await oldEngine.install({ extDir, backupDir: legacyDir });
  await fs.appendFile(filePath(extDir, FIFTH_FILE), '\n// foreign fifth edit\n');
  const before = await extensionHashes(extDir);
  const legacyBefore = await snapshotTree(legacyDir);

  const report = await engine.check({ extDir, backupDir: newBackupDir, legacyBackupDir: legacyDir });
  assert.equal(report.state, 'incompatible');
  assert.equal(report.backup.status, 'missing');
  assert.equal(report.canInstall, false);
  await assert.rejects(engine.install({ extDir, backupDir: newBackupDir, legacyBackupDir: legacyDir }));
  assert.deepEqual(await extensionHashes(extDir), before);
  assert.equal(await exists(newBackupDir), false);
  assert.deepEqual(await snapshotTree(legacyDir), legacyBefore);
});

test('schema2 corrupt new backup refuses even with explicit originals', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const backupDir = path.join(root, 'backup');
  await engine.install({ extDir, backupDir });
  const corruptPath = backupStoragePath(backupDir, 'out/extension.js');
  const corruptBytes = Buffer.from(await fs.readFile(corruptPath));
  corruptBytes[0] ^= 0xff;
  await fs.writeFile(corruptPath, corruptBytes);
  const extBefore = await extensionHashes(extDir);
  const backupBefore = await snapshotTree(backupDir);

  const report = await engine.check({ extDir, backupDir, originalDir: ORIGINAL_DIR });
  assert.equal(report.state, 'drafts');
  assert.equal(report.backup.status, 'invalid');
  assert.equal(report.canInstall, false);
  assert.equal(report.canRestore, false);
  await assert.rejects(engine.install({ extDir, backupDir, originalDir: ORIGINAL_DIR }), /backup/i);
  await assert.rejects(engine.restore({ extDir, backupDir }), /backup/i);
  assert.deepEqual(await extensionHashes(extDir), extBefore);
  assert.deepEqual(await snapshotTree(backupDir), backupBefore);
});

test('schema2 drafts adoption is not a no-op without a source and uses explicit originals otherwise', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  const root = await newRoot();
  const extDir = await writeExt(root, 'drafts');
  const backupDir = path.join(root, 'backup');
  const noLegacy = path.join(root, 'no-legacy');
  const before = await extensionHashes(extDir);

  const without = await engine.check({ extDir, backupDir, legacyBackupDir: noLegacy });
  assert.equal(without.state, 'drafts');
  assert.equal(without.backup.status, 'missing');
  assert.equal(without.canInstall, false);
  await assert.rejects(engine.install({ extDir, backupDir, legacyBackupDir: noLegacy }));

  const adopted = await engine.install({ extDir, backupDir, originalDir: ORIGINAL_DIR });
  assert.equal(adopted.changed, false);
  assert.equal(adopted.state, 'drafts');
  assert.equal(adopted.backup.status, 'valid');
  assert.deepEqual(await extensionHashes(extDir), before);
  assert.equal((await engine.install({ extDir, backupDir })).changed, false);

  await engine.restore({ extDir, backupDir });
  for (const rel of MANIFEST.files) {
    assert.equal(sha256(await fs.readFile(filePath(extDir, rel))), MANIFEST.stages.original[rel], rel);
  }
});

test('schema2 partial write failures roll back after the first and last new target', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  for (const failAt of [FIRST_TARGET_RENAME, LAST_TARGET_RENAME]) {
    const root = await newRoot();
    const extDir = await writeExt(root, 'original');
    const backupDir = path.join(root, 'backup');
    const before = await extensionHashes(extDir);
    const patch = patchRename(failAt);
    try {
      await assert.rejects(engine.install({ extDir, backupDir }), /injected/);
    } finally {
      patch.restore();
    }
    assert.deepEqual(await extensionHashes(extDir), before, `failure at rename ${failAt} must roll back`);
    const report = await engine.check({ extDir, backupDir });
    assert.equal(report.state, 'original');
    assert.equal(report.backup.status, 'valid');
  }
});

test('schema2 invalid or wrong-target legacy backups are never overwritten', {
  skip: SCHEMA2 ? false : 'requires schema2 metadata',
}, async () => {
  const oldEngine = require(LEGACY_ENGINE);
  const root = await newRoot();
  const extDir = await writeExt(root, 'original');
  const legacyDir = path.join(root, 'legacy');
  const newBackupDir = path.join(root, 'new-backup');
  await oldEngine.install({ extDir, backupDir: legacyDir });
  const corruptPath = backupStoragePath(legacyDir, 'out/extension.js');
  const corruptBytes = Buffer.from(await fs.readFile(corruptPath));
  corruptBytes[0] ^= 0xff;
  await fs.writeFile(corruptPath, corruptBytes);
  const legacyBefore = await snapshotTree(legacyDir);

  const report = await engine.check({ extDir, backupDir: newBackupDir, legacyBackupDir: legacyDir });
  assert.equal(report.state, 'workflow');
  assert.equal(report.backup.status, 'missing');
  assert.equal(report.canInstall, false);
  assert.ok(report.issues.some(issue => issue.includes('legacy backup fallback')));
  await assert.rejects(engine.install({ extDir, backupDir: newBackupDir, legacyBackupDir: legacyDir }));
  assert.equal(await exists(newBackupDir), false);
  assert.deepEqual(await snapshotTree(legacyDir), legacyBefore);

  const otherRoot = await newRoot();
  const otherExt = await writeExt(otherRoot, 'original');
  const otherLegacy = path.join(otherRoot, 'legacy');
  const otherNewBackup = path.join(otherRoot, 'new-backup');
  await oldEngine.install({ extDir: otherExt, backupDir: otherLegacy });
  const otherManifestPath = path.join(otherLegacy, 'manifest.json');
  const otherManifest = JSON.parse((await fs.readFile(otherManifestPath)).toString('utf8'));
  otherManifest.extensionPath = path.join(otherRoot, 'different-ext');
  await fs.writeFile(otherManifestPath, `${JSON.stringify(otherManifest, null, 2)}\n`);
  const otherLegacyBefore = await snapshotTree(otherLegacy);
  const otherReport = await engine.check({
    extDir: otherExt,
    backupDir: otherNewBackup,
    legacyBackupDir: otherLegacy,
  });
  assert.equal(otherReport.backup.status, 'missing', 'legacy binding mismatch must not corrupt the new-backup report');
  assert.equal(otherReport.canInstall, false);
  await assert.rejects(engine.install({
    extDir: otherExt,
    backupDir: otherNewBackup,
    legacyBackupDir: otherLegacy,
  }));
  assert.equal(await exists(otherNewBackup), false);
  assert.deepEqual(await snapshotTree(otherLegacy), otherLegacyBefore);
});

test('modern versions resolve the new chunks-v6 backup leaf only', () => {
  assert.ok(engine.supportedVersions().includes('26.1021.22027'));
  const modern = engine.defaultBackupPathForVersion('26.1021.22027');
  assert.equal(
    modern,
    path.join(process.env.LOCALAPPDATA, 'codex-companion', 'patches', '26.1021.22027', 'chunks-v6'),
  );
  assert.equal(path.basename(modern), 'chunks-v6');
  assert.notEqual(path.basename(modern), 'chunks-v4');
  assert.notEqual(path.basename(modern), 'chunks-v3');
  assert.notEqual(path.basename(modern), 'chunks-v2');
  assert.notEqual(path.basename(modern), 'chunks-v1');
  assert.equal(path.basename(engine.defaultBackupPathForVersion('26.1007.21434')), 'drafts-v1');
});
