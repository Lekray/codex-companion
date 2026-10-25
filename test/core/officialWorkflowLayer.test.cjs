'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const {
  REQUIRED_GUARD,
  TARGET_FILES,
  sha256,
  atomicWriteFile,
  checkLayer,
  applyLayer,
  restoreLayer,
  createAttestation,
} = require('../../scripts/officialWorkflowLayer.cjs');

const ARTIFACT_DIR = path.join(__dirname, '..', '..', '.artifacts', 'workflow-v15', 'patcher');
const TARGET_OUT = 'out/extension.js';
const TARGET_WEB = 'webview/assets/app-initial-c014f9ee4429.js';
const ROOTS = [];

after(async () => {
  for (const root of ROOTS) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function fixture() {
  return {
    manifest: Buffer.from(
      JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: '1.2.3', displayName: 'ChatGPT' }),
      'utf8',
    ),
    guard: Buffer.from('// guard asset: window.__guard = true;\n', 'utf8'),
    outBaseline: Buffer.from('// out baseline\nexports.activate = () => 1;\n', 'utf8'),
    outPatched: Buffer.from('// out patched\nexports.activate = () => 2;\n', 'utf8'),
    webBaseline: Buffer.from('// web baseline\n', 'utf8'),
    webPatched: Buffer.from('// web patched\n', 'utf8'),
  };
}

function materialsFor(fx) {
  return {
    version: '1.2.3',
    publisher: 'openai',
    name: 'chatgpt',
    packageSha: sha256(fx.manifest),
    targets: {
      [TARGET_OUT]: { baseline: fx.outBaseline, patched: fx.outPatched },
      [TARGET_WEB]: { baseline: fx.webBaseline, patched: fx.webPatched },
    },
    guards: { [REQUIRED_GUARD]: sha256(fx.guard) },
    features: ['tab-status'],
  };
}

async function setup() {
  const root = await fs.mkdtemp(path.join(ARTIFACT_DIR, 'case-'));
  ROOTS.push(root);
  const extDir = path.join(root, 'ext');
  const backupDir = path.join(root, 'backup');
  const fx = fixture();
  await fs.mkdir(path.join(extDir, 'out'), { recursive: true });
  await fs.mkdir(path.join(extDir, 'webview', 'assets'), { recursive: true });
  await fs.writeFile(path.join(extDir, 'package.json'), fx.manifest);
  await fs.writeFile(filePath(extDir, REQUIRED_GUARD), fx.guard);
  await fs.writeFile(filePath(extDir, TARGET_OUT), fx.outBaseline);
  await fs.writeFile(filePath(extDir, TARGET_WEB), fx.webBaseline);
  return { root, extDir, backupDir, fx, materials: materialsFor(fx) };
}

function filePath(root, rel) {
  return path.join(root, ...rel.split('/'));
}

function backupPath(root, rel) {
  return path.join(root, 'backup', 'files', ...rel.split('/'));
}

async function readTarget(extDir, rel) {
  return fs.readFile(filePath(extDir, rel));
}

