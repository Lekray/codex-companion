'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const OFFICIAL_PUBLISHER = 'openai';
const OFFICIAL_NAME = 'chatgpt';
const PACKAGE_FILE = 'package.json';
const REQUIRED_GUARD = 'webview/assets/app-initial-97d3534ad35f.js';
const TARGET_FILES = Object.freeze([
  'out/extension.js',
  'webview/assets/app-initial-c014f9ee4429.js',
]);
const TARGET_FILE_SET = new Set(TARGET_FILES);
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MANIFEST_SCHEMA = 1;
const MANIFEST_FILE = 'manifest.json';

let tempCounter = 0;

class LayerError extends Error {
  constructor(message, code = 'layer-error') {
    super(message);
    this.name = 'LayerError';
    this.code = code;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return null;
}

function normalizeSha(value) {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) return null;
  return value.toLowerCase();
}

function safeJoin(root, relativePath) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw new LayerError('Root path must be a non-empty string.', 'invalid-path');
  }
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    relativePath.includes('\\') ||
    relativePath.includes('\0')
  ) {
    throw new LayerError(`Unsafe relative path: ${String(relativePath)}.`, 'invalid-path');
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new LayerError(`Unsafe relative path: ${relativePath}.`, 'invalid-path');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new LayerError(`Path escapes root: ${relativePath}.`, 'invalid-path');
  }
  return resolved;
}

function assertDirectoryArgs(extDir, backupDir) {
  if (typeof extDir !== 'string' || extDir.trim() === '') {
    throw new LayerError('extDir must be a non-empty string.', 'invalid-path');
  }
  if (typeof backupDir !== 'string' || backupDir.trim() === '') {
    throw new LayerError('backupDir must be a non-empty string.', 'invalid-path');
  }
}

function validateMaterials(materials) {
  if (!isRecord(materials)) {
    throw new LayerError('Materials must be an object.', 'invalid-materials');
  }

  const issues = [];
  if (typeof materials.version !== 'string' || materials.version.trim() === '') {
    issues.push('materials.version must be a non-empty string.');
  }
  if (materials.publisher !== OFFICIAL_PUBLISHER) {
    issues.push(`materials.publisher must be ${OFFICIAL_PUBLISHER}.`);
  }
  if (materials.name !== OFFICIAL_NAME) {
    issues.push(`materials.name must be ${OFFICIAL_NAME}.`);
  }
  const packageSha = normalizeSha(materials.packageSha);
  if (!packageSha) issues.push('materials.packageSha must be a SHA256 hex string.');

  const targets = {};
  if (!isRecord(materials.targets)) {
    issues.push('materials.targets must be an object.');
  } else {
    for (const key of Object.keys(materials.targets)) {
      if (!TARGET_FILE_SET.has(key)) issues.push(`Unsupported target file: ${key}.`);
    }
    for (const rel of TARGET_FILES) {
      const entry = materials.targets[rel];
      if (!isRecord(entry)) {
        issues.push(`Missing target material: ${rel}.`);
        continue;
      }
      const baseline = toBuffer(entry.baseline);
      const patched = toBuffer(entry.patched);
      if (!baseline) issues.push(`Target ${rel} baseline must be a Buffer or string.`);
      if (!patched) issues.push(`Target ${rel} patched must be a Buffer or string.`);
      if (!baseline || !patched) continue;
      const baselineSha = sha256(baseline);
      const patchedSha = sha256(patched);
      if (baselineSha === patchedSha) issues.push(`Target ${rel} baseline and patched bytes are identical.`);
      targets[rel] = { baseline, patched, baselineSha, patchedSha };
    }
  }

  const guards = {};
  if (!isRecord(materials.guards)) {
    issues.push('materials.guards must be an object.');
  } else {
    for (const key of Object.keys(materials.guards)) {
      if (key !== REQUIRED_GUARD) issues.push(`Unsupported guard file: ${key}.`);
    }
    if (!Object.prototype.hasOwnProperty.call(materials.guards, REQUIRED_GUARD)) {
      issues.push(`materials.guards must include ${REQUIRED_GUARD}.`);
    }
    for (const [key, value] of Object.entries(materials.guards)) {
      const normalized = normalizeSha(value);
      if (!normalized) {
        issues.push(`Guard hash for ${key} must be a SHA256 hex string.`);
        continue;
      }
      if (key === REQUIRED_GUARD) guards[key] = normalized;
    }
  }

  if (!Array.isArray(materials.features) || materials.features.some(feature => typeof feature !== 'string')) {
    issues.push('materials.features must be an array of strings.');
  }

  if (issues.length > 0) {
    const error = new LayerError(`Invalid materials: ${issues.join(' ')}`, 'invalid-materials');
    error.issues = issues;
    throw error;
  }

  return {
    version: materials.version,
    publisher: materials.publisher,
    name: materials.name,
    packageSha,
    targets,
    guards,
    features: [...materials.features],
  };
}

