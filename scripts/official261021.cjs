"use strict";
/*
 * Pure new-version adapter for Codex Companion 0.2.4 / official OpenAI
 * 26.1021.22027. Separate from the old 26.1007 transforms. Reuses the accepted
 * old helper runtimes from resources/ read-only and rewrites ONLY payload
 * aliases that changed in the new host: cR->fv (roots), je->Be (vscode),
 * TKe->jje (truncate), RKe->Vje (native fallback title, in the new title glue).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PUBLISHER = "openai";
const NAME = "chatgpt";
const SUPPORTED_VERSION = "26.1021.22027";
const MANIFEST_SCHEMA = 3;

const HOST = "out/extension.js";
const SRC_622B = "webview/assets/src-622b307a9baf.js";
const INIT_SERVICES =
  "webview/assets/initialize-app-host-services.extension-f722db488e05.js";
const CONVERSATION_PAGE =
  "webview/assets/local-conversation-page-e49199d4fdb5.js";
const MESSAGE_BUS = "webview/assets/message-bus-4113ba7287d7.js";
const MODEL_SETTINGS =
  "webview/assets/use-model-settings-aafcff4b111c.js";
const COMPOSER_CONTENT = "webview/assets/composer-content-8ab21f1a1982.js";
const COMPOSER_SCOPE = "webview/assets/composer-scope-f0dbf0e746b6.js";

const FILES = Object.freeze([
  "package.json",
  HOST,
  SRC_622B,
  INIT_SERVICES,
  CONVERSATION_PAGE,
  MESSAGE_BUS,
  MODEL_SETTINGS,
  COMPOSER_CONTENT,
  COMPOSER_SCOPE,
]);

const ORIGINAL_HASHES = Object.freeze({
  "package.json":
    "35198adfbce5e74047dfe4ce9a5b1e987e745415ef6e1cdc5a9fef2b759dc520",
  [HOST]:
    "a9cc6736cd2c2d22f6cf43fc5763d5f8a873e4f741f522b44a600b1926f4e627",
  [SRC_622B]:
    "e4a82a9ee669473490d25c1f2b6f7b60abc4a1b193acb1f9c0a92e074dc81eb5",
  [INIT_SERVICES]:
    "7d62f3e00516acd50693610d449cdc92e25a4599a18ab2e9353f8ab537777d1c",
  [CONVERSATION_PAGE]:
    "c3c836af38901935a6b1d8fe41dbcd0419c602a35b4d099338d862ab8c8e069a",
  [MESSAGE_BUS]:
    "9536ce9674179537acc6ecb09a74a01af08b203f4eb812851ea05182311c3ff0",
  [MODEL_SETTINGS]:
    "23d2322fe24ae6d151e2fef55108942be50ca8b38aacd52e5102143bb2d1b47e",
  [COMPOSER_CONTENT]:
    "a4fbed28d7fbc35c755690023da6eba1ca656719bd2823a95684e47cfbdd3d01",
  [COMPOSER_SCOPE]:
    "02fe29bd8b1da9a86c6c39a95f69af9b60a8c76c37535ecd5e0b92fbc45243fd",
});

const STAGES = Object.freeze([
  "original",
  "history",
  "titles",
  "workflow",
  "drafts",
]);

const FEATURES = Object.freeze([
  { id: "project-history", stage: "history", files: [HOST, SRC_622B, INIT_SERVICES] },
  { id: "startup-watchdog", stage: "history", files: [HOST] },
  { id: "native-tab-titles", stage: "titles", files: [HOST, CONVERSATION_PAGE, MESSAGE_BUS] },
  { id: "project-model", stage: "workflow", files: [HOST, MODEL_SETTINGS, COMPOSER_CONTENT] },
  { id: "tab-status", stage: "workflow", files: [HOST] },
  { id: "workflow-notifications", stage: "workflow", files: [HOST] },
  { id: "independent-drafts", stage: "drafts", files: [COMPOSER_SCOPE] },
]);

function resourcesDir() {
  return path.join(__dirname, "..", "resources");
}

function resourceSource(name) {
  return fs.readFileSync(path.join(resourcesDir(), name), "utf8");
}

function historyFilterSource() {
  return resourceSource("officialHistoryFilter.js");
}

function startupWatchdogSource() {
  return resourceSource("officialStartupWatchdog.js");
}

function tabTitlesSource() {
  return resourceSource("officialTabTitles.js");
}

function draftIsolationSource() {
  return resourceSource("officialDraftIsolation.js");
}

function rewriteAliases(source, aliases) {
  let out = source;
  for (const from of Object.keys(aliases)) {
    const to = aliases[from];
    out = out.replace(new RegExp("\\b" + from + "\\b", "g"), to);
  }
  return out;
}

function statusCoreSource() {
  // Keep the 26.1007 runtime and its guarded upgrade stages byte-identical.
  return rewriteAliases(resourceSource("officialTabStatusV2.js"), {
    cR: "fv",
    je: "Be",
    TKe: "jje",
  });
}

function modelCoreSource() {
  return rewriteAliases(resourceSource("officialProjectModel.js"), {
    cR: "fv",
  });
}

function sha256(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function replaceOnce(text, needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error("anchor not found: " + label);
  if (text.indexOf(needle, index + needle.length) !== -1) {
    throw new Error("anchor not unique: " + label);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

function prepend(text, block) {
  return block + text;
}

function lines(parts) {
  return parts.join("\n");
}

const HISTORY_HOST_GLUE = lines([
  "function __companionHistoryRoots(){try{return fv()}catch(e){return []}}",
  'function __companionIsHistoryMethod(m){return m==="thread/list"||m==="thread/search"}',
  "function __companionFilterHistoryResult(method,result){",
  '  if(!result||typeof result!=="object"||!Array.isArray(result.data))return result;',
  "  var roots=__companionHistoryRoots()||[];",
  "  var rn=__companionNormalizedRoots(roots);",
  "  var out;",
  "  if(rn.length===0){out=Object.assign({},result,{data:[],nextCursor:null});}",
  "  else{out=Object.assign({},result,{data:__companionFilterRows(result.data,rn)});}",
  '  if(method==="thread/list"){out.__companionScope={roots:Array.isArray(roots)?roots.slice():[],normalized:rn.slice()};}',
  "  return out;",
  "}",
]);

const BROWSER_GLUE = lines([
  "function __companionBrowserSetScopeFromResult(a,hostId){",
  '  if(hostId!=="local")return;',
  '  var scope=a&&typeof a==="object"?a.__companionScope:null;',
  '  if(!scope||typeof scope!=="object"||!Array.isArray(scope.roots))return;',
  "  globalThis.__companionHistoryScope={hostId:hostId,roots:scope.roots.slice(),normalized:__companionNormalizedRoots(scope.roots)};",
  "}",
  "function __companionBrowserSetScopeFromMessage(msg){",
  '  if(!msg||typeof msg!=="object")return;',
  "  var hostId=msg.hostId;",
  "  var roots=Array.isArray(msg.roots)?msg.roots.slice():[];",
  "  globalThis.__companionHistoryScope={hostId:hostId,roots:roots,normalized:__companionNormalizedRoots(roots)};",
  "}",
  "function __companionBrowserRoots(hostId){",
  '  if(hostId!=="local")return null;',
  "  var scope=globalThis.__companionHistoryScope;",
  '  if(!scope||scope.hostId!=="local")return undefined;',
  "  return scope.normalized||[];",
  "}",
  "function __companionBrowserFilterRows(data,hostId){",
  '  if(hostId!=="local")return data;',
  "  var roots=__companionBrowserRoots(hostId);",
  "  if(roots===undefined||roots===null)return [];",
  "  return __companionFilterRows(data,roots);",
  "}",
  "function __companionShouldSurface(cwd,hostId){",
  '  if(hostId!=="local")return true;',
  "  var roots=__companionBrowserRoots(hostId);",
  "  if(roots===undefined||roots===null)return false;",
  "  return __companionCwdMatchesRoots(cwd,roots);",
  "}",
]);

const TITLE_HOST_GLUE = lines([
  "function __companionTabTitleRecord(provider,panel){",
  "  if(provider==null||panel==null||provider.editorPanels==null)return null;",
  "  var rec=provider.editorPanels.get(panel);",
  '  return rec!=null&&typeof rec==="object"?rec:null;',
  "}",
  "function __companionIsSpecializedPanel(provider,panel){",
  "  if(provider==null||panel==null)return false;",
  "  var d=provider.diffPanel,p=provider.planSummaryPanel,s=provider.settingsPanel;",
  "  return (d!=null&&(d===panel||d.currentPanel===panel))||(p!=null&&(p===panel||p.currentPanel===panel))||(s!=null&&(s===panel||s.currentPanel===panel));",
  "}",
  "function __companionApplyCompanionTabTitle(provider,webview,message){",
  "  if(provider==null||webview==null)return false;",
  "  var panel=provider.findPanelByWebview(webview);",
  "  if(panel==null||!provider.isPanelAlive(panel)||__companionIsSpecializedPanel(provider,panel))return false;",
  "  var rec=__companionTabTitleRecord(provider,panel);",
  "  if(rec==null)return false;",
  '  var parsed=__companionTabTitlePayload(message,"/local/");',
  "  if(parsed!=null&&parsed.reset!==true){",
  "    try{panel.title=jje(parsed.title)}catch(e){return false;}",
  "    rec.__companionTitleSeen=true;",
  "    rec.__companionTitleActive=true;",
  "    rec.__companionTitleThreadId=parsed.threadId;",
  "    rec.__companionTitleRoute=parsed.route;",
  "    rec.__companionTitleText=parsed.title;",
  "    return true;",
  "  }",
  "  if(rec.__companionTitleActive===true){",
  "    try{panel.title=Vje}catch(e){return false;}",
  "    rec.__companionTitleActive=false;",
  "    rec.__companionTitleThreadId=null;",
  "    rec.__companionTitleRoute=null;",
  "    rec.__companionTitleText=null;",
  "    return true;",
  "  }",
  "  return false;",
  "}",
  "function __companionShouldApplyPreviewTitle(provider,panel){",
  "  var rec=__companionTabTitleRecord(provider,panel);",
  "  return rec==null||rec.__companionTitleSeen!==true;",
  "}",
]);

const MODEL_HOST_GLUE = lines([
  "function __companionModelIsLocalChatPanel(provider,webview){",
  "  if(provider==null||webview==null)return false;",
  "  var panel;",
  "  try{panel=provider.findPanelByWebview(webview)}catch(e){return false}",
  "  if(panel==null)return false;",
  "  try{if(!provider.isPanelAlive(panel))return false}catch(e){return false}",
  '  try{if(typeof __companionIsSpecializedPanel==="function"&&__companionIsSpecializedPanel(provider,panel))return false}catch(e){}',
  "  return true;",
  "}",
  "async function __companionModelHandleRequest(provider,webview,message){",
  "  try{",
  "    if(!__companionModelIsLocalChatPanel(provider,webview))return;",
  '    if(message==null||typeof message!=="object"||message.hostId!=="local")return;',
  '    var requestId=message!=null&&typeof message==="object"&&typeof message.requestId==="string"?message.requestId:null;',
  "    if(requestId==null)return;",
  "    var ctx=provider&&provider.__companionWorkflowContext;",
  "    var ws=ctx&&ctx.workspaceState;",
  '    if(ws==null||typeof ws!=="object"||typeof ws.get!=="function"||typeof ws.update!=="function"){',
  '      provider.postMessageToWebview(webview,{type:"companion-project-model",requestId:requestId,pending:true});',
  "      return;",
  "    }",
  "    var projectKey=__companionModelProjectKey(__companionHistoryRoots());",
  "    var pair=await __companionWorkflowGetProjectModel(provider);",
  "    if(pair==null){",
  '      provider.postMessageToWebview(webview,{type:"companion-project-model",requestId:requestId,projectKey:projectKey,valid:false});',
  "      return;",
  "    }",
  '    provider.postMessageToWebview(webview,{type:"companion-project-model",requestId:requestId,projectKey:projectKey,valid:true,model:pair.model,effort:pair.effort});',
  "  }catch(e){}",
  "}",
  "async function __companionModelHandleSelected(provider,webview,message){",
  "  try{",
  "    if(!__companionModelIsLocalChatPanel(provider,webview))return;",
  '    if(message==null||typeof message!=="object"||message.hostId!=="local")return;',
  "    var pair=__companionModelValidatePair(message.model,message.effort);",
  "    if(pair==null)return;",
  "    var roots;",
  "    try{roots=fv()}catch(e){roots=[]}",
  "    var key=__companionModelProjectKey(roots);",
  "    if(key==null)return;",
  '    if(typeof message.projectKey==="string"&&message.projectKey!==key)return;',
  "    var ctx=provider&&provider.__companionWorkflowContext;",
  "    var ws=ctx&&ctx.workspaceState;",
  '    if(ws==null||typeof ws!=="object"||typeof ws.get!=="function"||typeof ws.update!=="function")return;',
  "    await __companionModelWrite(provider,pair,message.intentAt);",
  "  }catch(e){}",
  "}",
]);

function modelWebviewSource() { return resourceSource("officialModel261021.js"); }

// ---------------------------------------------------------------------------
// Anchors (exact snippets; never whole lines)
// ---------------------------------------------------------------------------

const ANCHOR_WATCHDOG_CLASS =
  'var K2=class{constructor(e){this.onTimeout=e}timeout;disposed=!1;receivedWebviewMessage=!1;start(){if(this.disposed||this.timeout!=null)return;let e=Date.now();this.timeout=setTimeout(()=>{this.timeout=void 0,this.onTimeout({elapsedMs:Date.now()-e,receivedWebviewMessage:this.receivedWebviewMessage,timeoutMs:3e4})},3e4)}markMessageReceived(){this.receivedWebviewMessage=!0}handleStartupPhase(e){e==="renderer_ready"&&this.dispose()}dispose(){this.disposed=!0,this.timeout!=null&&(clearTimeout(this.timeout),this.timeout=void 0)}};';

const ANCHOR_STARTUP_BIND =
  "this.subscriptions.push(a,n(()=>{s.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=await this.getWebviewContent(e),s.start()";

const ANCHOR_ROOTS_FV =
  'function fv(){let t=iWe.workspace.workspaceFolders?.filter(({uri:r})=>(r.fsPath!=="/"||r.scheme==="file"||r.scheme==="vscode-remote")&&ng(r.fsPath)).map(({uri:r})=>r.fsPath)??[];return qr()?t.map(ir):t}';

const ANCHOR_MCP_REQUEST =
  "let{id:n,method:o,params:i}=r.request;this.pendingMcpRequests.set(String(n),e),this.codexMcpConnection.sendRequest(ZR,String(n),o,i,r.retainResponse);break}";

const ANCHOR_MCP_RESPONSE =
  'this.pendingMcpRequests.delete(r),this.chunkedMessageSender.send(n,{type:"mcp-response",hostId:"local",message:{id:e.id,result:e.result,error:e.error}})}';

const ANCHOR_ABANDON =
  'case"mcp-request-abandon":{this.pendingMcpRequests.delete(String(r.requestId)),this.codexMcpConnection.abandonRequest(ZR,String(r.requestId));break}';

const ANCHOR_DELIVERY =
  'onRequestDelivery:X=>{let ye=String(X.delivery.requestId),Ce=this.pendingMcpRequests.get(ye);Ce!=null&&(X.type==="failed"&&this.pendingMcpRequests.delete(ye),this.postMessageToWebview(Ce,{type:"mcp-request-delivery",hostId:"local",update:X}))}';

const ANCHOR_CLEAR_PENDING =
  "clearPendingRequestsForWebview(e){if(e)for(let[r,n]of this.pendingMcpRequests.entries())n===e&&(this.pendingMcpRequests.delete(r),this.codexMcpConnection.abandonRequest(ZR,r))}";

const ANCHOR_WORKSPACE_FOLDERS =
  'this.subscriptions.push(Be.workspace.onDidChangeWorkspaceFolders(()=>{this.broadcastToAllViews({type:"global-state-updated",keys:[Q.LOCAL_PROJECTS,Q.SELECTED_PROJECT]})}))';

const ANCHOR_JJE =
  'function jje(t){return t?t.length>Wje?t.substring(0,Wje)+"\\u2026":t:Vje}';

const ANCHOR_VIEW_FOCUSED =
  'case"view-focused":{this.setFocusedViewForWebview(e);break}';

const ANCHOR_PREVIEW_TITLE = "this.isPanelAlive(r)&&(r.title=jje(c))";

const ANCHOR_RAW_NOTIFICATION =
  'onRawNotification:X=>{let{method:ye,params:Ce}=X;this.broadcastToAllViews({type:"mcp-notification",hostId:"local",method:ye,params:Ce})}';

const ANCHOR_ON_REQUEST =
  'onRequest:X=>{this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:X})}';

const ANCHOR_INSTALL =
  "mt=new cN(Se=>$e.reportAppEntryReceipt(Se),Ot.window.state.focused)";

const ANCHOR_STATUS_CORE =
  "function __companionShouldApplyPreviewTitle(provider,panel){\n" +
  "  var rec=__companionTabTitleRecord(provider,panel);\n" +
  "  return rec==null||rec.__companionTitleSeen!==true;\n" +
  "}";

const ANCHOR_TITLE_BIND =
  'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);break}';

const ANCHOR_SRC_RETURN = "return{...a,data:a.data.filter(td)}}";

const ANCHOR_SURFACE_RECENT =
  "shouldSurfaceRecentConversation(e){return!this.isConversationSuppressed(e.id)&&e.ephemeral!==!0&&e.sideConversation!==!0&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||gd(e,this.params.hostId))}";

const ANCHOR_SURFACE_SUMMARY =
  "shouldSurfaceThreadSummary(e){return!this.isConversationSuppressed(e.conversationId)&&this.conversations.get(e.conversationId)?.sideConversation!==!0&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||gd(e,this.params.hostId))}";

const ANCHOR_INVALIDATE_SEARCH =
  "case`invalidate-thread-search`:MD(c,e.hostId),c.invalidateQueries({queryKey:[`archived-threads`,e.hostId]});break;";

const ANCHOR_BUS_CONSTRUCTOR =
  "constructor(){this.dispatchMessage=this.dispatchMessage.bind(this),this.startWindowMessageListener()}";

const ANCHOR_PAGE_ROUTE = "tr=cn(),nr=tr.state;";

const ANCHOR_CC_RESTORE = ",QR.default).slice(0,3),_e;";

const ANCHOR_SCOPE_HOME =
  "case`home`:return e.homeDraftKey??e.draftThreadLocationId??(e.gptId==null?p({entrypoint:`home`}):`gpt-draft:${e.gptId}`);";

// ---------------------------------------------------------------------------
// Stage transforms
// ---------------------------------------------------------------------------

function transformHistoryHost(text) {
  let t = text;
  t = replaceOnce(
    t,
    ANCHOR_WATCHDOG_CLASS,
    startupWatchdogSource() + "var K2=__companionStartupWatchdog;",
    "extension.js:visibility-aware startup watchdog"
  );
  t = replaceOnce(
    t,
    ANCHOR_STARTUP_BIND,
    'let b=__companionBindStartupVisibility(s,r==="panel"?this.findPanelByWebview(e):void 0);b&&this.subscriptions.push(b),' +
      "this.subscriptions.push(a,n(()=>{s.dispose(),b?.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=await this.getWebviewContent(e),s.start()",
    "extension.js:bind panel startup watchdog to visibility"
  );
  t = replaceOnce(
    t,
    ANCHOR_ROOTS_FV,
    ANCHOR_ROOTS_FV + ";" + historyFilterSource() + HISTORY_HOST_GLUE,
    "extension.js:inject history helpers after roots function"
  );
  t = replaceOnce(
    t,
    ANCHOR_MCP_REQUEST,
    "let{id:n,method:o,params:i}=r.request;this.pendingMcpRequests.set(String(n),e),__companionIsHistoryMethod(o)&&((this.__companionHistoryRequests??=new Map).set(String(n),{method:o,webview:e})),this.codexMcpConnection.sendRequest(ZR,String(n),o,i,r.retainResponse);break}",
    "extension.js:record list/search request id"
  );
  t = replaceOnce(
    t,
    ANCHOR_MCP_RESPONSE,
    "this.pendingMcpRequests.delete(r);var m=this.__companionHistoryRequests?.get(r);this.__companionHistoryRequests?.delete(r);this.chunkedMessageSender.send(n,{type:\"mcp-response\",hostId:\"local\",message:{id:e.id,result:m?__companionFilterHistoryResult(m.method,e.result):e.result,error:e.error}})}",
    "extension.js:filter mcp response by history method"
  );
  t = replaceOnce(
    t,
    ANCHOR_ABANDON,
    'case"mcp-request-abandon":{this.pendingMcpRequests.delete(String(r.requestId)),this.__companionHistoryRequests?.delete(String(r.requestId)),this.codexMcpConnection.abandonRequest(ZR,String(r.requestId));break}',
    "extension.js:clear side map on abandon"
  );
  t = replaceOnce(
    t,
    ANCHOR_DELIVERY,
    'onRequestDelivery:X=>{let ye=String(X.delivery.requestId),Ce=this.pendingMcpRequests.get(ye);Ce!=null&&(X.type==="failed"&&(this.pendingMcpRequests.delete(ye),this.__companionHistoryRequests?.delete(ye)),this.postMessageToWebview(Ce,{type:"mcp-request-delivery",hostId:"local",update:X}))}',
    "extension.js:clear side map on failed delivery"
  );
  t = replaceOnce(
    t,
    ANCHOR_CLEAR_PENDING,
    "clearPendingRequestsForWebview(e){if(e){for(let[r,n]of this.pendingMcpRequests.entries())n===e&&(this.pendingMcpRequests.delete(r),this.codexMcpConnection.abandonRequest(ZR,r));if(this.__companionHistoryRequests)for(let[r,n]of this.__companionHistoryRequests.entries())n.webview===e&&this.__companionHistoryRequests.delete(r)}}",
    "extension.js:clear side map on webview dispose"
  );
  t = replaceOnce(
    t,
    ANCHOR_WORKSPACE_FOLDERS,
    'this.subscriptions.push(Be.workspace.onDidChangeWorkspaceFolders(()=>{this.broadcastToAllViews({type:"global-state-updated",keys:[Q.LOCAL_PROJECTS,Q.SELECTED_PROJECT]}),this.broadcastToAllViews({type:"companion-history-scope-changed",hostId:"local",roots:__companionHistoryRoots()})}))',
    "extension.js:broadcast scope change on workspace folders change"
  );
  return t;
}

function transformHistorySrc(text) {
  let t = prepend(text, historyFilterSource() + BROWSER_GLUE);
  t = replaceOnce(
    t,
    ANCHOR_SRC_RETURN,
    "__companionBrowserSetScopeFromResult(a,this.params.hostId);return{...a,data:__companionBrowserFilterRows(a.data.filter(td),this.params.hostId)}}",
    "src-622b:set scope and filter listRecentThreads"
  );
  t = replaceOnce(
    t,
    ANCHOR_SURFACE_RECENT,
    "shouldSurfaceRecentConversation(e){return!this.isConversationSuppressed(e.id)&&e.ephemeral!==!0&&e.sideConversation!==!0&&__companionShouldSurface(e.cwd,this.params.hostId)&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||gd(e,this.params.hostId))}",
    "src-622b:gate shouldSurfaceRecentConversation on scope"
  );
  t = replaceOnce(
    t,
    ANCHOR_SURFACE_SUMMARY,
    "shouldSurfaceThreadSummary(e){return!this.isConversationSuppressed(e.conversationId)&&this.conversations.get(e.conversationId)?.sideConversation!==!0&&__companionShouldSurface(e.cwd,this.params.hostId)&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||gd(e,this.params.hostId))}",
    "src-622b:gate shouldSurfaceThreadSummary on scope"
  );
  return t;
}

function transformHistoryInit(text) {
  let t = prepend(text, historyFilterSource() + BROWSER_GLUE);
  t = replaceOnce(
    t,
    ANCHOR_INVALIDATE_SEARCH,
    "case`invalidate-thread-search`:MD(c,e.hostId),c.invalidateQueries({queryKey:[`archived-threads`,e.hostId]});break;" +
      "case`companion-history-scope-changed`:__companionBrowserSetScopeFromMessage(e),c.invalidateQueries({queryKey:[`archived-threads`,e.hostId]}),MD(c,e.hostId),e.hostId===`local`&&wn(t,e.hostId).refreshRecentConversations({mode:`expanded`}).catch(()=>{});break;",
    "init:handle companion-history-scope-changed"
  );
  return t;
}

function transformTitlesHost(text) {
  for (const marker of ["__companionStartupWatchdog", "__companionHistoryRoots", "companion-history-scope-changed"]) {
    if (!text.includes(marker)) {
      throw new Error("extension.js: accepted history baseline is missing " + marker);
    }
  }
  if (text.includes('case"companion-tab-title"')) {
    throw new Error("extension.js: title patch is already present");
  }
  let t = text;
  t = replaceOnce(
    t,
    ANCHOR_JJE,
    ANCHOR_JJE + "\n" + tabTitlesSource() + "\n" + TITLE_HOST_GLUE,
    "extension.js:inject title helpers after jje"
  );
  t = replaceOnce(
    t,
    ANCHOR_VIEW_FOCUSED,
    'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);break}' + ANCHOR_VIEW_FOCUSED,
    "extension.js:handle companion-tab-title"
  );
  t = replaceOnce(
    t,
    ANCHOR_PREVIEW_TITLE,
    "this.isPanelAlive(r)&&__companionShouldApplyPreviewTitle(this,r)&&(r.title=jje(c))",
    "extension.js:guard stale preview title"
  );
  return t;
}

function transformTitlesPage(text) {
  const imports = 'import{r as __companionLocalTitleAtom,t as __companionLocalTitleInit}from"./local-conversation-title-signals-681ec1e35f50.js";\n';
  const anchor = "u=y(De,c),d;";
  const effect =
    "__companionLocalTitleInit();var __companionTitleText=y(__companionLocalTitleAtom,a);" +
    "(0,Q.useEffect)(function(){var host=l??u,route=c==null?null:\"/local/\"+c;var valid=host===\"local\"&&typeof a===\"string\"&&typeof __companionTitleText===\"string\"&&__companionTitleText.trim().length>0&&route!=null;" +
    "try{globalThis.__companionDispatch?.(\"companion-tab-title\",{threadId:valid?a:null,hostId:valid?host:null,title:valid?__companionTitleText:null,route:route,routeThreadId:c,reset:!valid})}catch(e){}" +
    "return function(){try{globalThis.__companionDispatch?.(\"companion-tab-title\",{reset:true})}catch(e){}};},[a,c,l,u,__companionTitleText]);";
  return imports + replaceOnce(text, anchor, anchor + effect, "local conversation page: report authoritative local title");
}

function transformTitlesBus(text) {
  if (text.includes("__companionDispatch")) {
    throw new Error("message-bus: dispatch bridge is already present");
  }
  return replaceOnce(
    text,
    ANCHOR_BUS_CONSTRUCTOR,
    "constructor(){this.dispatchMessage=this.dispatchMessage.bind(this),this.startWindowMessageListener();var __companionSelf=this;globalThis.__companionDispatch=function(e,t){try{__companionSelf.dispatchMessage(e,t)}catch(r){}};globalThis.__companionSubscribe=function(e,t){try{return __companionSelf.subscribe(e,t)}catch(r){return function(){}}}}",
    "message-bus:expose companion dispatch/subscribe bridge"
  );
}

function transformWorkflowHost(text) {
  for (const marker of [
    "__companionStartupWatchdog",
    "__companionHistoryRoots",
    "__companionNormalizedRoots",
    "__companionTabTitlePayload",
    'case"companion-tab-title"',
    "__companionShouldApplyPreviewTitle",
  ]) {
    if (!text.includes(marker)) {
      throw new Error("extension.js: accepted history+title baseline is missing " + marker);
    }
  }
  if (text.includes("__companionWorkflowRuntime")) {
    throw new Error("extension.js: status patch is already present");
  }
  if (text.includes("companion-project-model")) {
    throw new Error("extension.js: model patch is already present");
  }
  let t = text;
  t = replaceOnce(
    t,
    ANCHOR_STATUS_CORE,
    ANCHOR_STATUS_CORE + "\n" + statusCoreSource(),
    "extension.js:inject status runtime after title glue"
  );
  t = replaceOnce(
    t,
    ANCHOR_TITLE_BIND,
    'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);try{__companionWorkflowBindTitle(this,e)}catch(_e){}break}',
    "extension.js:reconcile title after native apply"
  );
  t = replaceOnce(
    t,
    ANCHOR_RAW_NOTIFICATION,
    'onRawNotification:X=>{let{method:ye,params:Ce}=X;try{__companionWorkflowNotification(this,X)}catch(_e){}this.broadcastToAllViews({type:"mcp-notification",hostId:"local",method:ye,params:Ce})}',
    "extension.js:observe raw notification before broadcast"
  );
  t = replaceOnce(
    t,
    ANCHOR_ON_REQUEST,
    'onRequest:X=>{try{__companionWorkflowRequest(this,X)}catch(_e){}this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:X})}',
    "extension.js:observe server requests before broadcast"
  );
  t = replaceOnce(
    t,
    ANCHOR_INSTALL,
    "__companionWorkflowInstall($e,t)," + ANCHOR_INSTALL,
    "extension.js:capture provider and ExtensionContext"
  );
  t = replaceOnce(
    t,
    ANCHOR_JJE,
    ANCHOR_JJE + "\n" + modelCoreSource() + "\n" + MODEL_HOST_GLUE,
    "extension.js:inject model helpers after jje"
  );
  t = replaceOnce(
    t,
    ANCHOR_VIEW_FOCUSED,
    'case"companion-project-model-request":{__companionModelHandleRequest(this,e,r);break}' +
      'case"companion-project-model-selected":{__companionModelHandleSelected(this,e,r);break}' +
      ANCHOR_VIEW_FOCUSED,
    "extension.js:handle companion-project-model messages"
  );
  return t;
}

function transformWorkflowSettings(text) {
  let t = prepend(text, modelWebviewSource() + "\n");
  t = replaceOnce(t, "l=ee(O),u=r==null,d;", "l=ee(O),u=r==null,d;let __companionHost=Oe(r),__companionModelCell=(0,Rt.useRef)(null);", "model settings: invocation context ref");
  t = replaceOnce(t, "let S=x,C;", "let S=x,C;__companionModelCell.current={conversationId:r,hostId:h.hostId};", "model settings: refresh invocation context");
  t = replaceOnce(t, "setModelAndReasoningEffortForNextTurn:C,setModelAndReasoningEffort:S}", "setModelAndReasoningEffortForNextTurn:C,setModelAndReasoningEffort:__companionModelWrapSet(S,__companionModelCell)}", "model settings: track every native choice");
  t = replaceOnce(t, "let i=g&&e===`gpt-reserve`?b:e,a=_&&n?.persistAsDefault===!1;", "let i=g&&e===`gpt-reserve`?b:e;if(r==null&&__companionHost.hostId===\"local\"&&n?.persistAsDefault===!1&&!p){let __companionKey=Ye({conversationId:null,hasConversation:!1,hostId:__companionHost.hostId,cwd:__companionHost.cwd}),__companionPrevious=l.get(Qe,__companionKey),__companionTier=n?.serviceTier===void 0?__companionPrevious?.serviceTier:n.serviceTier;if(n?.serviceTier!==void 0)l.set(qe,{hostId:h.hostId,conversationId:r},null);l.set(Qe,__companionKey,{model:i,reasoningEffort:t,serviceTier:__companionTier});await N(l,h.hostId).clearPrewarmedThreads();return!0}let a=_&&n?.persistAsDefault===!1;", "model settings: ordinary home local optimistic preference");
  return t;
}

function transformWorkflowComposerContent(text) {
  if (text.includes("companion-project-model")) {
    throw new Error("composer-content: model patch is already present");
  }
  let t = prepend(text, modelWebviewSource() + "\n");
  const effect =
    "var __companionRestoreCell=(0,ez.useRef)(null);__companionRestoreCell.current={conversationId:n,hostId:d,managedDraft:U,locked:te?.isModelLocked===true,catalog:B,status:re,settings:I,selection:F};" +
    "(0,ez.useEffect)(function(){return __companionModelRestoreStart(__companionRestoreCell)},[n,d,te?.isModelLocked===true,l.cwd]);" +
    "(0,ez.useEffect)(function(){__companionModelApplyCurrent()},[n,d,U,B,I,F,re]);";
  t = replaceOnce(
    t,
    ANCHOR_CC_RESTORE,
    ANCHOR_CC_RESTORE + effect,
    "composer-content:restore stored model pair for empty local views"
  );
  return t;
}

function transformDraftsScope(text) {
  if (text.includes("__companionDraftIsolation") || text.includes("companion-draft-isolation-v1")) {
    throw new Error("composer-scope: draft isolation is already present");
  }
  const helper = draftIsolationSource();
  if (typeof helper !== "string" || helper.length === 0) {
    throw new Error("draft isolation helper source is empty");
  }
  let t = "/* companion-draft-isolation-v1 */\n" + helper.replace(/\s+$/, "") + "\n" + text;
  t = replaceOnce(
    t,
    ANCHOR_SCOPE_HOME,
    "case`home`:return __companionDraftIsolation.scopeKey(e.homeDraftKey??e.draftThreadLocationId??(e.gptId==null?p({entrypoint:`home`}):`gpt-draft:${e.gptId}`));",
    "composer-scope:scope native home draft key"
  );
  return t;
}

