"use strict";
/*
 * Pure transformer for the per-project model+effort preference patch, layered on
 * top of the accepted history + watchdog + title baseline (the title-patched
 * bytes produced by scripts/patchOfficialTitles.cjs).
 *
 * It changes only two files:
 *   - out/extension.js: inject the pure model storage helpers, a message-handler
 *     case for "companion-project-model-request" / "companion-project-model-selected"
 *     inserted before the unique case"view-focused" seam, and expose the
 *     in-scope signature __companionWorkflowGetProjectModel(provider) that the
 *     status worker's getState reads.
 *   - webview/assets/app-initial-c014f9ee4429.js: wrap the picker callbacks in
 *     function Fzi (select/set model+effort) so a successful deliberate pick is
 *     reported to the host, and restore the stored pair once per new-empty-chat
 *     instance via setModelAndReasoningEffort(..., {persistAsDefault:false}).
 *
 * applyModelTransforms(file, baselineText) returns the transformed text for the
 * two patched files and the baselineText UNCHANGED for every other file. It has
 * no filesystem side effects and is a pure function of its inputs.
 *
 * Anchors are unique snippets; a missing or duplicated anchor throws so unknown
 * bytes are refused rather than guessed at.
 */

const fs = require("fs");
const path = require("path");

const PATCHED_FILES = Object.freeze([
  "out/extension.js",
  "webview/assets/app-initial-c014f9ee4429.js",
]);

// ---------------------------------------------------------------------------
// Pure payload source (single source of truth, injected into the host)
// ---------------------------------------------------------------------------

function modelCoreSourcePath() {
  return path.join(__dirname, "..", "resources", "officialProjectModel.js");
}

function loadModelCoreSource() {
  return fs.readFileSync(modelCoreSourcePath(), "utf8");
}

// ---------------------------------------------------------------------------
// Anchors (unique snippets; never whole lines)
// ---------------------------------------------------------------------------

const HOST_TKE_ANCHOR =
  'function TKe(t){return t?t.length>AKe?t.substring(0,AKe)+"\\u2026":t:RKe}';
const HOST_VIEW_FOCUSED_ANCHOR = 'case"view-focused":{this.setFocusedViewForWebview(e);break}';

const C014_FZI_LINE1 =
  "function Fzi(e){let t=(0,Lzi.c)(57),{conversationId:n,executionHostId:r,modelSelection:i}=e,a=ta(Iv),o=J(Qw,n),s=K(Fve),c=K(lQe),l=J(o1e,n),u;";
const C014_FZI_DRAFT_LINE =
  "let d=u,f=n==null&&s!=null,p=o||f,m=p&&d===\u0060local\u0060&&r===\u0060local\u0060&&Nh?.customRuntime!=null?\u0060persistent\u0060:null,h=act(d??\u0060local\u0060,p),g=E_(!1),_;";
const C014_FZI_RETURN_LINE =
  "let N=M,P=D?.additionalAvailableModels,F=p&&h==null||f&&T&&C===\u0060pending\u0060,I=D?.selectedModelId??i.modelSettings.model,L;";
const C014_J_FN =
  "A=function(e,t,n){return T&&e!==D?.selectedModelId?Promise.resolve(!1):i.selectComposerModelAndReasoningEffort(e,m??t,()=>{n(),f&&!T&&a.set(lQe,e)},f?{persistAsDefault:!1}:void 0)}";
const C014_N_FN =
  "M=function(e,t){return T&&e!==D?.selectedModelId?Promise.resolve(!1):(f&&!T&&a.set(lQe,e),i.setModelAndReasoningEffort(e,m??t,f?{persistAsDefault:!1}:void 0))}";

// Native ordinary-home (p=false) setter anchor inside _U: draft persistence
// must be scoped through the native Yf optimistic atom instead of the backend
// default. `rA` supplies the exact {hostId,cwd} used by iPn's HSe key.
const C014_U_SCOPE_ANCHOR = "u=r==null,d;";
const C014_U_SETTER_ANCHOR =
  "let i=g&&e===\u0060gpt-reserve\u0060?S:e,a=_&&n?.persistAsDefault===!1;";