function expectedManifest(materials) {
  const files = {};
  for (const rel of TARGET_FILES) files[rel] = materials.targets[rel].baselineSha;
  return {
    schema: MANIFEST_SCHEMA,
    officialVersion: materials.version,
    packageSha: materials.packageSha,
    files,
  };
}

function manifestBytesFor(materials) {
  return Buffer.from(`${JSON.stringify(expectedManifest(materials), null, 2)}\n`, 'utf8');
}

function validateManifest(bytes, materials) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return `manifest is not valid JSON (${errorText(error)}).`;
  }
  if (!isRecord(parsed)) return 'manifest must contain a JSON object.';
  if (parsed.schema !== MANIFEST_SCHEMA) return `manifest schema must be ${MANIFEST_SCHEMA}.`;
  if (parsed.officialVersion !== materials.version) return 'manifest officialVersion does not match the material version.';
  if (parsed.packageSha !== materials.packageSha) return 'manifest packageSha does not match the pinned package hash.';
  if (!isRecord(parsed.files)) return 'manifest files must be an object.';
  for (const rel of TARGET_FILES) {
    if (parsed.files[rel] !== materials.targets[rel].baselineSha) {
      return `manifest baseline hash for ${rel} does not match the material.`;
    }
  }
  return null;
}

function backupFilePath(backupDir, rel) {
  return path.join(backupDir, 'files', ...rel.split('/'));
}

async function readOptional(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

async function atomicWriteFile(filePath, data) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${tempCounter++}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(tempPath, 'w');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best effort cleanup only.
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best effort cleanup only.
    }
    throw error;
  }
}

/**
 * Read-only compatibility inspection. Never creates directories or writes files.
 */