function applyHistory(file, text) {
  if (file === HOST) return transformHistoryHost(text);
  if (file === SRC_622B) return transformHistorySrc(text);
  if (file === INIT_SERVICES) return transformHistoryInit(text);
  return text;
}

function applyTitles(file, text) {
  if (file === HOST) return transformTitlesHost(text);
  if (file === CONVERSATION_PAGE) return transformTitlesPage(text);
  if (file === MESSAGE_BUS) return transformTitlesBus(text);
  return text;
}

function applyWorkflow(file, text) {
  if (file === HOST) return transformWorkflowHost(text);
  if (file === MODEL_SETTINGS) return transformWorkflowSettings(text);
  if (file === COMPOSER_CONTENT) return transformWorkflowComposerContent(text);
  return text;
}

function applyDrafts(file, text) {
  if (file === COMPOSER_SCOPE) return transformDraftsScope(text);
  return text;
}

function transformStage(file, text, stage) {
  if (!FILES.includes(file)) throw new Error("unknown file: " + file);
  if (!STAGES.includes(stage)) throw new Error("unknown stage: " + stage);
  if (typeof text !== "string") throw new Error("text must be a string");
  if (stage === "original") return text;
  if (stage === "history") return applyHistory(file, text);
  if (stage === "titles") return applyTitles(file, text);
  if (stage === "workflow") return applyWorkflow(file, text);
  if (stage === "drafts") return applyDrafts(file, text);
  throw new Error("unknown stage: " + stage);
}

