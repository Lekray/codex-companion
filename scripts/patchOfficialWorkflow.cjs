'use strict';

// Main-owned composition of accepted pure transforms. The generic layer owns
// byte guards, backups and exact-predecessor rollback; no unknown build is used.
const fs=require('node:fs');
const path=require('node:path');
const titles=require('./patchOfficialTitles.cjs');
const history=require('./patchOfficialHistory.cjs');
const layer=require('./officialWorkflowLayer.cjs');

function buildMaterials(originalDir) {
  const prior=titles.buildMaterials(originalDir);
  const {applyStatusTransforms}=require('./officialStatusTransform.cjs');
  const {applyModelTransforms}=require('./officialModelTransform.cjs');
  const targets={};
  for(const file of titles.PATCHED_FILES) {
    const baseline=prior.titleTexts[file];
    const status=applyStatusTransforms(file,baseline);
    targets[file]={baseline,patched:applyModelTransforms(file,status)};
  }
  const guard='webview/assets/app-initial-97d3534ad35f.js';
  return {
    version:titles.SUPPORTED_VERSION,publisher:'openai',name:'chatgpt',
    packageSha:titles.SUPPORTED_ORIGINAL_HASHES['package.json'],targets,
    guards:{[guard]:layer.sha256(history.generatePatchedText(guard,prior.fixture.texts[guard]))},
    features:['project-history','startup-watchdog','native-tab-titles','project-model','tab-status','workflow-notifications'],
  };
}

async function main(argv) {
  const [command,...rest]=argv;
  if(!['check','apply','restore','attest'].includes(command))throw Error('Expected check|apply|restore|attest');
  const options={};
  for(let i=0;i<rest.length;i+=2) {
    const key=rest[i],value=rest[i+1];
    if(!['--extension','--backup','--original-dir','--output'].includes(key)||!value||value.startsWith('--'))throw Error('Invalid CLI arguments');
    if(options[key]!==undefined)throw Error('Duplicate argument '+key);
    options[key]=path.resolve(value);
  }
  const materials=buildMaterials(options['--original-dir']);
  if(command==='attest') {
    const attestation=layer.createAttestation(materials);
    if(options['--output'])fs.writeFileSync(options['--output'],JSON.stringify(attestation,null,2)+'\n','utf8');
    return attestation;
  }
  const extDir=options['--extension'];
  if(!extDir)throw Error('Missing --extension');
  if(command==='check') {
    const report=await layer.checkLayer({extDir,materials});
    if(report.status==='incompatible')process.exitCode=1;
    return report;
  }
  const backupDir=options['--backup'];
  if(!backupDir)throw Error('Missing --backup');
  return command==='apply'
    ? layer.applyLayer({extDir,backupDir,materials})
    : layer.restoreLayer({extDir,backupDir,materials});
}

module.exports={buildMaterials,main};
if(require.main===module)main(process.argv.slice(2)).then(
  result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'),
  error=>{process.stderr.write(String(error.stack||error)+'\n');process.exitCode=1;},
);
