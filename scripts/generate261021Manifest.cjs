"use strict";
/*
 * Release-time metadata generator for the new-version adapter
 * scripts/official261021.cjs (official OpenAI 26.1021.22027).
 *
 * Usage:
 *   node scripts/generate261021Manifest.cjs <original-dir> <manifest-out.json> [attestation-out.json] [syntax-work-dir]
 *
 * It verifies the pinned original hashes, transforms every target through
 * all incremental stages, syntax-verifies the generated programs (no install),
 * and writes the schema:3 manifest and attestation resources.
 */

const fs = require("node:fs");
const path = require("node:path");
const adapter = require("./official261021.cjs");

function defaultWorkDir() {
  return path.join(
    __dirname,
    "..",
    ".artifacts",
    "update-024",
    "adapter-work",
    "generated"
  );
}

function generate(originalDir, workDir) {
  const manifest = adapter.buildManifest(originalDir);
  const attestation = adapter.buildAttestation(manifest);
  const syntax = adapter.verifyTransforms(originalDir, workDir || defaultWorkDir());
  return { manifest, attestation, syntax };
}

function main(argv) {
  const [originalDir, manifestOut, attestationOut, workDir] = argv;
  if (!originalDir || !manifestOut) {
    throw new Error(
      "Usage: node scripts/generate261021Manifest.cjs <original-dir> <manifest-out.json> [attestation-out.json] [syntax-work-dir]"
    );
  }
  const result = generate(originalDir, workDir);
  fs.writeFileSync(
    path.resolve(manifestOut),
    JSON.stringify(result.manifest, null, 2) + "\n",
    "utf8"
  );
  if (attestationOut) {
    fs.writeFileSync(
      path.resolve(attestationOut),
      JSON.stringify(result.attestation, null, 2) + "\n",
      "utf8"
    );
  }
  return result;
}

module.exports = { generate, main, defaultWorkDir };

if (require.main === module) {
  try {
    main(process.argv.slice(2));
    process.stdout.write("generated ok\n");
  } catch (error) {
    process.stderr.write(String((error && error.stack) || error) + "\n");
    process.exitCode = 1;
  }
}