function applyAllStages(file, originalText) {
  let text = originalText;
  for (const stage of ["history", "titles", "workflow", "drafts"]) {
    text = transformStage(file, text, stage);
  }
  return text;
}

function readOriginal(originalDir, rel) {
  const abs = path.join(originalDir, ...rel.split("/"));
  if (!fs.existsSync(abs)) throw new Error("original fixture is missing " + rel + ": " + abs);
  return fs.readFileSync(abs);
}

function verifyOriginals(originalDir) {
  const dir = path.resolve(originalDir);
  const result = {};
  for (const rel of FILES) {
    const buf = readOriginal(dir, rel);
    const hash = sha256(buf);
    const expected = ORIGINAL_HASHES[rel];
    if (hash !== expected) {
      throw new Error(
        "original fixture " + rel + " has unknown bytes (" + hash + "); expected " + expected
      );
    }
    result[rel] = buf;
  }
  return result;
}

function buildManifest(originalDir) {
  const originals = verifyOriginals(originalDir);
  const stages = Object.fromEntries(STAGES.map((stage) => [stage, {}]));
  for (const rel of FILES) {
    const originalText = originals[rel].toString("utf8");
    const texts = { original: originalText };
    let current = originalText;
    for (const stage of ["history", "titles", "workflow", "drafts"]) {
      current = transformStage(rel, current, stage);
      texts[stage] = current;
    }
    for (const stage of STAGES) {
      stages[stage][rel] = sha256(Buffer.from(texts[stage], "utf8"));
    }
  }
  return {
    schema: MANIFEST_SCHEMA,
    officialVersion: SUPPORTED_VERSION,
    publisher: PUBLISHER,
    name: NAME,
    files: [...FILES],
    stages,
    features: FEATURES.map((f) => ({ id: f.id, stage: f.stage, files: [...f.files] })),
  };
}

