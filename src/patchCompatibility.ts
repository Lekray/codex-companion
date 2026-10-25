import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PatchAttestation = {
  schema: 1 | 2 | 3;
  officialVersion: string;
  features: string[];
  files: Record<string, string>;
};

export type PatchCompatibilityReport = {
  ok: boolean;
  code: 'ok' | 'missing' | 'version' | 'files' | 'manifest' | 'io';
  version: string | null;
  issues: string[];
};

const REQUIRED_FILES = [
  'package.json',
  'out/extension.js',
  'webview/assets/app-initial-97d3534ad35f.js',
  'webview/assets/app-initial-c014f9ee4429.js',
] as const;

const REQUIRED_FILE_SET: ReadonlySet<string> = new Set(REQUIRED_FILES);
export const COMPOSER_DRAFT_BUNDLE = 'webview/assets/app-initial-7a199c66e670.js';
export const SCHEMA3_OFFICIAL_VERSION = '26.1021.22027';
/** Previous 0.2.7 nine-file schema-3 target set, kept for compatibility. */
export const SCHEMA3_FILES = [
  'package.json',
  'out/extension.js',
  'webview/assets/src-622b307a9baf.js',
  'webview/assets/initialize-app-host-services.extension-f722db488e05.js',
  'webview/assets/local-conversation-page-e49199d4fdb5.js',
  'webview/assets/message-bus-4113ba7287d7.js',
  'webview/assets/use-model-settings-aafcff4b111c.js',
  'webview/assets/composer-content-8ab21f1a1982.js',
  'webview/assets/composer-scope-f0dbf0e746b6.js',
] as const;
/** Current 0.2.8 schema-3 target set, including the optional webview recovery. */
export const SCHEMA3_FILES10 = [
  ...SCHEMA3_FILES,
  'webview/assets/bookmarked-thread-user-message-navigation-36a0dadf9f5d.js',
] as const;
export const LEGACY_ATTESTATION_FILE = 'patchAttestation.json';
export const VERSIONED_ATTESTATION_FILES: Readonly<Record<string, string>> = {
  '26.1007.21434': LEGACY_ATTESTATION_FILE,
  [SCHEMA3_OFFICIAL_VERSION]: `patchAttestation-${SCHEMA3_OFFICIAL_VERSION}.json`,
};
const LEGACY_COMPATIBILITY_FILES = [...REQUIRED_FILES, COMPOSER_DRAFT_BUNDLE] as const;
const COMPATIBILITY_FILES_BY_VERSION: Readonly<Record<string, readonly string[]>> = {
  '26.1007.21434': LEGACY_COMPATIBILITY_FILES,
  [SCHEMA3_OFFICIAL_VERSION]: SCHEMA3_FILES10,
};
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const OFFICIAL_PUBLISHER = 'openai';
const OFFICIAL_NAME = 'chatgpt';

/** Exact attestation resource for a verified installed version; legacy by default. */
export function attestationFileForVersion(version: string | null | undefined): string {
  return (version ? VERSIONED_ATTESTATION_FILES[version] : undefined) ?? LEGACY_ATTESTATION_FILE;
}

/** Files whose mtime/size participate in the compatibility cache signature. */
export function compatibilityFilesForVersion(version: string | null | undefined): readonly string[] {
  return (version ? COMPATIBILITY_FILES_BY_VERSION[version] : undefined) ?? LEGACY_COMPATIBILITY_FILES;
}

