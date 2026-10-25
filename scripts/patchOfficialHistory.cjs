"use strict";
/*
 * Version/hash guarded, reversible local patch of official Codex 26.1007.21434.
 *
 * Scopes the official HOME/RECENT + FULL HISTORY + SEARCH to the folders of the
 * CURRENT VS Code window, without touching the installed extension directly:
 *   - host out/extension.js: record thread/list|thread/search request ids, filter
 *     their responses by the host's authoritative cR() workspace roots, attach the
 *     roots as an extra "__companionScope" metadata field, clear the side map on
 *     abandon / webview dispose / failed delivery / response, and emit
 *     "companion-history-scope-changed" on workspace-folder changes.
 *   - webview app-initial-97d3534ad35f.js: set the browser scope from listRecentThreads
 *     response, filter list data, and gate shouldSurfaceRecentConversation /
 *     shouldSurfaceThreadSummary on the current roots for the local host.
 *   - webview app-initial-c014f9ee4429.js: handle "companion-history-scope-changed"
 *     by updating the browser scope, invalidating search/archived metadata queries and
 *     refreshing the local recent list in expanded mode (no lifecycle faking).
 *
 * API: node scripts/patchOfficialHistory.cjs check|apply|restore --extension <dir> --backup <dir> [--manifest <json>]
 * The patcher only ever WRITES to --extension (patched files) and --backup (backups);
 * it refuses unknown publisher/name/version/hashes before any write.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PUBLISHER = "openai";
const NAME = "chatgpt";
const SUPPORTED_VERSION = "26.1007.21434";

// Original digests for the one supported build. Both the manifest and the
// bytes on disk must match these constants; a caller cannot supply a manifest
// with different hashes or a different version to make an unknown build look
// installable.
const SUPPORTED_ORIGINAL_HASHES = Object.freeze({
  "package.json": "C81DF9507B9E9982BBC41F858925D102FB8B62F63AFC9B96F8502CB08D901E85",
  "out/extension.js": "A8069DE80C8F8141481D033F94C3A95E1B59F399143CB2554D3F68469DFBE5B8",
  "webview/assets/app-initial-97d3534ad35f.js":
    "47E9E488122CF37A6564ED57D11F499D9AC062B2E49DB729091FE3C163A64B49",
  "webview/assets/app-initial-c014f9ee4429.js":
    "AABBFA7C366706365A239B090CA1C657B6A0213D7287E54EF0A32D1B2E5FF6A0",
});

// CLI check exit code: these states are expected and supported.
const CHECK_OK_STATUSES = new Set(["original", "patched", "mixed"]);

// Relative paths of the files we modify (all must be listed in the manifest).
const PATCHED_FILES = [
  "out/extension.js",
  "webview/assets/app-initial-97d3534ad35f.js",
  "webview/assets/app-initial-c014f9ee4429.js",
];

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

function sha256(input) {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
}

// ---------------------------------------------------------------------------
// Shared pure filter source (single source of truth for host + browser)
// ---------------------------------------------------------------------------

function coreSourcePath() {
  return path.join(__dirname, "..", "resources", "officialHistoryFilter.js");
}

function loadCoreSource() {
  return fs.readFileSync(coreSourcePath(), "utf8");
}

function startupWatchdogSourcePath() {
  return path.join(__dirname, "..", "resources", "officialStartupWatchdog.js");
}

function loadStartupWatchdogSource() {
  return fs.readFileSync(startupWatchdogSourcePath(), "utf8");
}

// Evaluate the core helper functions in an isolated scope for tests / self-check.
function evaluateCore() {
  const src = loadCoreSource();
  const factory = new Function(
    src +
      "\nreturn { __companionNormPath: __companionNormPath, __companionCwdMatchesRoots: __companionCwdMatchesRoots, __companionThreadCwd: __companionThreadCwd, __companionFilterRows: __companionFilterRows, __companionNormalizedRoots: __companionNormalizedRoots };"
  );
  return factory();
}

// ---------------------------------------------------------------------------
// Host glue (injected into out/extension.js after function cR(){...})
// ---------------------------------------------------------------------------

const HOST_GLUE = `
function __companionHistoryRoots(){try{return cR()}catch(e){return []}}
function __companionIsHistoryMethod(m){return m==="thread/list"||m==="thread/search"}
function __companionFilterHistoryResult(method,result){
  if(!result||typeof result!=="object"||!Array.isArray(result.data))return result;
  var roots=__companionHistoryRoots()||[];
  var rn=__companionNormalizedRoots(roots);
  var out;
  if(rn.length===0){out=Object.assign({},result,{data:[],nextCursor:null});}
  else{out=Object.assign({},result,{data:__companionFilterRows(result.data,rn)});}
  if(method==="thread/list"){out.__companionScope={roots:Array.isArray(roots)?roots.slice():[],normalized:rn.slice()};}
  return out;
}
`;

// ---------------------------------------------------------------------------
// Browser glue (prepended to both webview bundles; shares state via globalThis)
// ---------------------------------------------------------------------------

const BROWSER_GLUE = `
function __companionBrowserSetScopeFromResult(a,hostId){
  if(hostId!=="local")return;
  var scope=a&&typeof a==="object"?a.__companionScope:null;
  if(!scope||typeof scope!=="object"||!Array.isArray(scope.roots))return;
  globalThis.__companionHistoryScope={hostId:hostId,roots:scope.roots.slice(),normalized:__companionNormalizedRoots(scope.roots)};
}
function __companionBrowserSetScopeFromMessage(msg){
  if(!msg||typeof msg!=="object")return;
  var hostId=msg.hostId;
  var roots=Array.isArray(msg.roots)?msg.roots.slice():[];
  globalThis.__companionHistoryScope={hostId:hostId,roots:roots,normalized:__companionNormalizedRoots(roots)};
}
function __companionBrowserRoots(hostId){
  if(hostId!=="local")return null;
  var scope=globalThis.__companionHistoryScope;
  if(!scope||scope.hostId!=="local")return undefined;
  return scope.normalized||[];
}
function __companionBrowserFilterRows(data,hostId){
  if(hostId!=="local")return data;
  var roots=__companionBrowserRoots(hostId);
  if(roots===undefined||roots===null)return [];
  return __companionFilterRows(data,roots);
}
function __companionShouldSurface(cwd,hostId){
  if(hostId!=="local")return true;
  var roots=__companionBrowserRoots(hostId);
  if(roots===undefined||roots===null)return false;
  return __companionCwdMatchesRoots(cwd,roots);
}
`;

// ---------------------------------------------------------------------------
// Anchors and transformations
// ---------------------------------------------------------------------------

function replaceOnce(text, needle, replacement, label) {
  const idx = text.indexOf(needle);
  if (idx === -1) {
    throw new Error(`patch anchor not found: ${label}`);
  }
  if (text.indexOf(needle, idx + needle.length) !== -1) {
    throw new Error(`patch anchor not unique: ${label}`);
  }
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

function generatePatchedText(file, originalText, coreSource) {
  const core = coreSource === undefined ? loadCoreSource() : coreSource;

  if (file === "out/extension.js") {
    let t = originalText;
    t = replaceOnce(
      t,
      'var ZF=class{constructor(e){this.onTimeout=e}timeout;disposed=!1;receivedWebviewMessage=!1;start(){if(this.disposed||this.timeout!=null)return;let e=Date.now();this.timeout=setTimeout(()=>{this.timeout=void 0,this.onTimeout({elapsedMs:Date.now()-e,receivedWebviewMessage:this.receivedWebviewMessage,timeoutMs:3e4})},3e4)}markMessageReceived(){this.receivedWebviewMessage=!0}handleStartupPhase(e){e==="renderer_ready"&&this.dispose()}dispose(){this.disposed=!0,this.timeout!=null&&(clearTimeout(this.timeout),this.timeout=void 0)}};',
      loadStartupWatchdogSource() + "var ZF=__companionStartupWatchdog;",
      "extension.js:visibility-aware startup watchdog"
    );
    t = replaceOnce(
      t,
      'this.subscriptions.push(a,n(()=>{s.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=await this.getWebviewContent(e),s.start()',
      'let b=__companionBindStartupVisibility(s,r==="panel"?this.findPanelByWebview(e):void 0);b&&this.subscriptions.push(b),this.subscriptions.push(a,n(()=>{s.dispose(),b?.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=await this.getWebviewContent(e),s.start()',
      "extension.js:bind panel startup watchdog to visibility"
    );
    t = replaceOnce(
      t,
      'function cR(){let t=Y6e.workspace.workspaceFolders?.filter(({uri:r})=>(r.fsPath!=="/"||r.scheme==="file"||r.scheme==="vscode-remote")&&el(r.fsPath)).map(({uri:r})=>r.fsPath)??[];return Hr()?t.map(pr):t}',
      'function cR(){let t=Y6e.workspace.workspaceFolders?.filter(({uri:r})=>(r.fsPath!=="/"||r.scheme==="file"||r.scheme==="vscode-remote")&&el(r.fsPath)).map(({uri:r})=>r.fsPath)??[];return Hr()?t.map(pr):t};' +
        core +
        HOST_GLUE,
      "extension.js:inject helpers after cR"
    );
    t = replaceOnce(
      t,
      'let{id:n,method:o,params:i}=r.request;this.pendingMcpRequests.set(String(n),e),this.codexMcpConnection.sendRequest(IR,String(n),o,i,r.retainResponse);break}',
      'let{id:n,method:o,params:i}=r.request;this.pendingMcpRequests.set(String(n),e),__companionIsHistoryMethod(o)&&((this.__companionHistoryRequests??=new Map).set(String(n),{method:o,webview:e})),this.codexMcpConnection.sendRequest(IR,String(n),o,i,r.retainResponse);break}',
      "extension.js:record list/search request id"
    );
    t = replaceOnce(
      t,
      'this.pendingMcpRequests.delete(r),this.chunkedMessageSender.send(n,{type:"mcp-response",hostId:"local",message:{id:e.id,result:e.result,error:e.error}})}',
      'this.pendingMcpRequests.delete(r);var m=this.__companionHistoryRequests?.get(r);this.__companionHistoryRequests?.delete(r);this.chunkedMessageSender.send(n,{type:"mcp-response",hostId:"local",message:{id:e.id,result:m?__companionFilterHistoryResult(m.method,e.result):e.result,error:e.error}})}',
      "extension.js:filter mcp response"
    );
    t = replaceOnce(
      t,
      'case"mcp-request-abandon":{this.pendingMcpRequests.delete(String(r.requestId)),this.codexMcpConnection.abandonRequest(IR,String(r.requestId));break}',
      'case"mcp-request-abandon":{this.pendingMcpRequests.delete(String(r.requestId)),this.__companionHistoryRequests?.delete(String(r.requestId)),this.codexMcpConnection.abandonRequest(IR,String(r.requestId));break}',
      "extension.js:clear side map on abandon"
    );
    t = replaceOnce(
      t,
      'clearPendingRequestsForWebview(e){if(e)for(let[r,n]of this.pendingMcpRequests.entries())n===e&&(this.pendingMcpRequests.delete(r),this.codexMcpConnection.abandonRequest(IR,r))}',
      'clearPendingRequestsForWebview(e){if(e){for(let[r,n]of this.pendingMcpRequests.entries())n===e&&(this.pendingMcpRequests.delete(r),this.codexMcpConnection.abandonRequest(IR,r));if(this.__companionHistoryRequests)for(let[r,n]of this.__companionHistoryRequests.entries())n.webview===e&&this.__companionHistoryRequests.delete(r)}}',
      "extension.js:clear side map on webview dispose"
    );
    t = replaceOnce(
      t,
      'onRequestDelivery:F=>{let V=String(F.delivery.requestId),J=this.pendingMcpRequests.get(V);J!=null&&(F.type==="failed"&&this.pendingMcpRequests.delete(V),this.postMessageToWebview(J,{type:"mcp-request-delivery",hostId:"local",update:F}))}',
      'onRequestDelivery:F=>{let V=String(F.delivery.requestId),J=this.pendingMcpRequests.get(V);J!=null&&(F.type==="failed"&&(this.pendingMcpRequests.delete(V),this.__companionHistoryRequests?.delete(V)),this.postMessageToWebview(J,{type:"mcp-request-delivery",hostId:"local",update:F}))}',
      "extension.js:clear side map on failed delivery"
    );
    t = replaceOnce(
      t,
      'this.subscriptions.push(je.workspace.onDidChangeWorkspaceFolders(()=>{this.broadcastToAllViews({type:"global-state-updated",keys:[Re.LOCAL_PROJECTS,Re.SELECTED_PROJECT]})}))',
      'this.subscriptions.push(je.workspace.onDidChangeWorkspaceFolders(()=>{this.broadcastToAllViews({type:"global-state-updated",keys:[Re.LOCAL_PROJECTS,Re.SELECTED_PROJECT]}),this.broadcastToAllViews({type:"companion-history-scope-changed",hostId:"local",roots:__companionHistoryRoots()})}))',
      "extension.js:broadcast scope change on workspace folders change"
    );
    return t;
  }

  if (file === "webview/assets/app-initial-97d3534ad35f.js") {
    if (!originalText.startsWith("const __vite__mapDeps=(")) {
      throw new Error("97d bundle: unexpected file start");
    }
    let t = core + BROWSER_GLUE + originalText;
    t = replaceOnce(
      t,
      "return{...a,data:a.data.filter(bxn)}}",
      "__companionBrowserSetScopeFromResult(a,this.params.hostId);return{...a,data:__companionBrowserFilterRows(a.data.filter(bxn),this.params.hostId)}}",
      "97d:set scope and filter listRecentThreads"
    );
    t = replaceOnce(
      t,
      "shouldSurfaceRecentConversation(e){return!this.isConversationSuppressed(e.id)&&e.ephemeral!==!0&&e.sideConversation!==!0&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||nSn(e,this.params.hostId))}",
      "shouldSurfaceRecentConversation(e){return!this.isConversationSuppressed(e.id)&&e.ephemeral!==!0&&e.sideConversation!==!0&&__companionShouldSurface(e.cwd,this.params.hostId)&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||nSn(e,this.params.hostId))}",
      "97d:gate shouldSurfaceRecentConversation on scope"
    );
    t = replaceOnce(
      t,
      "shouldSurfaceThreadSummary(e){return!this.isConversationSuppressed(e.conversationId)&&this.conversations.get(e.conversationId)?.sideConversation!==!0&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||nSn(e,this.params.hostId))}",
      "shouldSurfaceThreadSummary(e){return!this.isConversationSuppressed(e.conversationId)&&this.conversations.get(e.conversationId)?.sideConversation!==!0&&__companionShouldSurface(e.cwd,this.params.hostId)&&(this.params.hostId===`local`||e.workspaceKind!==`projectless`||nSn(e,this.params.hostId))}",
      "97d:gate shouldSurfaceThreadSummary on scope"
    );
    return t;
  }

  if (file === "webview/assets/app-initial-c014f9ee4429.js") {
    if (!originalText.startsWith("const __vite__mapDeps=(")) {
      throw new Error("c014 bundle: unexpected file start");
    }
    let t = core + BROWSER_GLUE + originalText;
    t = replaceOnce(
      t,
      "case`invalidate-thread-search`:$me(p,e.hostId),p.invalidateQueries({queryKey:[`archived-threads`,e.hostId]});break bb460;",
      "case`invalidate-thread-search`:$me(p,e.hostId),p.invalidateQueries({queryKey:[`archived-threads`,e.hostId]});break bb460;case`companion-history-scope-changed`:__companionBrowserSetScopeFromMessage(e),p.invalidateQueries({queryKey:[`archived-threads`,e.hostId]}),$me(p,e.hostId),e.hostId===`local`&&Bp(r,e.hostId).refreshRecentConversations({mode:`expanded`}).catch(i3i);break bb460;",
      "c014:handle companion-history-scope-changed"
    );
    return t;
  }

  throw new Error(`not a patched file: ${file}`);
}

// ---------------------------------------------------------------------------
// Manifest / identity validation
// ---------------------------------------------------------------------------

function resolveManifestPath(backupDir, manifestArg) {
  if (manifestArg) return path.resolve(manifestArg);
  const candidates = [
    path.join(backupDir, "original-manifest.json"),
    path.join(path.dirname(backupDir), "original-manifest.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `original-manifest.json not found (looked in ${candidates.join(", ")}); pass --manifest <path>`
  );
}

function readManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) {
    throw new Error(`invalid manifest: ${manifestPath}`);
  }
  return parsed;
}

function readExtensionPackage(extDir) {
  const pkgPath = path.join(extDir, "package.json");
  if (!fs.existsSync(pkgPath)) throw new Error(`package.json not found in ${extDir}`);
  return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
}

function verifyExtensionIdentity(extDir, manifest) {
  const pkg = readExtensionPackage(extDir);
  const errors = [];
  if (pkg.publisher !== PUBLISHER) errors.push(`publisher ${JSON.stringify(pkg.publisher)} !== ${PUBLISHER}`);
  if (pkg.name !== NAME) errors.push(`name ${JSON.stringify(pkg.name)} !== ${NAME}`);
  if (pkg.version !== SUPPORTED_VERSION) {
    errors.push(`version ${JSON.stringify(pkg.version)} !== ${JSON.stringify(SUPPORTED_VERSION)}`);
  }
  return { ok: errors.length === 0, errors, pkg };
}

function manifestFileMap(manifest) {
  const map = new Map();
  for (const f of manifest.files) map.set(f.file, f);
  return map;
}

function assertKnownManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.files)) {
    throw new Error("invalid manifest: expected an object with a files array");
  }
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `unsupported manifest version ${JSON.stringify(manifest.version)}; expected ${JSON.stringify(SUPPORTED_VERSION)}`
    );
  }
  const map = manifestFileMap(manifest);
  const expectedFiles = ["package.json", ...PATCHED_FILES];
  for (const file of expectedFiles) {
    const entry = map.get(file);
    if (!entry) throw new Error(`manifest missing entry for ${file}`);
    const sha = String(entry.sha256 || "").toUpperCase();
    if (sha !== SUPPORTED_ORIGINAL_HASHES[file]) {
      throw new Error(`manifest entry for ${file} does not match the supported original hash`);
    }
  }
  for (const entry of manifest.files) {
    if (!expectedFiles.includes(entry.file)) {
      throw new Error(`manifest contains unsupported entry for ${entry.file}`);
    }
  }
}

// Verify current extension bytes against the original manifest, refusing on mismatch.
function computeOriginalHashes(extDir, manifest) {
  assertKnownManifest(manifest);
  const files = ["package.json", ...PATCHED_FILES];
  const result = {};
  for (const file of files) {
    const abs = path.join(extDir, file);
    if (!fs.existsSync(abs)) {
      result[file] = { exists: false, current: null, original: SUPPORTED_ORIGINAL_HASHES[file], status: "missing" };
      continue;
    }
    const buf = fs.readFileSync(abs);
    const current = sha256(buf);
    const original = SUPPORTED_ORIGINAL_HASHES[file];
    result[file] = {
      exists: true,
      current,
      original,
      length: buf.length,
      status: current === original ? "original" : "mismatch",
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// File plan (original / patched / foreign)
// ---------------------------------------------------------------------------

function computePlan(extDir, manifest, backupDir) {
  const originals = computeOriginalHashes(extDir, manifest);
  const plan = {};
  for (const file of PATCHED_FILES) {
    const o = originals[file];
    if (!o.exists) {
      plan[file] = { status: "missing", originalSha: o.original, currentSha: null, patchedSha: null };
      continue;
    }
    if (o.status === "original") {
      const patchedText = generatePatchedText(file, fs.readFileSync(path.join(extDir, file), "utf8"));
      plan[file] = { status: "original", originalSha: o.original, currentSha: o.current, patchedSha: sha256(patchedText) };
      continue;
    }
    // Current bytes differ from original: derive the expected patched digest from a
    // verified original (the caller-provided backup), so "patched" can be told apart
    // from "foreign" without guessing.
    const backupAbs = backupDir ? backupFilePath(backupDir, file) : null;
    if (backupAbs && fs.existsSync(backupAbs)) {
      const backupBytes = fs.readFileSync(backupAbs);
      if (sha256(backupBytes) === o.original) {
        const patchedText = generatePatchedText(file, backupBytes.toString("utf8"));
        const patchedSha = sha256(patchedText);
        plan[file] = {
          status: o.current === patchedSha ? "patched" : "foreign",
          originalSha: o.original,
          currentSha: o.current,
          patchedSha,
        };
        continue;
      }
    }
    plan[file] = { status: "foreign", originalSha: o.original, currentSha: o.current, patchedSha: null };
  }
  return { packageJson: originals["package.json"], plan };
}

// ---------------------------------------------------------------------------
// Atomic writes and backups
// ---------------------------------------------------------------------------

function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function backupFilePath(backupDir, file) {
  return path.join(backupDir, "files", file);
}

function ensureBackup(backupDir, extDir, manifest, filesToBackup) {
  const originals = computeOriginalHashes(extDir, manifest);
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(path.join(backupDir, "files"), { recursive: true });
  for (const file of filesToBackup) {
    const o = originals[file];
    if (!o.exists || o.status !== "original") {
      throw new Error(`refusing to back up ${file}: not in original state (${o.status})`);
    }
    const abs = path.join(extDir, file);
    const target = backupFilePath(backupDir, file);
    if (fs.existsSync(target)) {
      const existing = sha256(fs.readFileSync(target));
      if (existing !== originals[file].original) {
        throw new Error(`refusing to overwrite existing backup for ${file} (unexpected content)`);
      }
      continue; // already has the verified original
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    atomicWrite(target, fs.readFileSync(abs));
  }
  return originals;
}

function writeBackupManifest(backupDir, plan) {
  const files = [];
  for (const file of PATCHED_FILES) {
    files.push({
      file,
      originalSha: plan[file].originalSha,
      patchedSha: plan[file].patchedSha,
    });
  }
  const m = {
    patchedBy: "patchOfficialHistory.cjs",
    extensionVersion: SUPPORTED_VERSION,
    files,
  };
  atomicWrite(path.join(backupDir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// check / apply / restore
// ---------------------------------------------------------------------------

function aggregateCheckStatus(identity, packageJson, statuses) {
  if (!identity.ok) return "identity-error";
  // The package manifest is never patched; it must stay byte-identical too.
  if (packageJson.status !== "original") return `package-json-${packageJson.status}`;
  const values = PATCHED_FILES.map((file) => statuses[file]);
  if (values.includes("missing")) return "missing";
  if (values.includes("foreign")) return "foreign";
  if (values.every((s) => s === "original")) return "original";
  if (values.every((s) => s === "patched")) return "patched";
  if (values.every((s) => s === "original" || s === "patched")) return "mixed";
  return "unknown";
}

function checkPatch({ extDir, backupDir, manifestPath, manifest }) {
  const man = manifest || readManifest(manifestPath);
  assertKnownManifest(man);
  const id = verifyExtensionIdentity(extDir, man);
  const full = computePlan(extDir, man, backupDir);
  const plan = full.plan;
  const statuses = {};
  for (const f of PATCHED_FILES) statuses[f] = plan[f].status;
  return {
    command: "check",
    identityOk: id.ok,
    identityErrors: id.errors,
    version: SUPPORTED_VERSION,
    status: aggregateCheckStatus(id, full.packageJson, statuses),
    packageJson: full.packageJson.status,
    files: statuses,
    detail: full,
  };
}

function applyPatch({ extDir, backupDir, manifestPath, manifest }) {
  const man = manifest || readManifest(manifestPath);
  assertKnownManifest(man);
  const id = verifyExtensionIdentity(extDir, man);
  if (!id.ok) {
    throw new Error(`identity check failed: ${id.errors.join("; ")}`);
  }
  const full = computePlan(extDir, man, backupDir);
  if (full.packageJson.status !== "original") {
    throw new Error(
      `package.json does not match the supported original hash (${full.packageJson.status}); refusing to apply`
    );
  }
  const plan = full.plan;
  const toBackup = [];
  for (const file of PATCHED_FILES) {
    const st = plan[file].status;
    if (st === "patched") continue;
    if (st !== "original") {
      throw new Error(`${file} is not in original state (${st}), refusing`);
    }
    toBackup.push(file);
  }
  if (toBackup.length === 0) {
    return {
      command: "apply",
      version: SUPPORTED_VERSION,
      applied: [],
      files: Object.fromEntries(PATCHED_FILES.map((f) => [f, "patched"])),
      backupDir,
    };
  }
  ensureBackup(backupDir, extDir, man, toBackup);

  const written = [];
  try {
    for (const file of toBackup) {
      const p = plan[file];
      const abs = path.join(extDir, file);
      const patchedText = generatePatchedText(file, fs.readFileSync(abs, "utf8"));
      if (sha256(patchedText) !== p.patchedSha) {
        throw new Error(`internal error: patched digest mismatch for ${file}`);
      }
      atomicWrite(abs, patchedText);
      written.push(file);
    }
    writeBackupManifest(backupDir, plan);
  } catch (e) {
    // Transactional rollback: restore files already written from verified backups.
    const rollbackErrors = [];
    for (const file of written.reverse()) {
      try {
        atomicWrite(path.join(extDir, file), fs.readFileSync(backupFilePath(backupDir, file)));
      } catch (re) {
        rollbackErrors.push(`${file}: ${re.message || re}`);
      }
    }
    const err = new Error(
      `apply failed: ${e.message || e}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""}`
    );
    throw err;
  }

  return {
    command: "apply",
    version: SUPPORTED_VERSION,
    applied: written,
    // By the time we return, every patched file is in the patched state.
    files: Object.fromEntries(PATCHED_FILES.map((f) => [f, "patched"])),
    backupDir,
  };
}

function restorePatch({ extDir, backupDir, manifestPath, manifest }) {
  const man = manifest || readManifest(manifestPath);
  assertKnownManifest(man);
  const id = verifyExtensionIdentity(extDir, man);
  if (!id.ok) {
    throw new Error(`identity check failed: ${id.errors.join("; ")}`);
  }
  const full = computePlan(extDir, man, backupDir);
  if (full.packageJson.status !== "original") {
    throw new Error(
      `package.json does not match the supported original hash (${full.packageJson.status}); refusing to restore`
    );
  }

  // Preflight every file and every backup before writing anything, so an
  // unknown file or a corrupt backup cannot leave a partial restore.
  const actions = [];
  for (const file of PATCHED_FILES) {
    const p = full.plan[file];
    if (p.status === "original") continue; // already restored (idempotent)
    if (p.status !== "patched") {
      throw new Error(`${file}: current bytes are neither original nor expected-patched (${p.status}); refusing`);
    }
    const backupAbs = backupFilePath(backupDir, file);
    if (!fs.existsSync(backupAbs)) {
      throw new Error(`${file}: backup missing at ${backupAbs}; cannot restore safely`);
    }
    const backupBytes = fs.readFileSync(backupAbs);
    if (sha256(backupBytes) !== p.originalSha) {
      throw new Error(`${file}: backup bytes do not match original hash; refusing`);
    }
    const abs = path.join(extDir, file);
    actions.push({ file, abs, backupBytes, beforeBytes: fs.readFileSync(abs) });
  }

  const written = [];
  try {
    for (const action of actions) {
      atomicWrite(action.abs, action.backupBytes);
      written.push(action);
    }
  } catch (e) {
    // Roll back files already restored to their pre-restore (patched) bytes.
    const rollbackErrors = [];
    for (const action of written.reverse()) {
      try {
        atomicWrite(action.abs, action.beforeBytes);
      } catch (re) {
        rollbackErrors.push(`${action.file}: ${re.message || re}`);
      }
    }
    throw new Error(
      `restore failed: ${e.message || e}${rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""}`
    );
  }

  return {
    command: "restore",
    version: SUPPORTED_VERSION,
    restored: actions.map((action) => action.file),
    // By the time we return, every patched file is back to its original state.
    files: Object.fromEntries(PATCHED_FILES.map((f) => [f, "original"])),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { command: null, extension: null, backup: null, manifest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "check" || a === "apply" || a === "restore") args.command = a;
    else if (a === "--extension") args.extension = argv[++i];
    else if (a === "--backup") args.backup = argv[++i];
    else if (a === "--manifest") args.manifest = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!args.command) throw new Error("missing command (check|apply|restore)");
  if (!args.extension) throw new Error("missing --extension <dir>");
  if (!args.backup) throw new Error("missing --backup <dir>");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const extDir = path.resolve(args.extension);
  const backupDir = path.resolve(args.backup);
  const manifestPath = resolveManifestPath(backupDir, args.manifest);
  const manifest = readManifest(manifestPath);

  let result;
  if (args.command === "check") {
    result = checkPatch({ extDir, backupDir, manifestPath, manifest });
    if (!CHECK_OK_STATUSES.has(result.status)) process.exitCode = 1;
  } else if (args.command === "apply") {
    result = applyPatch({ extDir, backupDir, manifestPath, manifest });
  } else if (args.command === "restore") {
    result = restorePatch({ extDir, backupDir, manifestPath, manifest });
  } else {
    throw new Error(`unknown command: ${args.command}`);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

module.exports = {
  sha256,
  loadCoreSource,
  loadStartupWatchdogSource,
  evaluateCore,
  generatePatchedText,
  HOST_GLUE,
  BROWSER_GLUE,
  verifyExtensionIdentity,
  computePlan,
  checkPatch,
  applyPatch,
  restorePatch,
  resolveManifestPath,
  readManifest,
  PATCHED_FILES,
  PUBLISHER,
  NAME,
  SUPPORTED_VERSION,
  SUPPORTED_ORIGINAL_HASHES,
  CHECK_OK_STATUSES,
  aggregateCheckStatus,
};

if (require.main === module) {
  try {
    main();
  } catch (e) {
    process.stderr.write(JSON.stringify({ command: "error", error: String(e.message || e) }, null, 2) + "\n");
    process.exitCode = 1;
  }
}