const C014_U_SCOPE_REPLACEMENT = "u=r==null,d;let __companionModelHost=rA(r);";
const C014_U_SETTER_INSERT =
  'if(r==null&&__companionModelHost.hostId==="local"&&n?.persistAsDefault===!1&&!p){' +
  "l.set(Yf,HSe({conversationId:null,hasConversation:!1,hostId:__companionModelHost.hostId,cwd:__companionModelHost.cwd}),{model:i,reasoningEffort:t});" +
  "await Bp(l,__companionModelHost.hostId).clearPrewarmedThreads();return!0}";
const C014_U_SETTER_REPLACEMENT =
  "let i=g&&e===\u0060gpt-reserve\u0060?S:e;" +
  C014_U_SETTER_INSERT +
  "let a=_&&n?.persistAsDefault===!1;";

// Both wrapped callbacks must pass persistAsDefault:false for an empty local
// view even when the managed-draft flag f is false (ordinary HOME). Cell data
// is read at invocation time to avoid the A(e,t,n) callback-arg shadowing bug.
const C014_FORCE_LOCAL_EMPTY =
  '(__companionModelCell.current!=null&&__companionModelCell.current.conversationId==null&&__companionModelCell.current.hostId==="local"||f)';

// ---------------------------------------------------------------------------
// Renderer glue (injected into c014 just before function Fzi)
// ---------------------------------------------------------------------------

const MODEL_RENDERER_GLUE = `
function __companionModelResolveResult(promise,onSettle){if(promise!=null&&typeof promise.then==="function"){return promise.then(function(v){try{onSettle(v,!0)}catch(e){}return v},function(e){try{onSettle(null,!1)}catch(x){}throw e})}try{onSettle(promise,!0)}catch(e){}return promise}
function __companionModelReportSelection(vm,modelId,effort,conversationId,intentAt,intentSeq){try{vm.dispatchMessage("companion-project-model-selected",{hostId:"local",model:modelId,effort:effort,conversationId:conversationId,intentAt:intentAt,intentSeq:intentSeq})}catch(e){}}
function __companionModelSettleChoice(st,ok,value,seq,meta,vm,modelId,effort,intentAt){if(st==null)return;if(st.pendingChoices>0)st.pendingChoices--;if(ok&&value!==false){st.userChose=!0;st.applied=!0;st.pair=null;if(seq>(st.lastChoiceSeq||0)){st.lastChoiceSeq=seq;if(meta!=null&&meta.hostId==="local")__companionModelReportSelection(vm,modelId,meta.lockedEffort??effort,meta.conversationId,intentAt,seq)}}else if(typeof st.applyPending==="function")st.applyPending()}
function __companionModelWrapSelect(orig,cell,state,vm){return function(modelId,effort,callback){var meta=cell.current||{},st=state.current,seq=++st.choiceSeq,intentAt=Date.now();st.pendingChoices=(st.pendingChoices||0)+1;var res;try{res=orig(modelId,effort,callback)}catch(e){if(st.pendingChoices>0)st.pendingChoices--;throw e}return __companionModelResolveResult(res,function(v,ok){__companionModelSettleChoice(st,ok,v,seq,meta,vm,modelId,effort,intentAt)})}}
function __companionModelWrapSet(orig,cell,state,vm){return function(modelId,effort){var meta=cell.current||{},st=state.current,seq=++st.choiceSeq,intentAt=Date.now();st.pendingChoices=(st.pendingChoices||0)+1;var res;try{res=orig(modelId,effort)}catch(e){if(st.pendingChoices>0)st.pendingChoices--;throw e}return __companionModelResolveResult(res,function(v,ok){__companionModelSettleChoice(st,ok,v,seq,meta,vm,modelId,effort,intentAt)})}}
`;

// ---------------------------------------------------------------------------
// Host glue (injected into out/extension.js after the model core)
// ---------------------------------------------------------------------------

