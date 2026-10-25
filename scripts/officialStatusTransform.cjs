"use strict";
/*
 * Status transform for the official Codex 26.1007.21434 extension.
 *
 * Input is the accepted history + watchdog + tab-title baseline (the bytes
 * produced by patchOfficialHistory.cjs and patchOfficialTitles.cjs). This
 * transform is deliberately pure: it only reads its own runtime source and
 * rewrites extension.js. The parent installer owns backups, hashes, writes,
 * model-transform composition and rollback.
 *
 * Changed seams (host only):
 *   - inject resources/officialTabStatus.js after the title host glue;
 *   - observe native raw notifications and server requests before broadcast;
 *   - reconcile the marker after every native title apply/reset;
 *   - capture the real ExtensionContext and official provider instance.
 *
 * The c014 webview bundle is intentionally returned unchanged.
 */

const fs = require("fs");
const path = require("path");

const HOST_FILE = "out/extension.js";
const C014_FILE = "webview/assets/app-initial-c014f9ee4429.js";

const STATUS_CORE_ANCHOR =
  "function __companionShouldApplyPreviewTitle(provider,panel){\n" +
  "  var rec=__companionTabTitleRecord(provider,panel);\n" +
  "  return rec==null||rec.__companionTitleSeen!==true;\n" +
  "}";

const TITLE_BIND_ANCHOR = 'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);break}';
const TITLE_BIND_REPLACEMENT =
  'case"companion-tab-title":{__companionApplyCompanionTabTitle(this,e,r);try{__companionWorkflowBindTitle(this,e)}catch(_e){}break}';

const NOTIFICATION_ANCHOR =
  'onRawNotification:F=>{let{method:V,params:J}=F;this.broadcastToAllViews({type:"mcp-notification",hostId:"local",method:V,params:J})}';
const NOTIFICATION_REPLACEMENT =
  'onRawNotification:F=>{let{method:V,params:J}=F;try{__companionWorkflowNotification(this,F)}catch(_e){}this.broadcastToAllViews({type:"mcp-notification",hostId:"local",method:V,params:J})}';

const REQUEST_ANCHOR =
  'onRequest:F=>{this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:F})}';
const REQUEST_REPLACEMENT =
  'onRequest:F=>{try{__companionWorkflowRequest(this,F)}catch(_e){}this.broadcastToAllViews({type:"mcp-request",hostId:"local",request:F})}';

const INSTALL_ANCHOR =
  "wt=new lL(be=>Pe.reportAppEntryReceipt(be),Mt.window.state.focused)";
const INSTALL_REPLACEMENT =
  "__companionWorkflowInstall(Pe,t),wt=new lL(be=>Pe.reportAppEntryReceipt(be),Mt.window.state.focused)";

function statusCoreSourcePath() {
  return path.join(__dirname, "..", "resources", "officialTabStatus.js");
}

function loadStatusCoreSource() {
  return fs.readFileSync(statusCoreSourcePath(), "utf8");
}

function replaceOnce(text, needle, replacement, label) {
  const index = text.indexOf(needle);
  if (index === -1) throw new Error(`status anchor not found: ${label}`);
  if (text.indexOf(needle, index + needle.length) !== -1) {
    throw new Error(`status anchor not unique: ${label}`);
  }
  return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

function generateStatusText(file, baselineText, coreSource) {
  if (typeof baselineText !== "string") throw new Error("baseline text must be a string");
  if (file === C014_FILE) {
    if (!baselineText.includes("companion-history-scope-changed") || !baselineText.includes("companion-tab-title")) {
      throw new Error("c014 bundle: accepted history + title baseline is missing");
    }
    return baselineText;
  }
  if (file !== HOST_FILE) throw new Error(`not a status target: ${file}`);
  if (!baselineText.includes("__companionStartupWatchdog") || !baselineText.includes("__companionHistoryRoots")) {
    throw new Error("extension.js: accepted history + watchdog baseline is missing");
  }
  if (!baselineText.includes("__companionApplyCompanionTabTitle") || !baselineText.includes("__companionTabTitlePayload")) {
    throw new Error("extension.js: accepted title baseline is missing");
  }
  if (baselineText.includes("__companionWorkflowRuntime")) {
    throw new Error("extension.js: status patch is already present");
  }

  const core = coreSource === undefined ? loadStatusCoreSource() : coreSource;
  if (typeof core !== "string" || core.length === 0) throw new Error("status core source is empty");

  let text = baselineText;
  text = replaceOnce(
    text,
    STATUS_CORE_ANCHOR,
    STATUS_CORE_ANCHOR + "\n" + core,
    "extension.js:inject status runtime after title glue"
  );
  text = replaceOnce(
    text,
    TITLE_BIND_ANCHOR,
    TITLE_BIND_REPLACEMENT,
    "extension.js:reconcile title after native apply"
  );
  text = replaceOnce(
    text,
    NOTIFICATION_ANCHOR,
    NOTIFICATION_REPLACEMENT,
    "extension.js:observe raw notification before broadcast"
  );
  text = replaceOnce(
    text,
    REQUEST_ANCHOR,
    REQUEST_REPLACEMENT,
    "extension.js:observe server requests before broadcast"
  );
  text = replaceOnce(
    text,
    INSTALL_ANCHOR,
    INSTALL_REPLACEMENT,
    "extension.js:capture provider and ExtensionContext"
  );
  return text;
}

function applyStatusTransforms(file, baselineText, coreSource) {
  return generateStatusText(file, baselineText, coreSource);
}

module.exports = {
  applyStatusTransforms,
  generateStatusText,
  loadStatusCoreSource,
  statusCoreSourcePath,
  replaceOnce,
  HOST_FILE,
  C014_FILE,
  STATUS_CORE_ANCHOR,
  TITLE_BIND_ANCHOR,
  TITLE_BIND_REPLACEMENT,
  NOTIFICATION_ANCHOR,
  NOTIFICATION_REPLACEMENT,
  REQUEST_ANCHOR,
  REQUEST_REPLACEMENT,
  INSTALL_ANCHOR,
  INSTALL_REPLACEMENT
};

if (require.main === module) {
  // Intentionally no CLI: the parent owns guarded install/rollback.
  process.stderr.write("officialStatusTransform.cjs exports pure transforms only\n");
  process.exitCode = 2;
}