async function checkLayer({ extDir, materials } = {}) {
  const files = {};
  const hashes = {};
  const issues = [];
  const fallbackVersion =
    isRecord(materials) && typeof materials.version === 'string' ? materials.version : '';

  let mats;
  try {
    mats = validateMaterials(materials);
  } catch (error) {
    return {
      status: 'incompatible',
      version: fallbackVersion,
      identityOk: false,
      files,
      hashes,
      issues: Array.isArray(error?.issues) && error.issues.length > 0 ? [...error.issues] : [errorText(error)],
    };
  }

  if (typeof extDir !== 'string' || extDir.trim() === '') {
    return {
      status: 'incompatible',
      version: mats.version,
      identityOk: false,
      files,
      hashes,
      issues: ['extDir must be a non-empty string.'],
    };
  }

  let identityOk = false;
  let actualVersion = '';

  let manifestBytes = null;
  try {
    manifestBytes = await fs.readFile(safeJoin(extDir, PACKAGE_FILE));
    hashes[PACKAGE_FILE] = sha256(manifestBytes);
  } catch (error) {
    files[PACKAGE_FILE] = 'missing';
    issues.push(`${PACKAGE_FILE} cannot be read: ${errorText(error)}`);
  }

  if (manifestBytes) {
    const hash = hashes[PACKAGE_FILE];
    const hashOk = hash === mats.packageSha;
    files[PACKAGE_FILE] = hashOk ? 'verified' : 'mismatch';
    if (!hashOk) {
      issues.push(`${PACKAGE_FILE} SHA256 ${hash} does not match pinned ${mats.packageSha}.`);
    }

    let manifest = null;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      issues.push(`${PACKAGE_FILE} is not valid JSON: ${errorText(error)}`);
      files[PACKAGE_FILE] = 'invalid';
    }

    if (manifest !== null) {
      if (!isRecord(manifest)) {
        issues.push(`${PACKAGE_FILE} must contain a JSON object.`);
        files[PACKAGE_FILE] = 'invalid';
      } else {
        const publisherOk = manifest.publisher === OFFICIAL_PUBLISHER;
        const nameOk = manifest.name === OFFICIAL_NAME;
        if (!publisherOk || !nameOk) issues.push('Installed extension is not openai.chatgpt.');
        const versionValue = manifest.version;
        if (typeof versionValue !== 'string' || versionValue.trim() === '') {
          issues.push(`${PACKAGE_FILE} has no valid version.`);
        } else {
          actualVersion = versionValue;
          if (versionValue !== mats.version) {
            issues.push(`Installed version ${versionValue} does not match material version ${mats.version}.`);
          }
        }
        identityOk =
          hashOk &&
          publisherOk &&
          nameOk &&
          typeof versionValue === 'string' &&
          versionValue.trim() !== '' &&
          versionValue === mats.version;
        if (!identityOk && files[PACKAGE_FILE] === 'verified') files[PACKAGE_FILE] = 'mismatch';
      }
    }
  }

  for (const rel of Object.keys(mats.guards)) {
    try {
      const bytes = await fs.readFile(safeJoin(extDir, rel));
      const hash = sha256(bytes);
      hashes[rel] = hash;
      if (hash !== mats.guards[rel]) {
        files[rel] = 'mismatch';
        issues.push(`${rel} SHA256 ${hash} does not match pinned ${mats.guards[rel]}.`);
      } else {
        files[rel] = 'verified';
      }
    } catch (error) {
      files[rel] = 'missing';
      issues.push(`${rel} cannot be read: ${errorText(error)}`);
    }
  }

  let baselineCount = 0;
  let patchedCount = 0;
  for (const rel of TARGET_FILES) {
    const target = mats.targets[rel];
    try {
      const bytes = await fs.readFile(safeJoin(extDir, rel));
      const hash = sha256(bytes);
      hashes[rel] = hash;
      if (hash === target.baselineSha) {
        files[rel] = 'baseline';
        baselineCount += 1;
      } else if (hash === target.patchedSha) {
        files[rel] = 'patched';
        patchedCount += 1;
      } else {
        files[rel] = 'unknown';
        issues.push(`Target ${rel} matches neither baseline nor patched material (found ${hash}).`);
      }
    } catch (error) {
      files[rel] = 'unknown';
      issues.push(`${rel} cannot be read: ${errorText(error)}`);
    }
  }

  let status = 'incompatible';
  if (issues.length === 0) {
    if (patchedCount === TARGET_FILES.length) status = 'patched';
    else if (baselineCount === TARGET_FILES.length) status = 'baseline';
    else status = 'mixed';
  }

  return {
    status,
    version: actualVersion || mats.version,
    identityOk,
    files,
    hashes,
    issues,
  };
}

async function readTargetsForMutation(extDir, mats, report) {
  const plans = [];
  for (const rel of TARGET_FILES) {
    const target = mats.targets[rel];
    const targetPath = safeJoin(extDir, rel);
    let prior;
    try {
      prior = await fs.readFile(targetPath);
    } catch (error) {
      throw new LayerError(`${rel} cannot be read: ${errorText(error)}`, 'io');
    }
    const hash = sha256(prior);
    let state;
    if (hash === target.baselineSha) state = 'baseline';
    else if (hash === target.patchedSha) state = 'patched';
    else throw new LayerError(`Target ${rel} changed since inspection (SHA256 ${hash}).`, 'stale-state');
    if (report.files[rel] !== state) {
      throw new LayerError(`Target ${rel} state changed since inspection.`, 'stale-state');
    }
    plans.push({ rel, targetPath, prior, state, target });
  }
  return plans;
}

