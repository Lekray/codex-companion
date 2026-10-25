'use strict';

// Release-time metadata only. Runtime installation never ships official bundles
// and never relies on the developer's .artifacts directory.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const history = require('./patchOfficialHistory.cjs');
const titles = require('./patchOfficialTitles.cjs');
const { applyStatusTransforms } = require('./officialStatusTransform.cjs');
const { applyModelTransforms } = require('./officialModelTransform.cjs');

const FIFTH_FILE = 'webview/assets/app-initial-7a199c66e670.js';
const FIFTH_ORIGINAL_HASH = '59b909377a370e09cb8523ab99a1f4ff282a0126527bd339db31e6d9ac7c9c26';
const LEGACY_FILES = ['package.json', ...history.PATCHED_FILES];
const BASE_STAGES = ['original', 'history', 'titles', 'workflow'];
const HOST = 'out/extension.js';
const C014 = 'webview/assets/app-initial-c014f9ee4429.js';

const LEGACY_FEATURES = [
  { id: 'project-history', stage: 'history', files: history.PATCHED_FILES },
  { id: 'startup-watchdog', stage: 'history', files: [HOST] },
  { id: 'native-tab-titles', stage: 'titles', files: [HOST, C014] },
  { id: 'project-model', stage: 'workflow', files: [HOST, C014] },
  { id: 'tab-status', stage: 'workflow', files: [HOST] },
  { id: 'workflow-notifications', stage: 'workflow', files: [HOST] },
];

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function requireDraftTransform() {
  const moduleValue = require('./officialDraftTransform.cjs');
  if (!moduleValue || typeof moduleValue.applyDraftTransforms !== 'function') {
    throw new Error('officialDraftTransform.cjs does not export applyDraftTransforms');
  }
  return moduleValue.applyDraftTransforms;
}

function buildManifest(originalDir, schema) {
  const prior = titles.buildMaterials(originalDir);
  const files = schema === 2 ? [...LEGACY_FILES, FIFTH_FILE] : [...LEGACY_FILES];
  const stages = Object.fromEntries(
    (schema === 2 ? [...BASE_STAGES, 'drafts'] : BASE_STAGES).map(stage => [stage, {}]),
  );
  const draft = schema === 2 ? requireDraftTransform() : null;

  for (const file of files) {
    let original;
    if (file === FIFTH_FILE) {
      original = fs.readFileSync(path.join(originalDir, ...file.split('/')));
      if (sha256(original) !== FIFTH_ORIGINAL_HASH) {
        throw new Error(`original fixture ${file} has unknown bytes; expected ${FIFTH_ORIGINAL_HASH}`);
      }
    } else {
      original = Buffer.from(prior.fixture.texts[file], 'utf8');
      const expected = titles.SUPPORTED_ORIGINAL_HASHES[file];
      if (sha256(original) !== expected.toLowerCase()) {
        throw new Error(`original fixture ${file} does not match the accepted pinned original`);
      }
    }
    const originalText = original.toString('utf8');
    const historyText = history.PATCHED_FILES.includes(file)
      ? history.generatePatchedText(file, originalText)
      : originalText;
    const titleText = titles.PATCHED_FILES.includes(file)
      ? titles.generatePatchedText(file, historyText)
      : historyText;
    const workflowText = titles.PATCHED_FILES.includes(file)
      ? applyModelTransforms(file, applyStatusTransforms(file, titleText))
      : titleText;
    const draftsText = draft ? draft(file, workflowText) : workflowText;
    const texts = { original: originalText, history: historyText, titles: titleText, workflow: workflowText, drafts: draftsText };
    for (const stage of Object.keys(stages)) {
      stages[stage][file] = sha256(Buffer.from(texts[stage], 'utf8'));
    }
  }

  const features =
    schema === 2
      ? [
          ...LEGACY_FEATURES,
          { id: 'independent-drafts', stage: 'drafts', files: [C014, FIFTH_FILE] },
        ]
      : LEGACY_FEATURES;

  return {
    schema,
    officialVersion: titles.SUPPORTED_VERSION,
    publisher: 'openai',
    name: 'chatgpt',
    files,
    stages,
    features,
  };
}

function generate(originalDir) {
  return buildManifest(originalDir, 2);
}

function generateLegacy(originalDir) {
  return buildManifest(originalDir, 1);
}

module.exports = { generate, generateLegacy };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2) throw new Error('Usage: node scripts/generatePatchBundleManifest.cjs <verified-original-dir> <output-json>');
  fs.writeFileSync(path.resolve(args[1]), JSON.stringify(generate(path.resolve(args[0])), null, 2) + '\n');
}
