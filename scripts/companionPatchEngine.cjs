'use strict';

/*
 * Guarded installer engine used by scripts/companionPatches.cjs.
 *
 * createEngine() with no argument keeps the accepted legacy behaviour for the
 * pinned official Codex build 26.1007.21434 (manifest schema 1/2).
 * createEngine(versionSpec) builds an independent engine for another pinned
 * official build (manifest schema 3).  The spec is a trusted, in-process
 * adapter: it pins SUPPORTED_VERSION, FILES, ORIGINAL_HASHES, STAGES, FEATURES
 * and an incremental transformStage(file, text, stage).  Callers can never
 * supply manifest metadata: schema 3 is validated against the spec.
 *
 * Every createEngine() call returns a fresh engine with private caches, so
 * version selection is concurrency-safe and there is no mutable global
 * "current version".  All guarded behaviour is retained for both engines:
 * directory/symlink checks, the install lock, stable-state checks before each
 * write, pinned manifest hashes, backup creation and rollback.
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const history = require('./patchOfficialHistory.cjs');
const titles = require('./patchOfficialTitles.cjs');
const { applyStatusTransforms } = require('./officialStatusTransform.cjs');
const { applyModelTransforms } = require('./officialModelTransform.cjs');

const PACKAGE_FILE = 'package.json';
const FIFTH_FILE = 'webview/assets/app-initial-7a199c66e670.js';
const FIFTH_ORIGINAL_HASH = '59b909377a370e09cb8523ab99a1f4ff282a0126527bd339db31e6d9ac7c9c26';
const LEGACY_FILES = Object.freeze([
  'package.json',
  'out/extension.js',
  'webview/assets/app-initial-97d3534ad35f.js',
  'webview/assets/app-initial-c014f9ee4429.js',
]);
const BASE_STAGES = Object.freeze(['original', 'history', 'titles', 'workflow']);
const DRAFT_STAGE = 'drafts';
const BACKUP_KIND = 'codex-companion-pristine-backup';
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SPEC_STAGES = Object.freeze(['original', 'history', 'titles', 'workflow', 'drafts']);
const SPEC_FILE_COUNT = 9;
const LEGACY_SUPPORTED_VERSION = titles.SUPPORTED_VERSION;

const LEGACY_PINNED_ORIGINAL_HASHES = Object.freeze({
  ...Object.fromEntries(
    Object.entries(titles.SUPPORTED_ORIGINAL_HASHES).map(([rel, hash]) => [rel, hash.toLowerCase()]),
  ),
  [FIFTH_FILE]: FIFTH_ORIGINAL_HASH,
});

let tempCounter = 0;

class PatchError extends Error {
  constructor(message, code = 'error', details = {}) {
    super(message);
    this.name = 'PatchError';
    this.code = code;
    Object.assign(this, details);
  }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function localAppDataDir() {
  return (
    process.env.LOCALAPPDATA ||
    (process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), '.local', 'share'))
  );
}

function normalizeVersionSpec(versionSpec) {
  if (versionSpec === undefined || versionSpec === null) return null;
  if (!isRecord(versionSpec)) {
    throw new PatchError('A version spec must be an object.', 'spec-invalid');
  }
  const issues = [];
  const version = versionSpec.SUPPORTED_VERSION;
  if (typeof version !== 'string' || !VERSION_RE.test(version)) {
    issues.push('SUPPORTED_VERSION must be a dotted version string without path separators.');
  }
  const files = versionSpec.FILES;
  if (!Array.isArray(files) || files.length !== SPEC_FILE_COUNT) {
    issues.push(`FILES must contain exactly ${SPEC_FILE_COUNT} relative paths.`);
  } else {
    const seen = new Set();
    for (const rel of files) {
      if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) {
        issues.push(`invalid file path: ${String(rel)}`);
        continue;
      }
      if (rel.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
        issues.push(`unsafe file path: ${rel}`);
      }
      if (seen.has(rel)) issues.push(`duplicate file path: ${rel}`);
      seen.add(rel);
    }
    if (!files.includes(PACKAGE_FILE)) issues.push(`FILES must contain ${PACKAGE_FILE}.`);
  }
  const stages = versionSpec.STAGES;
  if (
    !Array.isArray(stages) ||
    stages.length !== SPEC_STAGES.length ||
    !SPEC_STAGES.every((stage, index) => stages[index] === stage)
  ) {
    issues.push(`STAGES must be exactly ${SPEC_STAGES.join(', ')}.`);
  }
  const originalHashes = versionSpec.ORIGINAL_HASHES;
  if (!isRecord(originalHashes)) {
    issues.push('ORIGINAL_HASHES must be an object.');
  } else if (Array.isArray(files)) {
    if (!sameStringSet(Object.keys(originalHashes), files)) {
      issues.push('ORIGINAL_HASHES must cover exactly FILES.');
    }
    for (const rel of files) {
      const hash = originalHashes[rel];
      if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
        issues.push(`ORIGINAL_HASHES.${rel} must be a lowercase SHA256 hex string.`);
      }
    }
  }
  const features = versionSpec.FEATURES;
  if (!Array.isArray(features) || features.length === 0) {
    issues.push('FEATURES must be a non-empty array.');
  } else if (Array.isArray(files) && Array.isArray(stages)) {
    const ids = new Set();
    for (const feature of features) {
      if (!isRecord(feature)) {
        issues.push('each FEATURES entry must be an object.');
        continue;
      }
      if (typeof feature.id !== 'string' || feature.id === '') {
        issues.push('FEATURES id must be a non-empty string.');
      } else if (ids.has(feature.id)) {
        issues.push(`duplicate FEATURES id: ${feature.id}`);
      } else {
        ids.add(feature.id);
      }
      if (typeof feature.stage !== 'string' || !stages.includes(feature.stage)) {
        issues.push(`FEATURES ${String(feature.id)} has an unknown stage.`);
      }
      if (!Array.isArray(feature.files) || feature.files.length === 0) {
        issues.push(`FEATURES ${String(feature.id)} must list files.`);
      } else {
        for (const rel of feature.files) {
          if (!files.includes(rel)) {
            issues.push(`FEATURES ${String(feature.id)} references unsupported file ${String(rel)}.`);
          }
        }
      }
    }
  }
  if (typeof versionSpec.transformStage !== 'function') {
    issues.push('transformStage must be a function.');
  }
  if (issues.length > 0) {
    throw new PatchError(`Invalid version spec: ${issues.join(' ')}`, 'spec-invalid', { issues });
  }
  return deepFreeze({
    version,
    files: [...files],
    originalHashes: Object.fromEntries(Object.entries(originalHashes).map(([rel, hash]) => [rel, hash.toLowerCase()])),
    stages: [...stages],
    features: features.map(feature => ({ id: feature.id, stage: feature.stage, files: [...feature.files] })),
    transformStage: versionSpec.transformStage,
  });
}

function createEngine(versionSpec) {
  const spec = normalizeVersionSpec(versionSpec);
  const MANIFEST_PATH = path.join(
    __dirname,
    '..',
    'resources',
    spec ? `patchBundleManifest-${spec.version}.json` : 'patchBundleManifest.json',
  );
  const PINNED_ORIGINAL_HASHES = spec ? spec.originalHashes : LEGACY_PINNED_ORIGINAL_HASHES;
  let manifestCache = null;
  let draftTransform = null;

function filesForSchema(schema) {
  if (spec) return [...spec.files];
  return schema === 2 ? [...LEGACY_FILES, FIFTH_FILE] : [...LEGACY_FILES];
}

function stagesForSchema(schema) {
  if (spec) return [...spec.stages];
  return schema === 2 ? [...BASE_STAGES, DRAFT_STAGE] : [...BASE_STAGES];
}

function stagesFor(manifest) {
  return stagesForSchema(manifest.schema);
}

function targetFiles(manifest) {
  return manifest.files.filter(rel => rel !== PACKAGE_FILE);
}

function latestStage(manifest) {
  const stages = stagesFor(manifest);
  return stages[stages.length - 1];
}

function legacyOriginalHashes() {
  const hashes = {};
  for (const rel of LEGACY_FILES) hashes[rel] = LEGACY_PINNED_ORIGINAL_HASHES[rel];
  return hashes;
}

function validatePinnedManifest(parsed) {
  const issues = [];
  if (!isRecord(parsed)) {
    throw new PatchError('The versioned patch bundle manifest must contain an object.', 'manifest-invalid');
  }
  if (parsed.schema !== 3) issues.push('schema must be 3.');
  if (parsed.officialVersion !== spec.version) {
    issues.push(`officialVersion must be ${spec.version}.`);
  }
  if (parsed.publisher !== 'openai') issues.push('publisher must be openai.');
  if (parsed.name !== 'chatgpt') issues.push('name must be chatgpt.');

  if (!Array.isArray(parsed.files)) {
    issues.push(`files must contain exactly ${spec.files.length} entries.`);
  } else if (!sameStringSet(parsed.files, spec.files)) {
    issues.push(`files must be exactly ${spec.files.join(', ')}.`);
  }

  if (!isRecord(parsed.stages)) {
    issues.push('stages must be an object.');
  } else {
    if (!sameStringSet(Object.keys(parsed.stages), spec.stages)) {
      issues.push(`stages must contain exactly ${spec.stages.join(', ')}.`);
    }
    for (const stage of spec.stages) {
      const record = parsed.stages[stage];
      if (!isRecord(record)) {
        issues.push(`stages.${stage} must be an object.`);
        continue;
      }
      if (!sameStringSet(Object.keys(record), spec.files)) {
        issues.push(`stages.${stage} must contain exactly the pinned files.`);
      }
      for (const rel of spec.files) {
        const hash = record[rel];
        if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
          issues.push(`stages.${stage}.${rel} must be a lowercase SHA256 hex string.`);
        } else if (stage === 'original' && hash !== spec.originalHashes[rel]) {
          issues.push(`stages.original.${rel} does not match the accepted pinned original.`);
        }
      }
    }
  }

  if (!Array.isArray(parsed.features)) {
    issues.push('features must be an array.');
  } else {
    const expectedIds = spec.features.map(feature => feature.id);
    const actualIds = parsed.features.map(feature => (isRecord(feature) ? feature.id : undefined));
    if (!sameStringSet(actualIds, expectedIds)) {
      issues.push(`features must be exactly ${expectedIds.join(', ')}.`);
    }
    for (const expected of spec.features) {
      const feature = parsed.features.find(value => isRecord(value) && value.id === expected.id);
      if (!feature) continue;
      if (feature.stage !== expected.stage) {
        issues.push(`feature ${expected.id} must target the ${expected.stage} stage.`);
      }
      if (!Array.isArray(feature.files) || !sameStringSet(feature.files, expected.files)) {
        issues.push(`feature ${expected.id} must list exactly ${expected.files.join(', ')}.`);
      }
    }
  }

  if (issues.length > 0) {
    throw new PatchError(`Invalid patch bundle manifest: ${issues.join(' ')}`, 'manifest-invalid', { issues });
  }
}

function validateManifestShape(parsed) {
  if (spec) return validatePinnedManifest(parsed);
  const issues = [];
  if (!isRecord(parsed)) throw new PatchError('patchBundleManifest.json must contain an object.', 'manifest-invalid');
  const schemaKnown = parsed.schema === 1 || parsed.schema === 2;
  if (!schemaKnown) issues.push('schema must be 1 or 2.');
  const schema = schemaKnown ? parsed.schema : 1;
  if (typeof parsed.officialVersion !== 'string' || parsed.officialVersion.trim() === '') {
    issues.push('officialVersion must be a non-empty string.');
  }
  if (parsed.publisher !== 'openai') issues.push('publisher must be openai.');
  if (parsed.name !== 'chatgpt') issues.push('name must be chatgpt.');

  const expectedFiles = filesForSchema(schema);
  if (!Array.isArray(parsed.files)) {
    issues.push(`files must contain exactly ${expectedFiles.length} entries.`);
  } else {
    if (parsed.files.length !== expectedFiles.length) {
      issues.push(`files must contain exactly ${expectedFiles.length} entries.`);
    }
    const seen = new Set();
    for (const rel of parsed.files) {
      if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.includes('\0')) {
        issues.push(`invalid file path: ${String(rel)}`);
        continue;
      }
      if (rel.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
        issues.push(`unsafe file path: ${rel}`);
      }
      if (seen.has(rel)) issues.push(`duplicate file path: ${rel}`);
      seen.add(rel);
    }
    if (!sameStringSet(parsed.files, expectedFiles)) {
      issues.push(`files must be exactly ${expectedFiles.join(', ')}.`);
    }
  }

  const expectedStages = stagesForSchema(schema);
  if (!isRecord(parsed.stages)) {
    issues.push('stages must be an object.');
  } else {
    if (!sameStringSet(Object.keys(parsed.stages), expectedStages)) {
      issues.push(`stages must contain exactly ${expectedStages.join(', ')}.`);
    }
    for (const stage of expectedStages) {
      if (!isRecord(parsed.stages[stage])) {
        issues.push(`stages.${stage} must be an object.`);
        continue;
      }
      for (const rel of Array.isArray(parsed.files) ? parsed.files : []) {
        const hash = parsed.stages[stage][rel];
        if (typeof hash !== 'string' || !SHA256_RE.test(hash)) {
          issues.push(`stages.${stage}.${rel} must be a lowercase SHA256 hex string.`);
          continue;
        }
        if (stage === 'original' && PINNED_ORIGINAL_HASHES[rel] && hash !== PINNED_ORIGINAL_HASHES[rel]) {
          issues.push(`stages.original.${rel} does not match the accepted pinned original.`);
        }
      }
      for (const key of Object.keys(parsed.stages[stage])) {
        if (!Array.isArray(parsed.files) || !parsed.files.includes(key)) {
          issues.push(`stages.${stage} contains unsupported file ${key}.`);
        }
      }
    }
  }

  if (typeof parsed.officialVersion === 'string' && parsed.officialVersion !== titles.SUPPORTED_VERSION) {
    issues.push(`officialVersion must be ${titles.SUPPORTED_VERSION}.`);
  }

  if (schema === 2 && isRecord(parsed.stages)) {
    const stages = parsed.stages;
    const allStageRecords =
      isRecord(stages.original) &&
      isRecord(stages.history) &&
      isRecord(stages.titles) &&
      isRecord(stages.workflow) &&
      isRecord(stages.drafts);
    if (allStageRecords && typeof stages.original[FIFTH_FILE] === 'string') {
      for (const stage of BASE_STAGES) {
        if (typeof stages[stage][FIFTH_FILE] === 'string' && stages[stage][FIFTH_FILE] !== stages.original[FIFTH_FILE]) {
          issues.push(`stages.${stage}.${FIFTH_FILE} must stay identical to its original until drafts.`);
        }
      }
      for (const rel of ['out/extension.js', 'webview/assets/app-initial-97d3534ad35f.js']) {
        if (typeof stages.workflow[rel] === 'string' && stages.drafts[rel] !== stages.workflow[rel]) {
          issues.push(`stages.drafts.${rel} must be unchanged from workflow.`);
        }
      }
      const c014 = 'webview/assets/app-initial-c014f9ee4429.js';
      if (typeof stages.workflow[c014] === 'string' && stages.drafts[c014] === stages.workflow[c014]) {
        issues.push(`stages.drafts.${c014} must differ from workflow.`);
      }
      if (stages.drafts[FIFTH_FILE] === stages.original[FIFTH_FILE]) {
        issues.push(`stages.drafts.${FIFTH_FILE} must differ from its original.`);
      }
    }
  }

  if (!Array.isArray(parsed.features)) {
    issues.push('features must be an array.');
  } else {
    const featureIds = new Set();
    for (const feature of parsed.features) {
      if (!isRecord(feature)) {
        issues.push('each feature must be an object.');
        continue;
      }
      if (typeof feature.id !== 'string' || feature.id === '') issues.push('feature id must be a non-empty string.');
      else if (featureIds.has(feature.id)) issues.push(`duplicate feature id: ${feature.id}`);
      else featureIds.add(feature.id);
      if (!expectedStages.includes(feature.stage)) issues.push(`feature ${String(feature.id)} has an unknown stage.`);
      if (!Array.isArray(feature.files) || feature.files.length === 0) {
        issues.push(`feature ${String(feature.id)} must list files.`);
      } else {
        for (const rel of feature.files) {
          if (!Array.isArray(parsed.files) || !parsed.files.includes(rel)) {
            issues.push(`feature ${String(feature.id)} references unsupported file ${String(rel)}.`);
          }
        }
      }
    }
    if (schema === 2) {
      const draftsFeature = parsed.features.find(feature => isRecord(feature) && feature.id === 'independent-drafts');
      const c014 = 'webview/assets/app-initial-c014f9ee4429.js';
      if (!draftsFeature) {
        issues.push('independent-drafts feature is required for schema 2.');
      } else {
        if (draftsFeature.stage !== DRAFT_STAGE) issues.push('independent-drafts must target the drafts stage.');
        if (!Array.isArray(draftsFeature.files) || !sameStringSet(draftsFeature.files, [c014, FIFTH_FILE])) {
          issues.push(`independent-drafts must require ${c014} and ${FIFTH_FILE}.`);
        }
      }
    }
  }

  if (issues.length > 0) {
    throw new PatchError(`Invalid patch bundle manifest: ${issues.join(' ')}`, 'manifest-invalid', { issues });
  }
}

function getManifest() {
  if (manifestCache) return manifestCache;
  let parsed;
  try {
    parsed = JSON.parse(fsSync.readFileSync(MANIFEST_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new PatchError(`Cannot read patch bundle manifest: ${error.message}`, 'manifest-unreadable');
  }
  validateManifestShape(parsed);
  manifestCache = deepFreeze(parsed);
  return manifestCache;
}

function defaultBackupPath(manifest) {
  const base = path.join(localAppDataDir(), 'codex-companion', 'patches', manifest.officialVersion);
  if (spec) return path.join(base, 'chunks-v1');
  return manifest.schema === 2 ? path.join(base, 'drafts-v1') : base;
}

function defaultLegacyBackupPath(manifest) {
  return path.join(localAppDataDir(), 'codex-companion', 'patches', manifest.officialVersion);
}

function resolvePathForReport(value, fallback) {
  try {
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value);
  } catch {
    // Fall through to the fallback.
  }
  try {
    return path.resolve(fallback);
  } catch {
    return '';
  }
}

function normPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left, right) {
  return normPath(left) === normPath(right);
}

function sameNullablePath(left, right) {
  if (left == null || right == null) return left === right;
  return samePath(left, right);
}

function isWithin(parent, child) {
  const relative = path.relative(normPath(parent), normPath(child));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

function safeJoin(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || relativePath.includes('\\') || relativePath.includes('\0')) {
    throw new PatchError(`Unsafe relative path: ${String(relativePath)}`, 'unsafe-path');
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new PatchError(`Unsafe relative path: ${relativePath}`, 'unsafe-path');
  }
  const resolved = path.resolve(root, ...segments);
  if (!isWithin(root, resolved) || samePath(root, resolved)) {
    throw new PatchError(`Path escapes root: ${relativePath}`, 'unsafe-path');
  }
  return resolved;
}

function backupFilePath(backupReal, relativePath) {
  return safeJoin(backupReal, `files/${relativePath}`);
}

async function tryRead(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
}

async function containsAnyFile(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (await containsAnyFile(path.join(directory, entry.name))) return true;
    } else {
      return true;
    }
  }
  return false;
}

async function resolveExtDir(extDir) {
  if (typeof extDir !== 'string' || extDir.trim() === '') {
    throw new PatchError('extDir must be a non-empty directory path.', 'extension-path');
  }
  const absolute = path.resolve(extDir);
  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    throw new PatchError(`Extension directory cannot be resolved: ${error.message}`, 'extension-path');
  }
  let stat;
  try {
    stat = await fs.stat(real);
  } catch (error) {
    throw new PatchError(`Extension directory cannot be read: ${error.message}`, 'extension-path');
  }
  if (!stat.isDirectory()) throw new PatchError('Extension path is not a directory.', 'extension-path');
  return { absolute, real };
}

async function resolveBackupPath(backupDir, extReal) {
  const absolute = path.resolve(backupDir);
  let stat = null;
  let exists = true;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) exists = false;
    else throw new PatchError(`Backup path cannot be inspected: ${error.message}`, 'unsafe-path');
  }

  let real;
  if (exists) {
    if (stat.isSymbolicLink()) throw new PatchError('Backup directory must not be a symbolic link.', 'unsafe-path');
    try {
      real = await fs.realpath(absolute);
    } catch (error) {
      throw new PatchError(`Backup directory cannot be resolved: ${error.message}`, 'unsafe-path');
    }
    const realStat = await fs.stat(real);
    if (!realStat.isDirectory()) throw new PatchError('Backup path is not a directory.', 'unsafe-path');
  } else {
    let ancestor = absolute;
    for (;;) {
      let ancestorStat = null;
      try {
        ancestorStat = await fs.stat(ancestor);
      } catch (error) {
        if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
          const parent = path.dirname(ancestor);
          if (parent === ancestor) {
            throw new PatchError('Backup path has no existing ancestor.', 'unsafe-path');
          }
          ancestor = parent;
          continue;
        }
        throw new PatchError(`Backup ancestor cannot be inspected: ${error.message}`, 'unsafe-path');
      }
      if (!ancestorStat.isDirectory()) throw new PatchError('Backup ancestor is not a directory.', 'unsafe-path');
      break;
    }
    let ancestorReal;
    try {
      ancestorReal = await fs.realpath(ancestor);
    } catch (error) {
      throw new PatchError(`Backup ancestor cannot be resolved: ${error.message}`, 'unsafe-path');
    }
    real = path.join(ancestorReal, path.relative(ancestor, absolute));
  }

  if (pathsOverlap(real, extReal)) {
    throw new PatchError('Backup directory and extension directory must not overlap.', 'unsafe-path');
  }
  return { absolute, real, exists };
}

async function assertTargetSafe(rootReal, filePath) {
  const parent = path.dirname(filePath);
  let parentReal;
  try {
    parentReal = await fs.realpath(parent);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw new PatchError(`Target directory cannot be resolved: ${error.message}`, 'unsafe-path');
  }
  if (!isWithin(rootReal, parentReal)) {
    throw new PatchError(`Target escapes the extension directory: ${filePath}`, 'unsafe-path');
  }
  let stat = null;
  try {
    stat = await fs.lstat(filePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
    throw new PatchError(`Target cannot be inspected: ${error.message}`, 'unsafe-path');
  }
  if (stat.isSymbolicLink()) throw new PatchError(`Target must not be a symbolic link: ${filePath}`, 'unsafe-path');
  if (!stat.isFile()) throw new PatchError(`Target is not a regular file: ${filePath}`, 'unsafe-path');
}

async function ensureDirectorySafe(directory) {
  const absolute = path.resolve(directory);
  const parent = path.dirname(absolute);
  if (parent !== absolute) {
    let parentStat = null;
    try {
      parentStat = await fs.lstat(parent);
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
        await ensureDirectorySafe(parent);
      } else {
        throw new PatchError(`Directory cannot be inspected: ${error.message}`, 'unsafe-path');
      }
    }
    if (parentStat) {
      if (parentStat.isSymbolicLink()) {
        throw new PatchError(`Directory path contains a symbolic link: ${parent}`, 'unsafe-path');
      }
      if (!parentStat.isDirectory()) {
        throw new PatchError(`Directory path is not a directory: ${parent}`, 'unsafe-path');
      }
    }
  }

  let stat = null;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) stat = null;
    else throw new PatchError(`Directory cannot be inspected: ${error.message}`, 'unsafe-path');
  }
  if (stat) {
    if (stat.isSymbolicLink()) throw new PatchError(`Directory must not be a symbolic link: ${absolute}`, 'unsafe-path');
    if (!stat.isDirectory()) throw new PatchError(`Path is not a directory: ${absolute}`, 'unsafe-path');
    return;
  }
  try {
    await fs.mkdir(absolute);
  } catch (error) {
    if (!error || error.code !== 'EEXIST') {
      throw new PatchError(`Cannot create directory ${absolute}: ${error.message}`, 'unsafe-path');
    }
  }
}

async function atomicWrite(filePath, data) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`,
  );
  let handle = null;
  try {
    handle = await fs.open(tempPath, 'wx');
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
        // Best-effort cleanup.
      }
    }
    try {
      await fs.unlink(tempPath);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}

function featureStatus(manifest, feature, fileStates) {
  const stages = stagesFor(manifest);
  const rank = Object.fromEntries(stages.map((stage, index) => [stage, index]));
  const minimum = rank[feature.stage];
  let above = 0;
  let below = 0;
  for (const rel of feature.files) {
    const state = fileStates.get(rel);
    if (!(state in rank)) return 'unverified';
    if (rank[state] >= minimum) above += 1;
    else below += 1;
  }
  if (above === feature.files.length) return 'installed';
  if (above === 0) return 'missing';
  return 'partial';
}

function firstStageForHash(manifest, rel, hash) {
  for (const stage of stagesFor(manifest)) {
    if (manifest.stages[stage][rel] === hash) return stage;
  }
  return null;
}

function emptyReport(manifest, backupPath) {
  return {
    schema: 1,
    version: null,
    supportedVersion: manifest.officialVersion,
    state: 'incompatible',
    code: 'extension-path',
    files: [],
    features: manifest.features.map(feature => ({ id: feature.id, status: 'unverified' })),
    backup: { path: backupPath, status: 'missing', issues: [] },
    canInstall: false,
    canRestore: false,
    issues: [],
  };
}

async function inspectBackup(manifest, extReal, backupReal, backupExists, scope) {
  if (!backupExists) return { status: 'missing', issues: [] };
  const files = scope ? scope.files : manifest.files;
  const hashes = scope ? scope.hashes : manifest.stages.original;
  const issues = [];
  const manifestPath = path.join(backupReal, 'manifest.json');
  let manifestStat = null;
  try {
    manifestStat = await fs.lstat(manifestPath);
  } catch (error) {
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
      return { status: 'invalid', issues: [`backup manifest cannot be inspected: ${error.message}`] };
    }
  }
  if (manifestStat && manifestStat.isSymbolicLink()) {
    return { status: 'invalid', issues: ['backup manifest must not be a symbolic link'] };
  }
  if (!manifestStat) {
    let hasFiles = false;
    try {
      hasFiles = await containsAnyFile(backupReal);
    } catch (error) {
      return { status: 'invalid', issues: [`backup directory cannot be read: ${error.message}`] };
    }
    if (!hasFiles) return { status: 'missing', issues: [] };
    return { status: 'invalid', issues: ['backup manifest is missing'] };
  }

  let parsed;
  try {
    parsed = JSON.parse((await fs.readFile(manifestPath)).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return { status: 'invalid', issues: [`backup manifest is not valid JSON: ${error.message}`] };
  }
  if (!isRecord(parsed)) return { status: 'invalid', issues: ['backup manifest must contain an object'] };
  if (parsed.schema !== 1) issues.push('backup manifest schema must be 1');
  if (parsed.kind !== BACKUP_KIND) issues.push(`backup manifest kind must be ${BACKUP_KIND}`);
  if (parsed.officialVersion !== manifest.officialVersion) {
    issues.push(`backup version ${String(parsed.officialVersion)} does not match ${manifest.officialVersion}`);
  }
  if (parsed.publisher !== manifest.publisher) issues.push(`backup publisher ${String(parsed.publisher)} is not ${manifest.publisher}`);
  if (parsed.name !== manifest.name) issues.push(`backup name ${String(parsed.name)} is not ${manifest.name}`);
  if (
    typeof parsed.extensionPath !== 'string' ||
    !path.isAbsolute(parsed.extensionPath) ||
    !samePath(parsed.extensionPath, extReal)
  ) {
    issues.push('backup is bound to a different extension directory');
  }
  if (!isRecord(parsed.files)) {
    issues.push('backup manifest files must be an object');
  } else {
    if (!sameStringSet(Object.keys(parsed.files), files)) {
      issues.push('backup manifest files do not match the pinned file set');
    }
    for (const rel of files) {
      const value = parsed.files[rel];
      if (typeof value !== 'string' || value !== hashes[rel]) {
        issues.push(`backup manifest hash for ${rel} does not match the pinned original`);
      }
    }
  }

  if (issues.length === 0) {
    for (const rel of files) {
      const filePath = backupFilePath(backupReal, rel);
      let parentReal;
      try {
        parentReal = await fs.realpath(path.dirname(filePath));
      } catch (error) {
        issues.push(`backup file ${rel} is missing: ${error.message}`);
        continue;
      }
      if (!isWithin(backupReal, parentReal)) {
        issues.push(`backup file ${rel} escapes the backup directory`);
        continue;
      }
      let stat = null;
      try {
        stat = await fs.lstat(filePath);
      } catch (error) {
        issues.push(`backup file ${rel} cannot be inspected: ${error.message}`);
        continue;
      }
      if (stat.isSymbolicLink()) {
        issues.push(`backup file ${rel} must not be a symbolic link`);
        continue;
      }
      if (!stat.isFile()) {
        issues.push(`backup file ${rel} is not a regular file`);
        continue;
      }
      let bytes;
      try {
        bytes = await fs.readFile(filePath);
      } catch (error) {
        issues.push(`backup file ${rel} cannot be read: ${error.message}`);
        continue;
      }
      if (sha256(bytes) !== hashes[rel]) {
        issues.push(`backup file ${rel} does not match the pinned original`);
      }
    }
  }

  return issues.length === 0 ? { status: 'valid', issues: [] } : { status: 'invalid', issues };
}

async function inspectLegacyBackup(manifest, extReal, legacyDir) {
  if (typeof legacyDir !== 'string' || legacyDir.trim() === '') {
    return { status: 'invalid', path: null, real: null, issues: ['legacy backup path must be a non-empty string'] };
  }
  const absolute = path.resolve(legacyDir);
  let resolved;
  try {
    resolved = await resolveBackupPath(absolute, extReal);
  } catch (error) {
    return { status: 'invalid', path: absolute, real: null, issues: [error.message] };
  }
  if (!resolved.exists) return { status: 'missing', path: absolute, real: null, issues: [] };
  const result = await inspectBackup(manifest, extReal, resolved.real, true, {
    files: LEGACY_FILES,
    hashes: legacyOriginalHashes(),
  });
  if (result.status === 'valid') return { status: 'valid', path: absolute, real: resolved.real, issues: [] };
  const bindingMismatch = result.issues.some(issue => issue.includes('bound to a different extension directory'));
  return {
    status: bindingMismatch ? 'unusable' : 'invalid',
    path: absolute,
    real: resolved.real,
    issues: result.issues,
  };
}

async function inspectOriginalDir(manifest, originalDir) {
  if (typeof originalDir !== 'string' || originalDir.trim() === '') {
    throw new PatchError('originalDir must be a non-empty directory path.', 'original-dir');
  }
  const absolute = path.resolve(originalDir);
  let real;
  try {
    real = await fs.realpath(absolute);
  } catch (error) {
    throw new PatchError(`originalDir cannot be resolved: ${error.message}`, 'original-dir');
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new PatchError('originalDir is not a directory.', 'original-dir');

  const buffers = new Map();
  for (const rel of manifest.files) {
    const filePath = safeJoin(real, rel);
    const fileStat = await fs.lstat(filePath);
    if (fileStat.isSymbolicLink()) throw new PatchError(`originalDir file must not be a symbolic link: ${rel}`, 'original-dir');
    if (!fileStat.isFile()) throw new PatchError(`originalDir entry is not a regular file: ${rel}`, 'original-dir');
    const bytes = await fs.readFile(filePath);
    if (sha256(bytes) !== manifest.stages.original[rel]) {
      throw new PatchError(`originalDir file has unknown bytes: ${rel}`, 'original-dir');
    }
    buffers.set(rel, bytes);
  }
  return { ok: true, real, buffers };
}

async function inspectInternal(options = {}) {
  if (!options || typeof options !== 'object') options = {};
  const manifest = getManifest();
  const backupPath = resolvePathForReport(options.backupDir, defaultBackupPath(manifest));
  const report = emptyReport(manifest, backupPath);
  const issues = [];
  const seenIssues = new Set();
  const pushIssue = message => {
    if (!seenIssues.has(message)) {
      seenIssues.add(message);
      issues.push(message);
    }
  };

  let ext = null;
  try {
    ext = await resolveExtDir(options.extDir);
  } catch (error) {
    pushIssue(error.message);
    report.files = manifest.files.map(rel => ({ path: rel, state: 'missing', hash: null }));
    report.issues = issues;
    return {
      report,
      ctx: {
        extReal: null,
        backupReal: null,
        backupExists: false,
        fileBytes: new Map(),
        fileMap: new Map(),
        legacy: null,
        originals: null,
      },
    };
  }

  let backup = { absolute: backupPath, real: null, exists: false };
  let pathError = null;
  if (
    options.backupDir !== undefined &&
    (typeof options.backupDir !== 'string' || options.backupDir.trim() === '')
  ) {
    pathError = new PatchError('backupDir must be a non-empty string.', 'invalid-arguments');
  } else {
    try {
      backup = await resolveBackupPath(
        options.backupDir === undefined ? defaultBackupPath(manifest) : options.backupDir,
        ext.real,
      );
    } catch (error) {
      pathError = error;
    }
  }
  report.backup.path = backup.absolute;

  const fileMap = new Map();
  const fileBytes = new Map();
  let version = null;
  let packageOk = false;
  let code = 'original';
  let targetPathError = null;

  const packagePath = safeJoin(ext.real, PACKAGE_FILE);
  let packageBytes = null;
  try {
    await assertTargetSafe(ext.real, packagePath);
    packageBytes = await tryRead(packagePath);
  } catch (error) {
    targetPathError = error;
  }
  if (targetPathError) {
    fileMap.set(PACKAGE_FILE, { state: 'unreadable', hash: null });
  } else if (packageBytes === null) {
    fileMap.set(PACKAGE_FILE, { state: 'missing', hash: null });
    pushIssue('package.json is missing');
    code = 'missing-package';
  } else {
    fileBytes.set(PACKAGE_FILE, packageBytes);
    const hash = sha256(packageBytes);
    let parsed = null;
    try {
      parsed = JSON.parse(packageBytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      parsed = null;
    }
    if (!isRecord(parsed)) {
      fileMap.set(PACKAGE_FILE, { state: 'foreign', hash });
      pushIssue('package.json is not a valid JSON object');
      code = 'invalid-package';
    } else {
      version = typeof parsed.version === 'string' ? parsed.version : null;
      const identityOk =
        parsed.publisher === manifest.publisher &&
        parsed.name === manifest.name &&
        parsed.version === manifest.officialVersion;
      const hashOk = hash === manifest.stages.original[PACKAGE_FILE];
      fileMap.set(PACKAGE_FILE, {
        state: firstStageForHash(manifest, PACKAGE_FILE, hash) || 'foreign',
        hash,
      });
      packageOk = identityOk && hashOk;
      if (!identityOk) {
        pushIssue(
          `package identity ${String(parsed.publisher)}.${String(parsed.name)}@${String(parsed.version)} is not ` +
            `${manifest.publisher}.${manifest.name}@${manifest.officialVersion}`,
        );
        code = 'unknown-version';
      } else if (!hashOk) {
        pushIssue('package.json bytes do not match the pinned original');
        code = 'unknown-version';
      }
    }
  }

  const manifestTargets = targetFiles(manifest);
  for (const rel of manifestTargets) {
    const filePath = safeJoin(ext.real, rel);
    let bytes = null;
    let readError = null;
    try {
      await assertTargetSafe(ext.real, filePath);
      bytes = await tryRead(filePath);
    } catch (error) {
      readError = error;
      targetPathError = error;
    }
    if (readError) {
      fileMap.set(rel, { state: 'unreadable', hash: null });
      pushIssue(`${rel} cannot be read: ${readError.message}`);
      continue;
    }
    if (bytes === null) {
      fileMap.set(rel, { state: 'missing', hash: null });
      pushIssue(`${rel} is missing`);
      continue;
    }
    fileBytes.set(rel, bytes);
    const hash = sha256(bytes);
    fileMap.set(rel, { state: firstStageForHash(manifest, rel, hash) || 'foreign', hash });
  }

  if (pathError) {
    pushIssue(pathError.message);
    code = 'unsafe-path';
  } else if (targetPathError) {
    pushIssue(targetPathError.message);
    code = 'unsafe-path';
  } else if (packageOk) {
    const targetStates = manifestTargets.map(rel => fileMap.get(rel).state);
    if (targetStates.some(state => state === 'missing' || state === 'unreadable')) {
      code = 'missing-file';
    } else if (targetStates.some(state => state === 'foreign')) {
      code = 'unknown-stage';
    } else {
      const manifestStages = stagesFor(manifest);
      const match = manifestStages.find(stage =>
        manifest.files.every(rel => fileMap.get(rel).hash === manifest.stages[stage][rel]),
      );
      if (match) code = match;
      else code = 'mixed';
    }
  }

  let state = 'incompatible';
  const manifestStages = stagesFor(manifest);
  if (pathError || targetPathError) state = 'incompatible';
  else if (!packageOk) state = 'incompatible';
  else if (manifestStages.includes(code)) state = code;
  else if (code === 'mixed') state = 'mixed';

  if (pathError) {
    report.backup.status = 'invalid';
    report.backup.issues = [pathError.message];
  } else if (backup.exists) {
    const backupResult = await inspectBackup(manifest, ext.real, backup.real, backup.exists);
    report.backup.status = backupResult.status;
    report.backup.issues = backupResult.issues;
    if (backupResult.status === 'invalid') {
      for (const issue of backupResult.issues) pushIssue(`backup: ${issue}`);
    }
  }

  let originals = null;
  if (options.originalDir !== undefined) {
    try {
      originals = await inspectOriginalDir(manifest, options.originalDir);
    } catch (error) {
      pushIssue(`original-dir: ${error.message}`);
    }
  }

  let legacy = null;
  const patchedStates = manifestStages.filter(stage => stage !== 'original');
  const needsLegacy =
    !spec &&
    manifest.schema === 2 &&
    report.backup.status !== 'valid' &&
    state !== 'original' &&
    patchedStates.includes(state) &&
    options.originalDir === undefined;
  if (needsLegacy && !pathError) {
    const legacyPath =
      options.legacyBackupDir === undefined ? defaultLegacyBackupPath(manifest) : options.legacyBackupDir;
    legacy = await inspectLegacyBackup(manifest, ext.real, legacyPath);
    if (legacy.status === 'invalid' || legacy.status === 'unusable') {
      pushIssue(`legacy backup fallback is ${legacy.status}: ${legacy.issues.join(' ')}`);
    }
  }

  const fileStates = new Map();
  for (const [rel, value] of fileMap.entries()) fileStates.set(rel, value.state);
  const effectiveLegacy = legacy || { status: 'missing' };
  const legacyHasCurrentFifth = (() => {
    const entry = fileMap.get(FIFTH_FILE);
    return Boolean(entry && entry.hash === manifest.stages.original[FIFTH_FILE]);
  })();
  const legacyUsable = manifest.schema === 2 && effectiveLegacy.status === 'valid' && legacyHasCurrentFifth;
  const features = manifest.features.map(feature => ({
    id: feature.id,
    status: packageOk ? featureStatus(manifest, feature, fileStates) : 'unverified',
  }));

  let canInstall = false;
  let canRestore = false;
  if (!pathError && !targetPathError && report.backup.status !== 'invalid') {
    if (state === 'original') canInstall = true;
    else if (patchedStates.includes(state)) {
      canInstall = report.backup.status === 'valid' || Boolean(originals && originals.ok) || legacyUsable;
    }
    if (options.originalDir !== undefined && !originals?.ok) canInstall = false;
  }
  if (!pathError && !targetPathError) {
    if (state === 'original') canRestore = true;
    else if (patchedStates.includes(state)) {
      canRestore = report.backup.status === 'valid';
    }
  }
  if (
    patchedStates.includes(state) &&
    !canInstall &&
    report.backup.status === 'missing' &&
    !(originals && originals.ok) &&
    !legacyUsable
  ) {
    pushIssue('a valid backup, an explicit verified --original-dir, or a verified legacy backup is required to adopt an already patched installation');
  }

  report.version = version;
  report.state = state;
  report.code = code;
  report.files = manifest.files.map(rel => {
    const value = fileMap.get(rel);
    return value
      ? { path: rel, state: value.state, hash: value.hash }
      : { path: rel, state: 'missing', hash: null };
  });
  report.features = features;
  report.canInstall = canInstall;
  report.canRestore = canRestore;
  report.issues = issues;

  return {
    report,
    ctx: {
      report,
      extAbsolute: ext.absolute,
      extReal: ext.real,
      backupAbsolute: backup.absolute,
      backupReal: backup.real,
      backupExists: backup.exists,
      fileMap,
      fileBytes,
      originals,
      legacy,
      pathError,
    },
  };
}

function refusal(report, action, detail) {
  const reason = report.issues.length > 0 ? report.issues[0] : report.code;
  return new PatchError(
    `Cannot ${action} Codex Companion patches (${report.state}/${report.code}): ${detail || reason}`,
    report.code,
    { report },
  );
}

function hashesForTargets(manifest, report) {
  const hashes = {};
  for (const rel of targetFiles(manifest)) {
    const entry = report.files.find(file => file.path === rel);
    hashes[rel] = entry ? entry.hash : null;
  }
  return hashes;
}

function assertSameInspection(before, after) {
  const manifest = getManifest();
  if (!samePath(before.ctx.extReal, after.ctx.extReal) || !sameNullablePath(before.ctx.backupReal, after.ctx.backupReal)) {
    throw new PatchError('Extension or backup path changed before lock acquisition.', 'stale-state');
  }
  if (before.report.state !== after.report.state) {
    throw new PatchError(
      `Extension state changed from ${before.report.state} to ${after.report.state} before install lock acquisition.`,
      'stale-state',
    );
  }
  if (before.report.backup.status !== after.report.backup.status) {
    throw new PatchError('Backup state changed before install lock acquisition.', 'stale-state');
  }
  if ((before.ctx.legacy?.status ?? null) !== (after.ctx.legacy?.status ?? null)) {
    throw new PatchError('Legacy backup state changed before install lock acquisition.', 'stale-state');
  }
  if (!sameNullablePath(before.ctx.legacy?.real ?? null, after.ctx.legacy?.real ?? null)) {
    throw new PatchError('Legacy backup path changed before install lock acquisition.', 'stale-state');
  }
  if (Boolean(before.ctx.originals?.ok) !== Boolean(after.ctx.originals?.ok)) {
    throw new PatchError('Explicit original source changed before install lock acquisition.', 'stale-state');
  }
  if (!sameNullablePath(before.ctx.originals?.real ?? null, after.ctx.originals?.real ?? null)) {
    throw new PatchError('Explicit original source path changed before install lock acquisition.', 'stale-state');
  }
  for (const rel of manifest.files) {
    const left = before.report.files.find(file => file.path === rel);
    const right = after.report.files.find(file => file.path === rel);
    if (!left || !right || left.hash !== right.hash) {
      throw new PatchError(`${rel} changed while waiting for the install lock.`, 'stale-state');
    }
  }
}

async function acquireLockFile(ctx, lockPath) {
  try {
    await ensureDirectorySafe(path.dirname(lockPath));
  } catch (error) {
    throw new PatchError(`Cannot prepare the install lock directory: ${error.message}`, 'locked');
  }
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new PatchError(
        `Another installer appears to be running (lock file ${lockPath}). ` +
          'If no installer is running, verify that fact and delete the lock file manually. ' +
          'The lock is never removed automatically.',
        'locked',
      );
    }
    throw new PatchError(`Cannot create the install lock: ${error.message}`, 'locked');
  }
  const token = `${JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    extensionPath: ctx.extReal,
    backupPath: ctx.backupAbsolute,
  })}\n`;
  try {
    await handle.writeFile(token);
    await handle.sync();
    await handle.close();
    handle = null;
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup.
      }
    }
    try {
      await fs.unlink(lockPath);
    } catch {
      // Best-effort cleanup.
    }
    throw new PatchError(`Cannot write the install lock: ${error.message}`, 'locked');
  }
  return {
    path: lockPath,
    async release() {
      try {
        const current = await fs.readFile(lockPath, 'utf8');
        if (current === token) await fs.unlink(lockPath);
      } catch {
        // The lock is already gone or no longer belongs to this process.
      }
    },
  };
}

async function acquireLock(ctx) {
  // The target lock also serializes callers using different backup locations.
  const target = await acquireLockFile(ctx, path.join(ctx.extReal, '.companion-patches.install.lock'));
  try {
    const backup = await acquireLockFile(ctx, `${path.resolve(ctx.backupReal || ctx.backupAbsolute)}.install.lock`);
    return { async release() { await backup.release(); await target.release(); } };
  } catch (error) {
    await target.release();
    throw error;
  }
}

async function createBackup(ctx, originals) {
  const manifest = getManifest();
  const resolved = await resolveBackupPath(ctx.backupAbsolute, ctx.extReal);
  if (resolved.exists) {
    const current = await inspectBackup(manifest, ctx.extReal, resolved.real, true);
    if (current.status === 'valid') return;
    if (current.status === 'invalid') {
      throw new PatchError(
        `Existing backup is unusable: ${current.issues.join(' ')}`,
        'backup-invalid',
      );
    }
  }
  await ensureDirectorySafe(resolved.real);
  await ensureDirectorySafe(path.join(resolved.real, 'files'));

  const created = [];
  let manifestPath = null;
  let manifestCreated = false;
  try {
    for (const rel of manifest.files) {
      const bytes = originals.get(rel);
      if (!Buffer.isBuffer(bytes) || sha256(bytes) !== manifest.stages.original[rel]) {
        throw new PatchError(`No verified pristine bytes for ${rel}.`, 'backup-source');
      }
      const filePath = backupFilePath(resolved.real, rel);
      await ensureDirectorySafe(path.dirname(filePath));
      let parentReal;
      try {
        parentReal = await fs.realpath(path.dirname(filePath));
      } catch (error) {
        throw new PatchError(`Backup directory cannot be resolved: ${error.message}`, 'unsafe-path');
      }
      if (!isWithin(resolved.real, parentReal)) {
        throw new PatchError(`Backup file ${rel} escapes the backup directory.`, 'unsafe-path');
      }
      let existing = null;
      try {
        existing = await fs.lstat(filePath);
      } catch (error) {
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
          throw new PatchError(`Backup target cannot be inspected: ${error.message}`, 'unsafe-path');
        }
      }
      if (existing) {
        throw new PatchError(`Backup file already exists: ${rel}`, 'backup-conflict');
      }
      await atomicWrite(filePath, bytes);
      created.push(filePath);
    }

    manifestPath = path.join(resolved.real, 'manifest.json');
    let existingManifest = null;
    try {
      existingManifest = await fs.lstat(manifestPath);
    } catch (error) {
      if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) {
        throw new PatchError(`Backup manifest target cannot be inspected: ${error.message}`, 'unsafe-path');
      }
    }
    if (existingManifest) throw new PatchError('Backup manifest already exists.', 'backup-conflict');

    const files = {};
    for (const rel of manifest.files) files[rel] = manifest.stages.original[rel];
    const backupManifest = {
      schema: 1,
      kind: BACKUP_KIND,
      officialVersion: manifest.officialVersion,
      publisher: manifest.publisher,
      name: manifest.name,
      extensionPath: ctx.extReal,
      files,
    };
    await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(backupManifest, null, 2)}\n`, 'utf8'));
    manifestCreated = true;

    const validation = await inspectBackup(manifest, ctx.extReal, resolved.real, true);
    if (validation.status !== 'valid') {
      throw new PatchError(`New backup failed validation: ${validation.issues.join(' ')}`, 'backup-invalid');
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const filePath of created.reverse()) {
      try {
        await fs.unlink(filePath);
      } catch (cleanupError) {
        cleanupErrors.push(`${filePath}: ${cleanupError.message}`);
      }
    }
    if (manifestCreated) {
      try {
        await fs.unlink(manifestPath);
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== 'ENOENT') cleanupErrors.push(`${manifestPath}: ${cleanupError.message}`);
      }
    }
    if (error && typeof error === 'object') {
      if (cleanupErrors.length > 0) {
        error.rollbackErrors = [...(error.rollbackErrors || []), ...cleanupErrors];
        error.message += `; backup cleanup errors: ${cleanupErrors.join('; ')}`;
      }
    }
    throw error;
  }
}

function getDraftTransform() {
  if (draftTransform) return draftTransform;
  let moduleValue;
  try {
    moduleValue = require('./officialDraftTransform.cjs');
  } catch (error) {
    throw new PatchError(`Draft transform module is unavailable: ${error.message}`, 'generation-source');
  }
  if (!moduleValue || typeof moduleValue.applyDraftTransforms !== 'function') {
    throw new PatchError('Draft transform module does not export applyDraftTransforms.', 'generation-source');
  }
  draftTransform = moduleValue.applyDraftTransforms;
  return draftTransform;
}

function generateFinalTargets(manifest, originals) {
  if (spec) return generateSpecTargets(manifest, originals);
  const latest = latestStage(manifest);
  const draft = manifest.schema === 2 ? getDraftTransform() : null;
  const targets = targetFiles(manifest);
  const result = new Map();
  for (const rel of targets) {
    const original = originals.get(rel);
    if (!Buffer.isBuffer(original) || sha256(original) !== manifest.stages.original[rel]) {
      throw new PatchError(`Verified pristine bytes for ${rel} are unavailable.`, 'generation-source');
    }
    let text = original.toString('utf8');
    if (history.PATCHED_FILES.includes(rel)) {
      text = history.generatePatchedText(rel, text);
    }
    if (titles.PATCHED_FILES.includes(rel)) {
      text = titles.generatePatchedText(rel, text);
      text = applyStatusTransforms(rel, text);
      text = applyModelTransforms(rel, text);
    }
    if (draft) {
      const patched = draft(rel, text);
      if (typeof patched !== 'string') {
        throw new PatchError(`Draft transform did not return text for ${rel}.`, 'generation-mismatch');
      }
      text = patched;
    }
    const bytes = Buffer.from(text, 'utf8');
    if (sha256(bytes) !== manifest.stages[latest][rel]) {
      throw new PatchError(
        `Generated final bytes for ${rel} do not match the release metadata; refusing to write.`,
        'generation-mismatch',
      );
    }
    result.set(rel, bytes);
  }
  if (result.size !== targets.length) {
    throw new PatchError('Generated final target set is incomplete.', 'generation-mismatch');
  }
  return result;
}

function generateSpecTargets(manifest, originals) {
  const stages = stagesFor(manifest);
  const targets = targetFiles(manifest);
  const result = new Map();
  for (const rel of targets) {
    const original = originals.get(rel);
    if (!Buffer.isBuffer(original) || sha256(original) !== spec.originalHashes[rel]) {
      throw new PatchError(`Verified pristine bytes for ${rel} are unavailable.`, 'generation-source');
    }
    let text = original.toString('utf8');
    for (const stage of stages.slice(1)) {
      let patched;
      try {
        patched = spec.transformStage(rel, text, stage);
      } catch (error) {
        throw new PatchError(
          `Transform ${stage} failed for ${rel}: ${error && error.message ? error.message : String(error)}`,
          'generation-mismatch',
        );
      }
      if (typeof patched !== 'string') {
        throw new PatchError(`Transform ${stage} did not return text for ${rel}.`, 'generation-mismatch');
      }
      text = patched;
      if (sha256(Buffer.from(text, 'utf8')) !== manifest.stages[stage][rel]) {
        throw new PatchError(
          `Generated ${stage} bytes for ${rel} do not match the release metadata; refusing to write.`,
          'generation-mismatch',
        );
      }
    }
    result.set(rel, Buffer.from(text, 'utf8'));
  }
  if (result.size !== targets.length) {
    throw new PatchError('Generated final target set is incomplete.', 'generation-mismatch');
  }
  return result;
}

async function readOriginalsFromBackup(manifest, backupReal) {
  const originals = new Map();
  for (const rel of manifest.files) {
    const bytes = await fs.readFile(backupFilePath(backupReal, rel));
    if (sha256(bytes) !== manifest.stages.original[rel]) {
      throw new PatchError(`Backup bytes for ${rel} no longer match the pinned original.`, 'backup-invalid');
    }
    originals.set(rel, bytes);
  }
  return originals;
}

async function resolveOriginalSource(manifest, ctx, options) {
  if (ctx.report.backup.status === 'valid') {
    return readOriginalsFromBackup(manifest, ctx.backupReal);
  }
  if (options.originalDir !== undefined) {
    if (!ctx.originals || !ctx.originals.ok) {
      throw new PatchError('The explicit originalDir is not a verified pristine source.', 'original-dir');
    }
    return new Map(ctx.originals.buffers);
  }
  if (ctx.report.state === 'original') {
    const originals = new Map();
    for (const rel of manifest.files) {
      const bytes = ctx.fileBytes.get(rel);
      if (!Buffer.isBuffer(bytes) || sha256(bytes) !== manifest.stages.original[rel]) {
        throw new PatchError(`Fresh original bytes for ${rel} are unavailable.`, 'backup-source');
      }
      originals.set(rel, Buffer.from(bytes));
    }
    return originals;
  }
  if (!spec && manifest.schema === 2 && ctx.legacy && ctx.legacy.status === 'valid') {
    const seventh = ctx.fileBytes.get(FIFTH_FILE);
    if (!Buffer.isBuffer(seventh) || sha256(seventh) !== manifest.stages.original[FIFTH_FILE]) {
      throw new PatchError(`Current ${FIFTH_FILE} is not the pinned original; legacy fallback is unusable.`, 'backup-source');
    }
    const originals = new Map();
    for (const rel of LEGACY_FILES) {
      const bytes = await fs.readFile(backupFilePath(ctx.legacy.real, rel));
      if (sha256(bytes) !== LEGACY_PINNED_ORIGINAL_HASHES[rel]) {
        throw new PatchError(`Legacy backup bytes for ${rel} no longer match the pinned original.`, 'backup-invalid');
      }
      originals.set(rel, bytes);
    }
    originals.set(FIFTH_FILE, Buffer.from(seventh));
    return originals;
  }
  throw new PatchError('Verified pristine originals are required before installation.', 'backup-source');
}

async function assertStable(ctx, expectedHashes) {
  const manifest = getManifest();
  const packagePath = safeJoin(ctx.extReal, PACKAGE_FILE);
  await assertTargetSafe(ctx.extReal, packagePath);
  const packageBytes = await fs.readFile(packagePath);
  if (sha256(packageBytes) !== manifest.stages.original[PACKAGE_FILE]) {
    throw new PatchError('package.json changed or no longer matches the pinned original.', 'stale-state');
  }
  let parsed;
  try {
    parsed = JSON.parse(packageBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    parsed = null;
  }
  if (
    !isRecord(parsed) ||
    parsed.publisher !== manifest.publisher ||
    parsed.name !== manifest.name ||
    parsed.version !== manifest.officialVersion
  ) {
    throw new PatchError('package identity changed before write.', 'stale-state');
  }
  for (const rel of targetFiles(manifest)) {
    const filePath = safeJoin(ctx.extReal, rel);
    await assertTargetSafe(ctx.extReal, filePath);
    const bytes = await fs.readFile(filePath);
    if (expectedHashes[rel] === null || sha256(bytes) !== expectedHashes[rel]) {
      throw new PatchError(`${rel} changed since the operation started.`, 'stale-state');
    }
  }
}

async function rollbackWritten(ctx, written) {
  const errors = [];
  for (const entry of [...written].reverse()) {
    try {
      await assertTargetSafe(ctx.extReal, entry.absolute);
      const current = await fs.readFile(entry.absolute);
      if (sha256(current) === sha256(entry.prior)) continue;
      if (sha256(current) !== entry.writtenHash) {
        throw new Error('file changed externally; preserving those bytes instead of overwriting them');
      }
      await atomicWrite(entry.absolute, entry.prior);
      if (sha256(await fs.readFile(entry.absolute)) !== sha256(entry.prior)) {
        throw new Error('restored bytes failed verification');
      }
    } catch (error) {
      errors.push(`${entry.rel}: ${error.message}`);
    }
  }
  return errors;
}

async function runMutation(pre, options, action) {
  const manifest = getManifest();
  let lock = null;
  let locked = null;
  const written = [];
  try {
    lock = await acquireLock(pre.ctx);
    locked = await inspectInternal(options);
    assertSameInspection(pre, locked);
    if (locked.report.backup.status === 'invalid') {
      throw new PatchError(`Backup is unusable: ${locked.report.backup.issues.join(' ')}`, 'backup-invalid');
    }

    let finalByRel;
    if (action === 'install') {
      if (!locked.report.canInstall) throw refusal(locked.report, 'install');
      const originals = await resolveOriginalSource(manifest, locked.ctx, options);
      finalByRel = generateFinalTargets(manifest, originals);
      if (locked.report.backup.status === 'missing') {
        await createBackup(locked.ctx, originals);
      } else if (locked.report.backup.status !== 'valid') {
        throw new PatchError(`Backup is unusable: ${locked.report.backup.issues.join(' ')}`, 'backup-invalid');
      }
    } else {
      if (locked.report.backup.status !== 'valid' || !locked.ctx.backupReal) {
        throw refusal(locked.report, 'restore');
      }
      const originals = await readOriginalsFromBackup(manifest, locked.ctx.backupReal);
      finalByRel = new Map();
      for (const rel of targetFiles(manifest)) finalByRel.set(rel, originals.get(rel));
    }

    const expectedHashes = hashesForTargets(manifest, locked.report);
    for (const rel of targetFiles(manifest)) {
      const desired = finalByRel.get(rel);
      if (!Buffer.isBuffer(desired)) throw new PatchError(`Final bytes for ${rel} are unavailable.`, 'generation-source');
      const desiredHash = sha256(desired);
      if (expectedHashes[rel] === desiredHash) continue;
      await assertStable(locked.ctx, expectedHashes);
      const absolute = safeJoin(locked.ctx.extReal, rel);
      await atomicWrite(absolute, desired);
      written.push({ rel, absolute, writtenHash: desiredHash, prior: Buffer.from(locked.ctx.fileBytes.get(rel)) });
      expectedHashes[rel] = desiredHash;
    }

    const post = await inspectInternal(options);
    const expectedState = action === 'install' ? latestStage(manifest) : 'original';
    if (post.report.state !== expectedState || post.report.backup.status !== 'valid') {
      throw new PatchError(
        `Post-${action} verification found state ${post.report.state}, expected ${expectedState}.`,
        'verification',
      );
    }
    for (const rel of targetFiles(manifest)) {
      const entry = post.report.files.find(file => file.path === rel);
      if (!entry || entry.hash !== sha256(finalByRel.get(rel))) {
        throw new PatchError(`Post-${action} verification failed for ${rel}.`, 'verification');
      }
    }
    return { ...post.report, operation: action, changed: written.length > 0 };
  } catch (error) {
    const rollbackErrors = await rollbackWritten(locked?.ctx ?? pre.ctx, written);
    const failure =
      error instanceof PatchError ? error : new PatchError(`Failed to ${action}: ${error.message}`, `${action}-failed`);
    if (failure !== error) failure.cause = error;
    if (failure !== error && error && Array.isArray(error.rollbackErrors)) {
      failure.rollbackErrors = [...error.rollbackErrors];
    }
    if (rollbackErrors.length > 0) {
      failure.rollbackErrors = [...(failure.rollbackErrors || []), ...rollbackErrors];
      failure.message += `; rollback errors: ${rollbackErrors.join('; ')}`;
    }
    try {
      const recovered = await inspectInternal(options);
      recovered.report.issues = [...recovered.report.issues, `operation failed: ${error.message}`];
      if (rollbackErrors.length > 0) recovered.report.rollbackErrors = rollbackErrors;
      recovered.report.operation = action;
      recovered.report.changed = rollbackErrors.length > 0;
      failure.report = recovered.report;
    } catch {
      failure.report = pre.report;
    }
    throw failure;
  } finally {
    if (lock) await lock.release();
  }
}

async function check(options = {}) {
  return (await inspectInternal(options)).report;
}

async function install(options = {}) {
  const manifest = getManifest();
  const pre = await inspectInternal(options);
  const manifestStages = stagesFor(manifest);
  if (!pre.report.canInstall || !manifestStages.includes(pre.report.state)) {
    throw refusal(pre.report, 'install');
  }

  const latest = latestStage(manifest);
  if (pre.report.state === latest && pre.report.backup.status === 'valid') {
    return { ...pre.report, operation: 'install', changed: false };
  }

  if (pre.report.state === latest) {
    let lock = null;
    try {
      lock = await acquireLock(pre.ctx);
      const locked = await inspectInternal(options);
      assertSameInspection(pre, locked);
      if (locked.report.state !== latest) {
        throw new PatchError(`Extension state is now ${locked.report.state}, expected ${latest}.`, 'stale-state');
      }
      if (locked.report.backup.status === 'valid') {
        return { ...locked.report, operation: 'install', changed: false };
      }
      if (locked.report.backup.status !== 'missing') {
        throw new PatchError(`Backup is unusable: ${locked.report.backup.issues.join(' ')}`, 'backup-invalid');
      }
      if (!locked.report.canInstall) throw refusal(locked.report, 'install');
      const originals = await resolveOriginalSource(manifest, locked.ctx, options);
      await createBackup(locked.ctx, originals);
      const post = await inspectInternal(options);
      if (post.report.state !== latest || post.report.backup.status !== 'valid') {
        throw new PatchError('Adoption backup verification failed.', 'verification');
      }
      return { ...post.report, operation: 'install', changed: false };
    } finally {
      if (lock) await lock.release();
    }
  }

  return runMutation(pre, options, 'install');
}

async function restore(options = {}) {
  const manifest = getManifest();
  const pre = await inspectInternal(options);
  if (pre.report.state === 'original') {
    return { ...pre.report, operation: 'restore', changed: false };
  }
  const manifestStages = stagesFor(manifest);
  if (!manifestStages.includes(pre.report.state) || pre.report.state === 'original') {
    throw refusal(pre.report, 'restore');
  }
  if (pre.report.backup.status !== 'valid' || !pre.ctx.backupReal) {
    throw refusal(pre.report, 'restore', 'a valid pristine backup is required for restore');
  }
  return runMutation(pre, options, 'restore');
}

function parseCli(argv) {
  if (!Array.isArray(argv)) throw new PatchError('CLI arguments must be an array.', 'invalid-arguments');
  let command = null;
  const seen = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === 'check' || argument === 'install' || argument === 'restore') {
      if (command !== null) throw new PatchError(`Duplicate command: ${argument}`, 'invalid-arguments');
      command = argument;
      continue;
    }
    if (
      argument === '--extension' ||
      argument === '--backup' ||
      argument === '--original-dir' ||
      argument === '--legacy-backup'
    ) {
      if (seen.has(argument)) throw new PatchError(`Duplicate argument: ${argument}`, 'invalid-arguments');
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new PatchError(`Missing value for ${argument}`, 'invalid-arguments');
      }
      seen.add(argument);
      values[argument] = value;
      index += 1;
      continue;
    }
    throw new PatchError(`Unknown argument: ${String(argument)}`, 'invalid-arguments');
  }
  if (command === null) throw new PatchError('Expected check|install|restore.', 'invalid-arguments');
  if (values['--extension'] === undefined) throw new PatchError('Missing --extension DIR.', 'invalid-arguments');
  return {
    command,
    options: {
      extDir: values['--extension'],
      backupDir: values['--backup'],
      originalDir: values['--original-dir'],
      legacyBackupDir: values['--legacy-backup'],
    },
  };
}

async function main(argv) {
  let command = null;
  try {
    const parsed = parseCli(argv);
    command = parsed.command;
    const options = parsed.options;
    let result;
    if (command === 'check') {
      result = await check(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.state === 'mixed' || result.state === 'incompatible' ? 1 : 0;
      return result;
    }
    if (command === 'install') result = await install(options);
    else result = await restore(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 0;
    return result;
  } catch (error) {
    const payload = {
      schema: 1,
      command,
      error: {
        code: error && error.code ? error.code : 'error',
        message: error && error.message ? error.message : String(error),
      },
    };
    if (error && error.rollbackErrors) payload.error.rollbackErrors = error.rollbackErrors;
    if (error && error.report) payload.report = error.report;
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
    return null;
  }
}

  return {
    check,
    install,
    restore,
    main,
    getManifest,
    parseCli,
    supportedVersion: spec ? spec.version : LEGACY_SUPPORTED_VERSION,
  };
}

module.exports = {
  createEngine,
  PatchError,
  LEGACY_SUPPORTED_VERSION,
  localAppDataDir,
};