async function writeTarget(extDir, rel, bytes) {
  await fs.writeFile(filePath(extDir, rel), bytes);
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

test('check, apply, attestation and restore happy path', async () => {
  const { root, extDir, backupDir, fx, materials } = await setup();

  const before = await checkLayer({ extDir, materials });
  assert.equal(before.status, 'baseline');
  assert.equal(before.identityOk, true);
  assert.equal(before.files['package.json'], 'verified');
  assert.equal(before.files[REQUIRED_GUARD], 'verified');
  assert.equal(before.files[TARGET_OUT], 'baseline');
  assert.equal(before.files[TARGET_WEB], 'baseline');
  assert.deepEqual(before.issues, []);
  assert.equal(await exists(backupDir), false);

  const applied = await applyLayer({ extDir, backupDir, materials });
  assert.equal(applied.status, 'patched');
  assert.deepEqual(applied.applied, [TARGET_OUT, TARGET_WEB]);
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outPatched);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webPatched);

  assert.deepEqual(await fs.readFile(backupPath(root, TARGET_OUT)), fx.outBaseline);
  assert.deepEqual(await fs.readFile(backupPath(root, TARGET_WEB)), fx.webBaseline);
  const manifest = JSON.parse((await fs.readFile(path.join(backupDir, 'manifest.json'))).toString('utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.officialVersion, '1.2.3');
  assert.equal(manifest.packageSha, materials.packageSha);
  assert.equal(manifest.files[TARGET_OUT], sha256(fx.outBaseline));
  assert.equal(manifest.files[TARGET_WEB], sha256(fx.webBaseline));

  assert.deepEqual(await fs.readFile(path.join(extDir, 'package.json')), fx.manifest);
  assert.deepEqual(await fs.readFile(filePath(extDir, REQUIRED_GUARD)), fx.guard);
  assert.equal((await checkLayer({ extDir, materials })).status, 'patched');

  const attestation = createAttestation(materials);
  assert.equal(attestation.schema, 1);
  assert.equal(attestation.officialVersion, '1.2.3');
  assert.deepEqual(attestation.features, ['tab-status']);
  assert.deepEqual(
    Object.keys(attestation.files).sort(),
    ['package.json', REQUIRED_GUARD, TARGET_OUT, TARGET_WEB].sort(),
  );
  assert.equal(attestation.files['package.json'], materials.packageSha);
  assert.equal(attestation.files[REQUIRED_GUARD], sha256(fx.guard));
  assert.equal(attestation.files[TARGET_OUT], sha256(fx.outPatched));
  assert.equal(attestation.files[TARGET_WEB], sha256(fx.webPatched));

  const restored = await restoreLayer({ extDir, backupDir, materials });
  assert.equal(restored.status, 'baseline');
  assert.deepEqual(restored.restored, [TARGET_OUT, TARGET_WEB]);
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webBaseline);
  assert.deepEqual(await fs.readFile(path.join(extDir, 'package.json')), fx.manifest);
  assert.deepEqual(await fs.readFile(filePath(extDir, REQUIRED_GUARD)), fx.guard);
  assert.equal(await exists(backupPath(root, TARGET_OUT)), true);

  const again = await restoreLayer({ extDir, backupDir, materials });
  assert.deepEqual(again.restored, []);
});

test('repeat apply performs no target writes', async () => {
  const { extDir, backupDir, materials } = await setup();
  await applyLayer({ extDir, backupDir, materials });

  const again = await applyLayer({
    extDir,
    backupDir,
    materials,
    atomicWrite: async () => {
      throw new Error('unexpected write on idempotent apply');
    },
  });
  assert.equal(again.status, 'patched');
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.backupsCreated, []);
  assert.equal(again.manifestWritten, false);
});

test('apply on already patched targets recreates a missing backup', async () => {
  const { root, extDir, backupDir, fx, materials } = await setup();
  await applyLayer({ extDir, backupDir, materials });
  await fs.rm(backupDir, { recursive: true, force: true });

  const again = await applyLayer({ extDir, backupDir, materials });
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.backupsCreated, [TARGET_OUT, TARGET_WEB]);
  assert.deepEqual(await fs.readFile(backupPath(root, TARGET_OUT)), fx.outBaseline);
  assert.deepEqual(await fs.readFile(backupPath(root, TARGET_WEB)), fx.webBaseline);
  assert.equal(await exists(path.join(backupDir, 'manifest.json')), true);
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outPatched);

  const restored = await restoreLayer({ extDir, backupDir, materials });
  assert.deepEqual(restored.restored, [TARGET_OUT, TARGET_WEB]);
  assert.equal((await checkLayer({ extDir, materials })).status, 'baseline');
});

test('refuses unknown version, hashes, guard and target before any write', async () => {
  const variants = [
    ['unknown version', materials => ({ ...materials, version: '9.9.9' }), false],
    ['package hash', materials => ({ ...materials, packageSha: 'a'.repeat(64) }), false],
    ['guard hash', materials => ({ ...materials, guards: { [REQUIRED_GUARD]: 'b'.repeat(64) } }), true],
    ['missing guard', materials => ({ ...materials, guards: {} }), false],
    [
      'extra target',
      materials => ({
        ...materials,
        targets: { ...materials.targets, '../evil.js': { baseline: 'x', patched: 'y' } },
      }),
      false,
    ],
  ];

  for (const [name, mutate, expectedIdentity] of variants) {
    const { extDir, backupDir, fx, materials } = await setup();
    const bad = mutate(materials);
    const report = await checkLayer({ extDir, materials: bad });
    assert.equal(report.status, 'incompatible', name);
    assert.equal(report.identityOk, expectedIdentity, name);
    await assert.rejects(
      applyLayer({ extDir, backupDir, materials: bad }),
      /Invalid materials|Cannot apply/i,
      name,
    );
    assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline, name);
    assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webBaseline, name);
    assert.equal(await exists(backupDir), false, name);
  }
});

