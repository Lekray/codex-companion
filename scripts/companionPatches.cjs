'use strict';

/*
 * Public installer facade (CLI and module API).
 *
 * The guarded implementation lives in ./companionPatchEngine.cjs.  This file
 * only selects the engine for the exact installed openai.chatgpt identity:
 *
 * - 26.1007.21434 keeps the accepted legacy engine and manifest schema 1/2
 *   byte-for-byte.
 * - 26.1021.22027 uses the independent adapter loaded lazily from
 *   ./official261021.cjs and its schema 3 resources.
 * - Any other version is routed to the pinned legacy engine, which fails
 *   closed read-only (check reports `unknown-version`, install/restore refuse
 *   before any backup, lock or target write).
 *
 * Engine selection is per call, so concurrent checks/installs for different
 * extension identities never share a mutable "current version".
 *
 * CLI:
 *   node scripts/companionPatches.cjs check|install|restore \
 *     --extension DIR [--backup DIR] [--original-dir DIR] [--legacy-backup DIR]
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const {
  createEngine,
  PatchError,
  LEGACY_SUPPORTED_VERSION,
  localAppDataDir,
} = require('./companionPatchEngine.cjs');

const NEW_SPEC_MODULE = './official261021.cjs';
const OFFICIAL_PUBLISHER = 'openai';
const OFFICIAL_NAME = 'chatgpt';

/** Load the pinned new-version adapter lazily; absence must not break legacy routing. */
function loadPinnedNewSpec() {
  let moduleValue;
  try {
    moduleValue = require(NEW_SPEC_MODULE);
  } catch {
    return null;
  }
  if (!moduleValue || typeof moduleValue.SUPPORTED_VERSION !== 'string') return null;
  if (moduleValue.SUPPORTED_VERSION.trim() === '') return null;
  return moduleValue;
}

function legacyEngine() {
  return createEngine();
}

/** Read only the exact package identity needed for routing. Never writes. */
async function installedIdentity(extDir) {
  if (typeof extDir !== 'string' || extDir.trim() === '') return null;
  try {
    const real = await fs.realpath(path.resolve(extDir));
    const directory = await fs.stat(real);
    if (!directory.isDirectory()) return null;
    const packagePath = path.join(real, 'package.json');
    const info = await fs.lstat(packagePath);
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const parsed = JSON.parse((await fs.readFile(packagePath, 'utf8')).replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.publisher !== OFFICIAL_PUBLISHER || parsed.name !== OFFICIAL_NAME) return null;
    if (typeof parsed.version !== 'string' || parsed.version.trim() === '') return null;
    return { version: parsed.version };
  } catch {
    return null;
  }
}

async function engineForOptions(options) {
  const safe = options && typeof options === 'object' ? options : {};
  const identity = await installedIdentity(safe.extDir);
  const newSpec = loadPinnedNewSpec();
  if (newSpec && identity && identity.version === newSpec.SUPPORTED_VERSION) {
    return createEngine(newSpec);
  }
  return createEngine();
}

async function check(options = {}) {
  return (await engineForOptions(options)).check(options);
}

async function install(options = {}) {
  return (await engineForOptions(options)).install(options);
}

async function restore(options = {}) {
  return (await engineForOptions(options)).restore(options);
}

/** Default, version-specific pristine backup location used by the extension host. */
function defaultBackupPathForVersion(version) {
  const normalized = typeof version === 'string' && version.trim() !== ''
    ? version.trim()
    : LEGACY_SUPPORTED_VERSION;
  const newSpec = loadPinnedNewSpec();
  const specFiles = newSpec && Array.isArray(newSpec.FILES) ? newSpec.FILES.length : 0;
  const leaf = newSpec && normalized === newSpec.SUPPORTED_VERSION
    ? specFiles === 12
      ? 'chunks-v4'
      : specFiles === 11
        ? 'chunks-v3'
        : specFiles === 10
          ? 'chunks-v2'
          : 'chunks-v1'
    : 'drafts-v1';
  return path.join(localAppDataDir(), 'codex-companion', 'patches', normalized, leaf);
}

function supportedVersions() {
  const newSpec = loadPinnedNewSpec();
  return newSpec ? [LEGACY_SUPPORTED_VERSION, newSpec.SUPPORTED_VERSION] : [LEGACY_SUPPORTED_VERSION];
}

function getManifest() {
  return legacyEngine().getManifest();
}

function writeCliFailure(command, error) {
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

async function main(argv) {
  let command = null;
  try {
    const parsed = legacyEngine().parseCli(argv);
    command = parsed.command;
    return await (await engineForOptions(parsed.options)).main(argv);
  } catch (error) {
    return writeCliFailure(command, error);
  }
}

module.exports = {
  check,
  install,
  restore,
  main,
  getManifest,
  PatchError,
  defaultBackupPathForVersion,
  supportedVersions,
};

if (require.main === module) {
  main(process.argv.slice(2));
}