const MODEL_HOST_GLUE = `
function __companionModelIsLocalChatPanel(provider,webview){
  if(provider==null||webview==null)return false;
  var panel;
  try{panel=provider.findPanelByWebview(webview)}catch(e){return false}
  if(panel==null)return false;
  try{if(!provider.isPanelAlive(panel))return false}catch(e){return false}
  try{if(typeof __companionIsSpecializedPanel==="function"&&__companionIsSpecializedPanel(provider,panel))return false}catch(e){}
  return true;
}
async function __companionModelHandleRequest(provider,webview,message){
  try{
    if(!__companionModelIsLocalChatPanel(provider,webview))return;
    if(message==null||typeof message!=="object"||message.hostId!=="local")return;
    var requestId=message!=null&&typeof message==="object"&&typeof message.requestId==="string"?message.requestId:null;
    if(requestId==null)return;
    var ctx=provider&&provider.__companionWorkflowContext;
    var ws=ctx&&ctx.workspaceState;
    if(ws==null||typeof ws!=="object"||typeof ws.get!=="function"||typeof ws.update!=="function"){
      provider.postMessageToWebview(webview,{type:"companion-project-model",requestId:requestId,pending:true});
      return;
    }
    var pair=await __companionWorkflowGetProjectModel(provider);
    if(pair==null){
      provider.postMessageToWebview(webview,{type:"companion-project-model",requestId:requestId,valid:false});
      return;
    }
    provider.postMessageToWebview(webview,{type:"companion-project-model",requestId:requestId,valid:true,model:pair.model,effort:pair.effort});
  }catch(e){}
}
async function __companionModelHandleSelected(provider,webview,message){
  try{
    if(!__companionModelIsLocalChatPanel(provider,webview))return;
    if(message==null||typeof message!=="object"||message.hostId!=="local")return;
    var pair=__companionModelValidatePair(message.model,message.effort);
    if(pair==null)return;
    var roots;
    try{roots=cR()}catch(e){roots=[]}
    var key=__companionModelProjectKey(roots);
    if(key==null)return;
    var ctx=provider&&provider.__companionWorkflowContext;
    var ws=ctx&&ctx.workspaceState;
    if(ws==null||typeof ws!=="object"||typeof ws.get!=="function"||typeof ws.update!=="function")return;
    await __companionModelWrite(provider,pair,message.intentAt);
  }catch(e){}
}
`;

// Fzi body edits (small, stable, self-contained snippets).
const C014_FZI_CELL_INIT =
  "let __companionModelCell=b3i.useRef(null),__companionModelState=b3i.useRef(null),__companionModelPrevCid=__companionModelCell.current==null?null:__companionModelCell.current.conversationId;if(__companionModelState.current==null||__companionModelPrevCid!==n||__companionModelState.current.hostId!==r)__companionModelState.current={hostId:r,isAeonDraft:null,applied:!1,userChose:!1,reqId:null,retries:0,pair:null,pendingChoices:0,choiceSeq:0,lastChoiceSeq:0,applyPending:null};";
const C014_FZI_CELL_UPDATE =
  "if(__companionModelState.current.isAeonDraft!==f){__companionModelState.current.isAeonDraft=f;__companionModelState.current.applied=!1;__companionModelState.current.pair=null;__companionModelState.current.reqId=null;__companionModelState.current.retries=0;__companionModelState.current.applyPending=null;}" +
  "__companionModelCell.current={conversationId:n,hostId:r,isAeonDraft:f,lockedEffort:m,setModelAndReasoningEffort:i.setModelAndReasoningEffort};";

// Ordinary HOME has n==null and isNewThreadDraft false; the old f-only gate
// never requested a restore there. Readiness, catalog validation and the
// one-shot apply live in stable effects with a native cached catalog read.
const C014_FZI_RESTORE_CATALOG =
  'let __companionModelRestoreCatalog=rU({hostId:r,enabled:r==="local"&&n==null});';
const C014_FZI_REQUEST_EFFECT =
  '(0,b3i.useEffect)(function(){if(n!=null||r!=="local")return;var st=__companionModelState.current;if(st==null||st.applied||st.userChose)return;var closed=!1;function req(){if(closed||st.applied||st.userChose)return;st.reqId="companion-model-"+Math.random().toString(36).slice(2)+Date.now().toString(36);try{vm.dispatchMessage("companion-project-model-request",{requestId:st.reqId,hostId:"local"})}catch(e){}}function h(msg){if(closed||st.applied||st.userChose)return;if(msg==null||typeof msg!=="object"||msg.type!=="companion-project-model"||msg.requestId!==st.reqId)return;if(msg.pending===true){if(st.retries<5){st.retries++;setTimeout(req,600)}return}if(msg.valid!==true)return;var model=typeof msg.model==="string"?msg.model:null,effort=typeof msg.effort==="string"?msg.effort:null;if(model==null||effort==null)return;st.pair={model:model,effort:effort};if(typeof st.applyPending==="function")st.applyPending()}var unsub;try{unsub=vm.subscribe("companion-project-model",h)}catch(e){}if(st.reqId==null)req();return function(){closed=!0;if(unsub)try{unsub()}catch(e){}}},[n,r,f]);';
