/* Companion panel names. Host-only metadata, keyed by the exact custom editor
 * document URI. This runtime never writes chat names or issues server requests. */
function __companionWindowNamesAllowed(context) {
  try {
    return typeof process !== "undefined" && process.platform === "win32" &&
      je.workspace.isTrusted === true && !je.env.remoteName &&
      context.extension.packageJSON.version === "26.1021.22027";
  } catch (e) { return false; }
}
function __companionWindowNamesProject() {
  var workspace = je.workspace || {};
  var name = typeof workspace.name === "string" ? workspace.name.trim().replace(/\s+/g, " ") : "";
  if (!name && Array.isArray(workspace.workspaceFolders) && workspace.workspaceFolders.length === 1) {
    name = String(workspace.workspaceFolders[0].name || "").trim().replace(/\s+/g, " ");
  }
  return name || "Codex";
}
function __companionWindowNamesUri(uri) {
  try { return uri != null && typeof uri.toString === "function" ? uri.toString() : null; }
  catch (e) { return null; }
}
function __companionWindowNamesSpecial(provider, panel) {
  var rec = __companionWorkflowRecord(provider, panel);
  var route = rec && rec.initialRoute;
  return __companionWorkflowIsSpecialPanel(provider, panel) ||
    (typeof route === "string" && /^\/(?:diff|plan-summary|settings)(?:\/|$|\?)/.test(route));
}
function __companionWindowNamesRecord(provider, panel) {
  var runtime = provider && provider.__companionWindowNamesRuntime;
  if (!runtime || runtime.workflow.disposed || __companionWindowNamesSpecial(provider, panel) ||
      !__companionWorkflowChatPanel(provider, panel)) return null;
  return __companionWorkflowRecord(provider, panel);
}
function __companionWindowNamesClone(entries) {
  var copy = Object.create(null);
  Object.keys(entries).forEach(function (key) {
    var entry = entries[key];
    copy[key] = { title: entry.title, userNamed: entry.userNamed === true };
  });
  return copy;
}
function __companionWindowNamesQueue(runtime, operation) {
  var result = runtime.pending.then(operation, operation);
  runtime.pending = result.then(function () {}, function () {});
  return result;
}
function __companionWindowNamesSave(runtime, uri, title, userNamed) {
  if (uri == null) return Promise.resolve();
  var next = __companionWindowNamesClone(runtime.entries);
  next[uri] = { title: title, userNamed: userNamed === true };
  return Promise.resolve(runtime.context.workspaceState.update(runtime.key, { schema: 1, windows: next }))
    .then(function () { runtime.entries = next; });
}
function __companionWindowNamesRegister(provider, panel, documentUri) {
  var runtime = provider && provider.__companionWindowNamesRuntime;
  var rec = __companionWindowNamesRecord(provider, panel);
  if (!runtime || !rec) return false;
  if (rec.__companionWindowName) return true;
  var uri = __companionWindowNamesUri(documentUri);
  var saved = uri != null ? runtime.entries[uri] : null;
  rec.__companionWindowName = {
    title: saved ? saved.title : __companionWindowNamesProject(),
    userNamed: saved ? saved.userNamed : false,
    restored: !!saved,
    uri: uri,
    revision: 0,
    autoApplied: false
  };
  __companionWorkflowPanelId(rec);
  // The former late-preview guard remains authoritative once a panel is named.
  rec.__companionTitleSeen = true;
  __companionWindowNamesApply(provider, panel);
  if (uri != null && !saved) {
    var initial = rec.__companionWindowName;
    __companionWindowNamesQueue(runtime, function () {
      return __companionWindowNamesSave(runtime, uri, initial.title, initial.userNamed);
    }).catch(function () {});
  }
  return true;
}
function __companionWindowNamesBase(provider, panel) {
  var rec = __companionWindowNamesRecord(provider, panel);
  return rec && rec.__companionWindowName ? rec.__companionWindowName.title : null;
}
function __companionWindowNamesApply(provider, panel) {
  var rec = __companionWindowNamesRecord(provider, panel);
  if (!rec || !rec.__companionWindowName) return false;
  var name = rec.__companionWindowName;
  var runtime = provider.__companionWindowNamesRuntime;
  if (!name.userNamed && !name.restored && !name.autoApplied && name.title === "Codex" &&
      rec.__companionTitleActive === true && typeof rec.__companionTitleText === "string") {
    var nativeTitle = rec.__companionTitleText.trim().replace(/\s+/g, " ");
    if (nativeTitle) {
      var points = Array.from(nativeTitle);
      name.title = points.length > 42 ? points.slice(0, 41).join("") + "\u2026" : nativeTitle;
      name.autoApplied = true;
      name.revision += 1;
      var automaticTitle = name.title;
      var automaticRevision = name.revision;
      __companionWindowNamesQueue(runtime, function () {
        // A manual rename may have been awaiting storage when this native
        // title arrived. Do not let its queued automatic save undo that rename.
        if (name.userNamed || name.revision !== automaticRevision || name.title !== automaticTitle) return;
        return __companionWindowNamesSave(runtime, name.uri, automaticTitle, false);
      }).catch(function () {});
    }
  }
  var threadId = rec.__companionTitleActive === true ? rec.__companionTitleThreadId : null;
  var thread = threadId && runtime.workflow.threads[threadId];
  var marker = __companionWorkflowMarker(thread ? thread.status : "idle");
  try { panel.title = (marker ? marker + " " : "") + name.title; return true; }
  catch (e) { return false; }
}
function __companionWindowNamesInstall(provider, context) {
  if (!provider || provider.__companionWindowNamesRuntime || !__companionWindowNamesAllowed(context)) return null;
  var workflow = provider.__companionWorkflowRuntime;
  if (!workflow || workflow.disposed) return null;
  var key = "codexCompanion.official.v1.windowNames";
  var entries = Object.create(null);
  try {
    var saved = context.workspaceState.get(key);
    if (saved && saved.schema === 1 && saved.windows && typeof saved.windows === "object") {
      Object.keys(saved.windows).forEach(function (uri) {
        var entry = saved.windows[uri];
        if (uri && entry && typeof entry.title === "string" && entry.title.trim()) {
          entries[uri] = { title: entry.title, userNamed: entry.userNamed === true };
        }
      });
    }
  } catch (e) {}
  var runtime = { provider: provider, context: context, workflow: workflow, key: key,
    entries: entries, pending: Promise.resolve() };
  provider.__companionWindowNamesRuntime = runtime;
  var getWindows = function () {
    var windows = [];
    if (!workflow.disposed && __companionWindowNamesAllowed(context)) {
      Array.from(provider.editorPanels.keys()).forEach(function (panel) {
        var rec = __companionWindowNamesRecord(provider, panel);
        if (!rec) return;
        __companionWindowNamesRegister(provider, panel, rec.__companionDocumentUri);
        var name = rec.__companionWindowName;
        windows.push({ panelId: __companionWorkflowPanelId(rec), title: name.title,
          active: panel.active === true, uri: name.uri });
      });
    }
    return { instanceId: workflow.instanceId, windows: windows };
  };
  var rename = function (input) {
    if (!input || typeof input !== "object" || input.instanceId !== workflow.instanceId ||
        typeof input.panelId !== "string" || typeof input.title !== "string") return Promise.resolve(false);
    var title = input.title.trim();
    if (!title) return Promise.resolve(false);
    return __companionWindowNamesQueue(runtime, async function () {
      if (workflow.disposed || !__companionWindowNamesAllowed(context)) return false;
      var panels = Array.from(provider.editorPanels.keys());
      var panel = null, rec = null;
      for (var i = 0; i < panels.length; i++) {
        var candidate = __companionWindowNamesRecord(provider, panels[i]);
        if (candidate && __companionWorkflowPanelId(candidate) === input.panelId) {
          panel = panels[i]; rec = candidate; break;
        }
      }
      if (!rec) return false;
      __companionWindowNamesRegister(provider, panel, rec.__companionDocumentUri);
      var name = rec.__companionWindowName;
      try { await __companionWindowNamesSave(runtime, name.uri, title, true); }
      catch (e) { return false; }
      if (workflow.disposed || __companionWindowNamesRecord(provider, panel) !== rec) return false;
      name.title = title;
      name.userNamed = true;
      name.revision += 1;
      workflow.sequence += 1;
      return __companionWindowNamesApply(provider, panel);
    });
  };
  context.subscriptions.push(je.commands.registerCommand("chatgpt.companion.v1.getWindowNames", getWindows));
  context.subscriptions.push(je.commands.registerCommand("chatgpt.companion.v1.renameWindow", rename));
  Array.from(provider.editorPanels.keys()).forEach(function (panel) {
    var rec = __companionWorkflowRecord(provider, panel);
    __companionWindowNamesRegister(provider, panel, rec && rec.__companionDocumentUri);
  });
  return runtime;
}
