'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{spawnSync}=require('node:child_process');
const transform=require('../../scripts/officialDraftTransform.cjs');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'.artifacts/productivity-021/installed-before'),artifacts=path.join(root,'.artifacts/productivity-021/drafts');
const source=fs.readFileSync(path.join(root,'resources/officialDraftIsolation.js'),'utf8');
const A='e148847e-197f-4341-be6f-8a443b913feb',B='8fc79829-e29e-4506-a45a-2c46b3760694';
const nativeC=fs.readFileSync(path.join(base,transform.DRAFT_C014_FILE),'utf8'),native7=fs.readFileSync(path.join(base,transform.DRAFT_7A_FILE),'utf8');
const patchedC=transform.applyDraftTransforms(transform.DRAFT_C014_FILE,nativeC),patched7=transform.applyDraftTransforms(transform.DRAFT_7A_FILE,native7);
function helper(route){const meta={content:route},context={URLSearchParams,URL,document:{querySelector:()=>meta}};vm.runInNewContext(source,context);return {api:context.__companionDraftIsolation,meta};}
function fv(text,api){const start=text.indexOf('function Fv('),end=text.indexOf('function pit(',start);assert(start>=0&&end>start);return new Function('xp','__companionDraftIsolation','return ('+text.slice(start,end)+')')(input=>input.entrypoint==='home'?'new-conversation':'panel-new-conversation',api);}
const prefix='/* '+transform.DRAFT_MARKER+' */\n'+source.replace(/\s+$/,'')+'\n';

test('only valid Companion UUID home routes provide a scope',()=>{
 const api=helper('/').api;
 for(const route of ['/?companion='+A,'/?companion%3D'+A,'/?x=1&companion='+A.toUpperCase()])assert.equal(api.parseInitialRoute(route),A);
 for(const route of ['/',null,'/?companion=bad','/local/id?companion='+A,'/extension/panel/new?companion='+A,'/?companion%253D'+A])assert.equal(api.parseInitialRoute(route),null,String(route));
 assert.equal(api.resetForTests,undefined);
});

test('scope is deterministic per editor and never follows a later focus/route change',()=>{
 const a=helper('/?companion='+A),b=helper('/?companion='+B);
 assert.equal(a.api.scopeKey('new-conversation'),'new-conversation:companion:'+A);
 assert.equal(b.api.scopeKey('new-conversation'),'new-conversation:companion:'+B);
 a.meta.content='/?companion='+B;assert.equal(a.api.scopeKey('new-conversation'),'new-conversation:companion:'+A);
 for(const key of ['panel-new-conversation','local-chatgpt:id','gpt-draft:1','cloud:1','other',null])assert.equal(a.api.scopeKey(key),key);
 assert.equal(helper('/').api.scopeKey('new-conversation'),'new-conversation');
});

test('active native Fv scopes only a new ordinary HOME composer',()=>{
 const fa=fv(patchedC,helper('/?companion='+A).api),fb=fv(patchedC,helper('/?companion='+B).api),plain=fv(nativeC,helper('/').api);
 assert.equal(fa({kind:'new',entrypoint:'home',gptId:null}),'new-conversation:companion:'+A);
 assert.equal(fb({kind:'new',entrypoint:'home'}),'new-conversation:companion:'+B);
 assert.equal(fv(patchedC,helper('/').api)({kind:'new',entrypoint:'home'}),plain({kind:'new',entrypoint:'home'}));
 const controls=[{kind:'new',entrypoint:'home',gptId:'gpt-id'},{kind:'new',entrypoint:'panel'},{kind:'new',entrypoint:'pull-request-review',draftThreadLocationId:'review-id'},{kind:'new',entrypoint:'library-preview',previewId:'preview-id'},{kind:'local',clientThreadId:'local-chatgpt:saved-id',conversationId:'saved-id'},{kind:'cloud',taskId:'task-id'},{kind:'chatgpt',conversationId:'chat-id',widgetOverlay:true},{kind:'chatgpt',conversationId:null},{kind:'other'}];
 for(const input of controls)assert.equal(fa(input),plain(input),JSON.stringify(input));
});

test('7a body is byte-identical and c014 changes exactly one native Fv branch',()=>{
 assert.equal(patched7,prefix+native7);
 assert.equal(patchedC,prefix+nativeC.replace(transform.FV_ANCHOR,transform.FV_REPLACEMENT));
 assert.equal(patchedC.slice(prefix.length).replace(transform.FV_REPLACEMENT,transform.FV_ANCHOR),nativeC);
 for(const marker of ['composer-prompt-drafts-v2','composer-prompt-drafts-v1','composer-retained-documents-v1'])assert(native7.includes(marker));
 for(const marker of ['function Ynt(','function Xnt(','function Znt(','function Fzi(','function _U('])assert(nativeC.includes(marker),marker);
});

test('unknown build, missing/duplicate anchors, bad helper and double-apply are refused',()=>{
 assert.throws(()=>transform.applyDraftTransforms(transform.DRAFT_C014_FILE,nativeC+' '),/SHA256/);
 assert.throws(()=>transform.applyDraftTransforms(transform.DRAFT_7A_FILE,native7+' '),/SHA256/);
 assert.throws(()=>transform.applyDraftTransforms(transform.DRAFT_C014_FILE,patchedC),/already present/);
 assert.throws(()=>transform.applyDraftTransforms(transform.DRAFT_7A_FILE,patched7),/already present/);
 assert.throws(()=>transform.applyDraftTransforms(transform.DRAFT_C014_FILE,nativeC,''),/helper source/);
 assert.throws(()=>transform.replaceOnce('missing','needle','new','test'),/not found/);
 assert.throws(()=>transform.replaceOnce('needle needle','needle','new','test'),/not unique/);
 for(const file of ['package.json','out/extension.js','webview/assets/app-initial-97d3534ad35f.js','unknown'])assert.equal(transform.applyDraftTransforms(file,'same'),'same');
});

test('both changed bundles parse as native ES modules',()=>{
 fs.mkdirSync(artifacts,{recursive:true});
 for(const [name,text] of [['main-check-c014.mjs',patchedC],['main-check-7a.mjs',patched7]]){const target=path.join(artifacts,name);fs.writeFileSync(target,text);const check=spawnSync(process.execPath,['--check',target],{encoding:'utf8',windowsHide:true});assert.equal(check.status,0,check.stderr);}
});