const C014_FZI_APPLY_EFFECT =
  '(0,b3i.useEffect)(function(){if(n!=null||r!=="local")return;var st=__companionModelState.current;if(st==null)return;var closed=!1;function tryApply(){if(closed||st.applied||st.userChose||(st.pendingChoices||0)>0)return;var pair=st.pair;if(pair==null)return;var cat=__companionModelRestoreCatalog;if(cat==null||cat.isLoading===true)return;if(cat.isError===true){st.pair=null;st.applied=!0;return}var models=cat.data&&cat.data.models;if(!Array.isArray(models))return;var cur=__companionModelCell.current;if(cur==null||cur.conversationId!=null||cur.hostId!=="local")return;var ms=i.modelSettings||{};if(ms.isLoading===true)return;if(T===true||m!=null){st.pair=null;st.applied=!0;return}var entry=null;for(var x=0;x<models.length;x++){if(models[x]!=null&&models[x].model===pair.model){entry=models[x];break}}if(entry==null){st.pair=null;st.applied=!0;return}var efforts=entry.supportedReasoningEfforts;if(!Array.isArray(efforts)){st.pair=null;st.applied=!0;return}var supported=!1;for(var y=0;y<efforts.length;y++){if(efforts[y]!=null&&efforts[y].reasoningEffort===pair.effort){supported=!0;break}}if(!supported){st.pair=null;st.applied=!0;return}var setter=cur.setModelAndReasoningEffort;if(typeof setter!=="function")return;var res;try{res=setter(pair.model,pair.effort,{persistAsDefault:false})}catch(e){return}if(res!=null&&typeof res.then==="function"){res.then(function(v){if(closed)return;if(v===false)return;st.applied=!0;st.pair=null},function(){})}else if(res!==false){st.applied=!0;st.pair=null}}st.applyPending=tryApply;tryApply();return function(){closed=!0;if(st.applyPending===tryApply)st.applyPending=null;}},[n,r,f,__companionModelRestoreCatalog&&__companionModelRestoreCatalog.data,__companionModelRestoreCatalog&&__companionModelRestoreCatalog.isLoading,__companionModelRestoreCatalog&&__companionModelRestoreCatalog.isError,T,m,i.modelSettings&&i.modelSettings.isLoading]);';
const C014_FZI_EFFECT =
  C014_FZI_RESTORE_CATALOG + C014_FZI_REQUEST_EFFECT + C014_FZI_APPLY_EFFECT;

// ---------------------------------------------------------------------------
// Transformations
// ---------------------------------------------------------------------------