function buildAttestation(manifest) {
  if (manifest == null || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  if (manifest.schema !== MANIFEST_SCHEMA) {
    throw new Error("manifest schema must be " + MANIFEST_SCHEMA);
  }
  if (manifest.officialVersion !== SUPPORTED_VERSION) {
    throw new Error("manifest officialVersion must be " + SUPPORTED_VERSION);
  }
  const latest = manifest.stages && manifest.stages.drafts;
  if (latest == null || typeof latest !== "object") {
    throw new Error("manifest is missing the final drafts stage hashes");
  }
  return {
    schema: MANIFEST_SCHEMA,
    officialVersion: SUPPORTED_VERSION,
    features: manifest.features.map((f) => f.id),
    files: { ...latest },
  };
}

const { execFileSync } = require("node:child_process");

function checkSyntaxCjs(code, label) {
  try {
    new (require("node:vm").Script)(code, { filename: label + ".cjs" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error && error.message ? error.message : error) };
  }
}

function checkSyntaxEsm(code, workDir, label) {
  const tmp = path.join(workDir, label.replace(/[^A-Za-z0-9_.-]/g, "_") + ".mjs");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(tmp, code, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    return { ok: true };
  } catch (error) {
    const stderr =
      error && error.stderr
        ? String(error.stderr)
        : String(error && error.message ? error.message : error);
    return { ok: false, error: stderr.slice(0, 2000) };
  }
}

function verifyTransforms(originalDir, workDir) {
  const originals = verifyOriginals(originalDir);
  const report = {};
  for (const rel of FILES) {
    const originalText = originals[rel].toString("utf8");
    const patched = applyAllStages(rel, originalText);
    let check;
    if (rel === "package.json") {
      try {
        JSON.parse(patched);
        check = { ok: true };
      } catch (error) {
        check = { ok: false, error: String(error && error.message ? error.message : error) };
      }
    } else {
      const isEsm = rel.startsWith("webview/");
      check = isEsm ? checkSyntaxEsm(patched, workDir, rel) : checkSyntaxCjs(patched, rel);
    }
    if (!check.ok) {
      throw new Error("syntax verification failed for " + rel + ": " + check.error);
    }
    report[rel] = {
      originalSha: ORIGINAL_HASHES[rel],
      patchedSha: sha256(Buffer.from(patched, "utf8")),
      syntax: "ok",
    };
  }
  return report;
}

module.exports = {
  PUBLISHER,
  NAME,
  SUPPORTED_VERSION,
  MANIFEST_SCHEMA,
  FILES,
  ORIGINAL_HASHES,
  STAGES,
  FEATURES,
  HOST,
  SRC_622B,
  INIT_SERVICES,
  CONVERSATION_PAGE,
  MESSAGE_BUS,
  MODEL_SETTINGS,
  COMPOSER_CONTENT,
  COMPOSER_SCOPE,
  sha256,
  replaceOnce,
  rewriteAliases,
  resourcesDir,
  historyFilterSource,
  startupWatchdogSource,
  tabTitlesSource,
  draftIsolationSource,
  statusCoreSource,
  modelCoreSource,
  modelWebviewSource,
  transformStage,
  applyAllStages,
  verifyOriginals,
  buildManifest,
  buildAttestation,
  verifyTransforms,
  checkSyntaxCjs,
  checkSyntaxEsm,
};