type ValidatedAttestation = {
  attestation: PatchAttestation | null;
  issues: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function report(code: PatchCompatibilityReport['code'], version: string | null, issues: string[]): PatchCompatibilityReport {
  return { ok: code === 'ok', code, version, issues };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function filePath(root: string, file: string): string {
  return join(root, ...file.split('/'));
}

function validateAttestation(value: unknown): ValidatedAttestation {
  if (!isRecord(value)) {
    return { attestation: null, issues: ['Attestation must be an object.'] };
  }

  const issues: string[] = [];
  const schema = value.schema;
  const officialVersion = value.officialVersion;
  const features = value.features;
  const files = value.files;

  if (schema !== 1 && schema !== 2 && schema !== 3) issues.push('Attestation schema must be 1, 2 or 3.');
  const requiredFiles: readonly string[] = schema === 3
    ? SCHEMA3_FILES10
    : schema === 2 ? LEGACY_COMPATIBILITY_FILES : REQUIRED_FILES;
  const requiredFileSet: ReadonlySet<string> = schema === 3
    ? new Set(SCHEMA3_FILES10)
    : schema === 2 ? new Set(LEGACY_COMPATIBILITY_FILES) : REQUIRED_FILE_SET;
  if (typeof officialVersion !== 'string' || officialVersion.trim() === '') {
    issues.push('Attestation officialVersion must be a non-empty string.');
  } else if (schema === 3 && officialVersion !== SCHEMA3_OFFICIAL_VERSION) {
    issues.push(`Schema 3 attestation officialVersion must be ${SCHEMA3_OFFICIAL_VERSION}.`);
  }
  if (!Array.isArray(features) || features.some(feature => typeof feature !== 'string')) {
    issues.push('Attestation features must be an array of strings.');
  }

  const verifiedFiles: Record<string, string> = {};
  if (!isRecord(files)) {
    issues.push('Attestation files must be an object.');
  } else {
    for (const file of requiredFiles) {
      if (!Object.prototype.hasOwnProperty.call(files, file)) {
        issues.push(`Attestation files is missing ${file}.`);
        continue;
      }
      const hash = files[file];
      if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
        issues.push(`Attestation hash for ${file} must be a 64-character SHA256 hex string.`);
        continue;
      }
      verifiedFiles[file] = hash.toLowerCase();
    }
    for (const file of Object.keys(files)) {
      if (!requiredFileSet.has(file)) issues.push(`Attestation contains an unsupported file target: ${file}.`);
    }
  }

  if (issues.length > 0) return { attestation: null, issues };
  return {
    attestation: {
      schema: schema as 1 | 2 | 3,
      officialVersion: officialVersion as string,
      features: [...(features as string[])],
      files: verifiedFiles,
    },
    issues,
  };
}

/**
 * Read-only check that the installed official extension matches the attested build.
 * It never patches, downloads, reloads, or claims that attested features are active.
 */
export async function inspectOfficialPatch(extensionPath: string | undefined, attestation: unknown): Promise<PatchCompatibilityReport> {
  if (typeof extensionPath !== 'string' || extensionPath.trim() === '') {
    return report('missing', null, ['Official extension path is unavailable.']);
  }

  let validated: ValidatedAttestation;
  try {
    validated = validateAttestation(attestation);
  } catch (error) {
    return report('manifest', null, [`Attestation could not be validated: ${errorText(error)}`]);
  }
  if (!validated.attestation) return report('manifest', null, validated.issues);
  const expected = validated.attestation;

  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(filePath(extensionPath, 'package.json'));
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return report('missing', null, [`Official extension package.json is missing under ${extensionPath}.`]);
    }
    if (code === 'EISDIR') return report('manifest', null, ['Official extension package.json is not a file.']);
    return report('io', null, [`Cannot read official extension package.json: ${errorText(error)}`]);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return report('manifest', null, [`Official extension package.json is not valid JSON: ${errorText(error)}`]);
  }
  if (!isRecord(manifest)) return report('manifest', null, ['Official extension package.json must contain an object.']);

  const version = typeof manifest.version === 'string' ? manifest.version : null;
  if (manifest.publisher !== OFFICIAL_PUBLISHER || manifest.name !== OFFICIAL_NAME) {
    return report('manifest', null, ['Installed extension is not openai.chatgpt.']);
  }
  if (!version || version.trim() === '') {
    return report('manifest', null, ['Official extension package.json has no valid version.']);
  }
  if (version !== expected.officialVersion) {
    return report('version', version, [`Installed version ${version} does not match attested version ${expected.officialVersion}.`]);
  }

  const issues: string[] = [];
  for (const file of Object.keys(expected.files)) {
    const expectedHash = expected.files[file];
    if (!expectedHash) {
      issues.push(`Attestation hash for ${file} is unavailable.`);
      continue;
    }

    let bytes: Buffer;
    if (file === 'package.json') {
      bytes = manifestBytes;
    } else {
      try {
        bytes = await readFile(filePath(extensionPath, file));
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
          issues.push(`${file} is missing or is not a file.`);
          continue;
        }
        return report('io', version, [`Cannot read ${file}: ${errorText(error)}`]);
      }
    }

    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) {
      issues.push(`${file} does not match the attested version (expected ${expectedHash}, found ${actualHash}).`);
    }
  }

  return issues.length > 0 ? report('files', version, issues) : report('ok', version, []);
}