async function rollbackTargets(appliedRels, plans) {
  const issues = [];
  const byRel = new Map(plans.map(plan => [plan.rel, plan]));
  for (const rel of [...appliedRels].reverse()) {
    const plan = byRel.get(rel);
    try {
      await atomicWriteFile(plan.targetPath, plan.prior);
    } catch (error) {
      issues.push(`${rel}: ${errorText(error)}`);
    }
  }
  return issues;
}

/**
 * Apply the guarded patch. Verifies package identity, pinned package hash and all
 * guard hashes before touching target files.
 */
async function applyLayer({ extDir, backupDir, materials, atomicWrite = atomicWriteFile } = {}) {
  const mats = validateMaterials(materials);
  assertDirectoryArgs(extDir, backupDir);

  const report = await checkLayer({ extDir, materials });
  if (report.status === 'incompatible') {
    throw new LayerError(`Cannot apply guarded patch: ${report.issues.join(' ')}`, 'incompatible');
  }

  const plans = await readTargetsForMutation(extDir, mats, report);
  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  const backupPathByRel = new Map(TARGET_FILES.map(rel => [rel, backupFilePath(backupDir, rel)]));
  const missingBackups = new Set();

  for (const plan of plans) {
    const backupPath = backupPathByRel.get(plan.rel);
    let existing;
    try {
      existing = await readOptional(backupPath);
    } catch (error) {
      throw new LayerError(`Existing backup for ${plan.rel} cannot be read: ${errorText(error)}`, 'io');
    }
    if (existing === null) {
      missingBackups.add(plan.rel);
    } else if (sha256(existing) !== plan.target.baselineSha) {
      throw new LayerError(
        `Existing backup for ${plan.rel} does not match the verified baseline; refusing to overwrite it.`,
        'backup-mismatch',
      );
    }
  }

  let existingManifest;
  try {
    existingManifest = await readOptional(manifestPath);
  } catch (error) {
    throw new LayerError(`Existing backup manifest cannot be read: ${errorText(error)}`, 'io');
  }
  if (existingManifest !== null) {
    const issue = validateManifest(existingManifest, mats);
    if (issue) {
      throw new LayerError(`Existing backup manifest is unusable: ${issue}`, 'backup-manifest-mismatch');
    }
  }

  const applied = [];
  const backupsCreated = [];
  let manifestWritten = false;
  try {
    for (const plan of plans) {
      if (!missingBackups.has(plan.rel)) continue;
      const backupPath = backupPathByRel.get(plan.rel);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      backupsCreated.push(plan.rel);
      const bytes = plan.state === 'patched' ? Buffer.from(plan.target.baseline) : plan.prior;
      await atomicWrite(backupPath, bytes);
    }

    for (const plan of plans) {
      if (plan.state !== 'baseline') continue;
      applied.push(plan.rel);
      await atomicWrite(plan.targetPath, Buffer.from(plan.target.patched));
    }

    if (existingManifest === null) {
      await fs.mkdir(backupDir, { recursive: true });
      manifestWritten = true;
      await atomicWrite(manifestPath, manifestBytesFor(mats));
    }

    const post = await checkLayer({ extDir, materials });
    if (post.status !== 'patched') {
      throw new LayerError(
        `Post-apply verification failed: ${post.issues.join(' ') || post.status}`,
        'verification',
      );
    }
    return {
      status: post.status,
      version: post.version,
      identityOk: post.identityOk,
      files: post.files,
      hashes: post.hashes,
      applied,
      backupsCreated,
      manifestWritten,
    };
  } catch (error) {
    const rollbackIssues = await rollbackTargets(applied, plans);
    for (const rel of backupsCreated) {
      try {
        await fs.unlink(backupPathByRel.get(rel));
      } catch {
        // Best effort cleanup only.
      }
    }
    if (manifestWritten) {
      try {
        await fs.unlink(manifestPath);
      } catch {
        // Best effort cleanup only.
      }
    }
    const failure = new LayerError(`Guarded patch apply failed: ${errorText(error)}`, 'apply-failed');
    failure.cause = error;
    if (rollbackIssues.length > 0) failure.rollbackIssues = rollbackIssues;
    throw failure;
  }
}