test('refuses installed publisher, name or version mismatch', async () => {
  const patches = [
    ['publisher', { publisher: 'someone-else' }],
    ['name', { name: 'not-chatgpt' }],
    ['version', { version: '2.0.0' }],
  ];

  for (const [name, patch] of patches) {
    const { extDir, backupDir, fx, materials } = await setup();
    const manifest = Buffer.from(
      JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: '1.2.3', ...patch }),
      'utf8',
    );
    await fs.writeFile(path.join(extDir, 'package.json'), manifest);
    const bad = { ...materials, packageSha: sha256(manifest) };

    const report = await checkLayer({ extDir, materials: bad });
    assert.equal(report.status, 'incompatible', name);
    assert.equal(report.identityOk, false, name);
    await assert.rejects(applyLayer({ extDir, backupDir, materials: bad }), /Cannot apply/i, name);
    assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline, name);
    assert.equal(await exists(backupDir), false, name);
  }
});

test('refuses corrupt existing backup and leaves it untouched', async () => {
  const { root, extDir, backupDir, fx, materials } = await setup();
  await fs.mkdir(path.dirname(backupPath(root, TARGET_OUT)), { recursive: true });
  const garbage = Buffer.from('not a baseline');
  await fs.writeFile(backupPath(root, TARGET_OUT), garbage);

  await assert.rejects(applyLayer({ extDir, backupDir, materials }), /backup/i);
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webBaseline);
  assert.deepEqual(await fs.readFile(backupPath(root, TARGET_OUT)), garbage);
  assert.equal(await exists(path.join(backupDir, 'manifest.json')), false);
});

test('refuses tampered or missing targets and missing package.json before writes', async () => {
  const tampered = await setup();
  await writeTarget(tampered.extDir, TARGET_WEB, Buffer.from('tampered webview'));
  const tamperedReport = await checkLayer(tampered);
  assert.equal(tamperedReport.status, 'incompatible');
  assert.equal(tamperedReport.files[TARGET_WEB], 'unknown');
  await assert.rejects(applyLayer(tampered), /Cannot apply/i);
  assert.deepEqual(await readTarget(tampered.extDir, TARGET_WEB), Buffer.from('tampered webview'));
  assert.equal(await exists(tampered.backupDir), false);

  const missingTarget = await setup();
  await fs.unlink(filePath(missingTarget.extDir, TARGET_WEB));
  assert.equal((await checkLayer(missingTarget)).files[TARGET_WEB], 'unknown');
  await assert.rejects(applyLayer(missingTarget), /Cannot apply/i);
  assert.deepEqual(await readTarget(missingTarget.extDir, TARGET_OUT), missingTarget.fx.outBaseline);
  assert.equal(await exists(missingTarget.backupDir), false);

  const missingPackage = await setup();
  await fs.unlink(path.join(missingPackage.extDir, 'package.json'));
  const missingPackageReport = await checkLayer(missingPackage);
  assert.equal(missingPackageReport.status, 'incompatible');
  assert.equal(missingPackageReport.identityOk, false);
  await assert.rejects(applyLayer(missingPackage), /Cannot apply/i);
  assert.equal(await exists(missingPackage.backupDir), false);
});

test('restore refuses corrupt, missing or mismatched backups', async () => {
  const first = await setup();
  await applyLayer(first);
  await fs.writeFile(backupPath(first.root, TARGET_OUT), Buffer.from('garbage'));
  await assert.rejects(restoreLayer(first), /backup/i);
  assert.deepEqual(await readTarget(first.extDir, TARGET_OUT), first.fx.outPatched);
  assert.deepEqual(await readTarget(first.extDir, TARGET_WEB), first.fx.webPatched);

  const second = await setup();
  await applyLayer(second);
  await fs.unlink(backupPath(second.root, TARGET_OUT));
  await assert.rejects(restoreLayer(second), /missing/i);
  assert.deepEqual(await readTarget(second.extDir, TARGET_OUT), second.fx.outPatched);
  assert.deepEqual(await readTarget(second.extDir, TARGET_WEB), second.fx.webPatched);

  const third = await setup();
  await applyLayer(third);
  await fs.writeFile(path.join(third.backupDir, 'manifest.json'), Buffer.from('{broken'));
  await assert.rejects(restoreLayer(third), /manifest/i);
  assert.deepEqual(await readTarget(third.extDir, TARGET_OUT), third.fx.outPatched);
});