function replaceOnce(text, needle, replacement, label) {
  const idx = text.indexOf(needle);
  if (idx === -1) throw new Error(`patch anchor not found: ${label}`);
  if (text.indexOf(needle, idx + needle.length) !== -1) {
    throw new Error(`patch anchor not unique: ${label}`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

function transformHost(baselineText, coreSource) {
  const core = coreSource === undefined ? loadModelCoreSource() : coreSource;
  for (const marker of [
    "__companionStartupWatchdog",
    "__companionHistoryRoots",
    "__companionNormalizedRoots",
    "__companionTabTitlePayload",
    "case\"companion-tab-title\"",
    "__companionShouldApplyPreviewTitle",
  ]) {
    if (!baselineText.includes(marker)) {
      throw new Error(`extension.js: accepted history+watchdog+title baseline is missing ${marker}`);
    }
  }
  if (baselineText.includes("companion-project-model")) {
    throw new Error("extension.js: model patch is already present");
  }
  let t = replaceOnce(
    baselineText,
    HOST_TKE_ANCHOR,
    HOST_TKE_ANCHOR + "\n" + core + "\n" + MODEL_HOST_GLUE,
    "extension.js:inject model helpers after TKe"
  );
  t = replaceOnce(
    t,
    HOST_VIEW_FOCUSED_ANCHOR,
    'case"companion-project-model-request":{__companionModelHandleRequest(this,e,r);break}' +
      'case"companion-project-model-selected":{__companionModelHandleSelected(this,e,r);break}' +
      HOST_VIEW_FOCUSED_ANCHOR,
    "extension.js:handle companion-project-model messages"
  );
  return t;
}

function transformC014(baselineText) {
  for (const marker of ["companion-history-scope-changed", "companion-tab-title"]) {
    if (!baselineText.includes(marker)) {
      throw new Error(`c014 bundle: accepted history+title baseline is missing ${marker}`);
    }
  }
  if (baselineText.includes("companion-project-model")) {
    throw new Error("c014 bundle: model patch is already present");
  }
  let t = replaceOnce(
    baselineText,
    C014_FZI_LINE1,
    MODEL_RENDERER_GLUE + "\n" + C014_FZI_LINE1 + C014_FZI_CELL_INIT,
    "c014:inject renderer glue and picker cell"
  );
  t = replaceOnce(
    t,
    C014_FZI_DRAFT_LINE,
    C014_FZI_DRAFT_LINE + C014_FZI_CELL_UPDATE,
    "c014:update picker cell from draft state"
  );
  t = replaceOnce(
    t,
    C014_J_FN,
    C014_J_FN.replace("f?{persistAsDefault:!1}:void 0", C014_FORCE_LOCAL_EMPTY + "?{persistAsDefault:!1}:void 0").replace(
      "A=function",
      "A=__companionModelWrapSelect(function"
    ) + ",__companionModelCell,__companionModelState,vm)",
    "c014:wrap selectModelAndReasoningEffort"
  );
  t = replaceOnce(
    t,
    C014_N_FN,
    C014_N_FN.replace("f?{persistAsDefault:!1}:void 0", C014_FORCE_LOCAL_EMPTY + "?{persistAsDefault:!1}:void 0").replace(
      "M=function",
      "M=__companionModelWrapSet(function"
    ) + ",__companionModelCell,__companionModelState,vm)",
    "c014:wrap setModelAndReasoningEffort"
  );
  t = replaceOnce(
    t,
    C014_FZI_RETURN_LINE,
    C014_FZI_RETURN_LINE + C014_FZI_EFFECT,
    "c014:restore stored pair for empty local views"
  );
  t = replaceOnce(
    t,
    C014_U_SCOPE_ANCHOR,
    C014_U_SCOPE_REPLACEMENT,
    "c014:_U read native local host key"
  );
  t = replaceOnce(
    t,
    C014_U_SETTER_ANCHOR,
    C014_U_SETTER_REPLACEMENT,
    "c014:_U scope ordinary-home persistence to Yf atom"
  );
  return t;
}

function applyModelTransforms(file, baselineText) {
  if (file === "out/extension.js") return transformHost(baselineText);
  if (file === "webview/assets/app-initial-c014f9ee4429.js") return transformC014(baselineText);
  return baselineText;
}

// ---------------------------------------------------------------------------
// Evaluate the pure model core in an isolated scope for tests / self-checks.
// The caller injects fake cR() and __companionNormalizedRoots bindings.
// ---------------------------------------------------------------------------

function evaluateModelCore(coreSource) {
  const src = (coreSource === undefined ? loadModelCoreSource() : coreSource) +
    "\nreturn {__companionModelStoreKey:__companionModelStoreKey,__companionModelValidatePair:__companionModelValidatePair,__companionModelHash:__companionModelHash,__companionModelProjectKey:__companionModelProjectKey,__companionModelNormalizeStored:__companionModelNormalizeStored,__companionModelWrite:__companionModelWrite,__companionWorkflowGetProjectModel:__companionWorkflowGetProjectModel};";
  return new Function("cR", "__companionNormalizedRoots", src);
}

module.exports = {
  loadModelCoreSource,
  applyModelTransforms,
  transformHost,
  transformC014,
  evaluateModelCore,
  PATCHED_FILES,
  MODEL_HOST_GLUE,
  MODEL_RENDERER_GLUE,
  HOST_TKE_ANCHOR,
  HOST_VIEW_FOCUSED_ANCHOR,
  C014_FZI_LINE1,
  C014_FZI_DRAFT_LINE,
  C014_FZI_RETURN_LINE,
  C014_J_FN,
  C014_N_FN,
  C014_FZI_CELL_INIT,
  C014_FZI_CELL_UPDATE,
  C014_FZI_EFFECT,
  C014_FZI_RESTORE_CATALOG,
  C014_FZI_REQUEST_EFFECT,
  C014_FZI_APPLY_EFFECT,
  C014_U_SCOPE_ANCHOR,
  C014_U_SETTER_ANCHOR,
};