/**
 * Restore verified baseline bytes for patched targets. Backup files are the
 * source of truth; a target already at baseline is left untouched.
 */
async function restoreLayer({ extDir, backupDir, materials, atomicWrite = atomicWriteFile } = {}) {
  const mats = validateMaterials(materials);
  assertDirectoryArgs(extDir, backupDir);

  const report = await checkLayer({ extDir, materials });
  if (report.status === 'incompatible') {
    throw new LayerError(`Cannot restore guarded patch: ${report.issues.join(' ')}`, 'incompatible');
  }

  const plans = await readTargetsForMutation(extDir, mats, report);
  const backupPathByRel = new Map(TARGET_FILES.map(rel => [rel, backupFilePath(backupDir, rel)]));

  for (const plan of plans) {
    if (plan.state !== 'patched') continue;
    const backupPath = backupPathByRel.get(plan.rel);
    let existing;
    try {
      existing = await readOptional(backupPath);
    } catch (error) {
      throw new LayerError(`Backup for ${plan.rel} cannot be read: ${errorText(error)}`, 'io');
    }
    if (existing === null) {
      throw new LayerError(`Backup for ${plan.rel} is missing; refusing to restore.`, 'missing-backup');
    }
    if (sha256(existing) !== plan.target.baselineSha) {
      throw new LayerError(`Backup for ${plan.rel} does not match the verified baseline.`, 'backup-mismatch');
    }
  }

  const manifestPath = path.join(backupDir, MANIFEST_FILE);
  let existingManifest;
  try {
    existingManifest = await readOptional(manifestPath);
  } catch (error) {
    throw new LayerError(`Backup manifest cannot be read: ${errorText(error)}`, 'io');
  }
  if (existingManifest !== null) {
    const issue = validateManifest(existingManifest, mats);
    if (issue) throw new LayerError(`Backup manifest is unusable: ${issue}`, 'backup-manifest-mismatch');
  }

  const restored = [];
  try {
    for (const plan of plans) {
      if (plan.state !== 'patched') continue;
      restored.push(plan.rel);
      await atomicWrite(plan.targetPath, Buffer.from(plan.target.baseline));
    }

    const post = await checkLayer({ extDir, materials });
    if (post.status !== 'baseline') {
      throw new LayerError(
        `Post-restore verification failed: ${post.issues.join(' ') || post.status}`,
        'verification',
      );
    }
    return {
      status: post.status,
      version: post.version,
      identityOk: post.identityOk,
      files: post.files,
      hashes: post.hashes,
      restored,
    };
  } catch (error) {
    const rollbackIssues = await rollbackTargets(restored, plans);
    const failure = new LayerError(`Guarded patch restore failed: ${errorText(error)}`, 'restore-failed');
    failure.cause = error;
    if (rollbackIssues.length > 0) failure.rollbackIssues = rollbackIssues;
    throw failure;
  }
}

function createAttestation(materials) {
  const mats = validateMaterials(materials);
  const files = { [PACKAGE_FILE]: mats.packageSha };
  files[REQUIRED_GUARD] = mats.guards[REQUIRED_GUARD];
  for (const rel of TARGET_FILES) files[rel] = mats.targets[rel].patchedSha;
  return {
    schema: MANIFEST_SCHEMA,
    officialVersion: mats.version,
    features: [...mats.features],
    files,
  };
}

module.exports = {
  PACKAGE_FILE,
  REQUIRED_GUARD,
  TARGET_FILES,
  LayerError,
  sha256,
  atomicWriteFile,
  checkLayer,
  applyLayer,
  restoreLayer,
  createAttestation,
};