test('apply rolls back exact prior bytes when the second target write fails', async () => {
  const { root, extDir, backupDir, fx, materials } = await setup();
  let targetWrites = 0;
  const atomicWrite = async (fileAndPath, bytes) => {
    if (fileAndPath.startsWith(extDir)) {
      targetWrites += 1;
      if (targetWrites === 2) throw new Error('injected target failure');
    }
    return atomicWriteFile(fileAndPath, bytes);
  };

  await assert.rejects(
    applyLayer({ extDir, backupDir, materials, atomicWrite }),
    /injected target failure/,
  );
  assert.equal(targetWrites, 2);
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webBaseline);
  assert.equal(await exists(path.join(backupDir, 'manifest.json')), false);
  assert.equal(await exists(backupPath(root, TARGET_OUT)), false);
  assert.equal((await checkLayer({ extDir, materials })).status, 'baseline');
});

test('apply rolls back exact prior bytes when the manifest write fails', async () => {
  const { extDir, backupDir, fx, materials } = await setup();
  const atomicWrite = async (fileAndPath, bytes) => {
    if (fileAndPath.endsWith('manifest.json')) throw new Error('injected manifest failure');
    return atomicWriteFile(fileAndPath, bytes);
  };

  await assert.rejects(
    applyLayer({ extDir, backupDir, materials, atomicWrite }),
    /injected manifest failure/,
  );
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webBaseline);
  assert.equal(await exists(path.join(backupDir, 'manifest.json')), false);
  assert.equal(await exists(backupPath(path.dirname(backupDir), TARGET_OUT)), false);
  assert.equal((await checkLayer({ extDir, materials })).status, 'baseline');
});

test('mixed state is classified and applied/restored selectively', async () => {
  const { extDir, backupDir, fx, materials } = await setup();
  await writeTarget(extDir, TARGET_WEB, fx.webPatched);

  const mixed = await checkLayer({ extDir, materials });
  assert.equal(mixed.status, 'mixed');
  assert.equal(mixed.files[TARGET_OUT], 'baseline');
  assert.equal(mixed.files[TARGET_WEB], 'patched');

  const applied = await applyLayer({ extDir, backupDir, materials });
  assert.deepEqual(applied.applied, [TARGET_OUT]);
  assert.equal(applied.status, 'patched');
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webPatched);

  await writeTarget(extDir, TARGET_OUT, fx.outBaseline);
  assert.equal((await checkLayer({ extDir, materials })).status, 'mixed');
  const restored = await restoreLayer({ extDir, backupDir, materials });
  assert.deepEqual(restored.restored, [TARGET_WEB]);
  assert.equal(restored.status, 'baseline');
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outBaseline);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webBaseline);
});

test('restore failure rolls back to exact prior patched bytes', async () => {
  const { extDir, backupDir, fx, materials } = await setup();
  await applyLayer({ extDir, backupDir, materials });

  let targetWrites = 0;
  const atomicWrite = async (fileAndPath, bytes) => {
    if (fileAndPath.startsWith(extDir)) {
      targetWrites += 1;
      if (targetWrites === 2) throw new Error('injected restore failure');
    }
    return atomicWriteFile(fileAndPath, bytes);
  };

  await assert.rejects(
    restoreLayer({ extDir, backupDir, materials, atomicWrite }),
    /injected restore failure/,
  );
  assert.equal(targetWrites, 2);
  assert.deepEqual(await readTarget(extDir, TARGET_OUT), fx.outPatched);
  assert.deepEqual(await readTarget(extDir, TARGET_WEB), fx.webPatched);
  assert.equal((await checkLayer({ extDir, materials })).status, 'patched');
  assert.equal(await exists(backupPath(path.dirname(backupDir), TARGET_OUT)), true);
});

test('check is read-only and never creates directories', async () => {
  const root = await fs.mkdtemp(path.join(ARTIFACT_DIR, 'case-'));
  ROOTS.push(root);
  const extDir = path.join(root, 'missing-extension');
  const report = await checkLayer({ extDir, materials: materialsFor(fixture()) });
  assert.equal(report.status, 'incompatible');
  assert.equal(report.identityOk, false);
  assert.equal(await exists(extDir), false);
  assert.deepEqual(TARGET_FILES, [TARGET_OUT, TARGET_WEB]);
});
