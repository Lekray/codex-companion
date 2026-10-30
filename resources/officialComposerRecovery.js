/* Composer-local recovery for the pinned 26.1021.22027 native lazy entry.
 * Root wrappers alone receive retry URLs. Their static implementation imports
 * retain identity; a cached failure in a dependency may still require the user
 * to reload later. No navigation, host message, task or draft operation occurs.
 * Declarations stay inert until the native cyclic initialization calls us.
 */
function __companionComposerImportError(error) {
  return error != null && error.name === "TypeError" && typeof error.message === "string" &&
    /^(?:Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/i.test(error.message);
}

function __companionComposerController(loaders, environment) {
  var env = environment || {}, schedule = env.setTimeout || setTimeout;
  var unschedule = env.clearTimeout || clearTimeout;
  var report = env.report || function (error) {
    console.warn("[Codex Companion] Composer module could not load", error);
  };
  var roots = loaders.map(function (loader) {
    return { loader: loader, module: null, pending: null, token: 0, failed: false, retry: 0, cacheBust: false };
  });
  var listeners = new Set(), generation = 0, autoAttempts = 0, manualAttempts = 0;
  var retryTimer = null, timeoutTimer = null;
  var snapshot = { status: "idle", attempt: 0, canRetry: true, error: null, modules: null };
  function emit(next) {
    snapshot = next;
    listeners.forEach(function (listener) { listener(snapshot); });
  }
  function clearTimers() {
    if (retryTimer !== null) unschedule(retryTimer);
    if (timeoutTimer !== null) unschedule(timeoutTimer);
    retryTimer = timeoutTimer = null;
  }
  function load(root) {
    if (root.module !== null) return Promise.resolve(root.module);
    if (root.pending !== null) return root.pending;
    if (root.failed && root.cacheBust) root.retry += 1;
    var token = ++root.token;
    var suffix = root.retry === 0 ? "" : "?companionComposerRetry=" + root.retry;
    var pending = Promise.resolve().then(function () { return root.loader.load(suffix); });
    root.pending = pending.then(function (value) {
      if (root.token === token) { root.module = value; root.pending = null; root.failed = false; }
      return value;
    }, function (error) {
      if (root.token === token) {
        root.pending = null;
        root.failed = __companionComposerImportError(error);
        var escapedPath = root.loader.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        root.cacheBust = root.failed && new RegExp("(?:^|/)" + escapedPath + "(?:[?#\\s\"']|$)").test(error.message);
      }
      throw error;
    });
    return root.pending;
  }
  function active(token) { return token === generation && listeners.size > 0; }
  function run(manual) {
    clearTimers();
    if (manual) manualAttempts += 1; else autoAttempts += 1;
    var token = ++generation, attempt = autoAttempts + manualAttempts;
    emit({ status: "loading", attempt: attempt, canRetry: false, error: null, modules: null });
    function fail(error, timeout) {
      if (!active(token)) return;
      generation += 1;
      clearTimers();
      if (timeout) roots.forEach(function (root) {
        if (root.pending !== null) {
          root.token += 1; root.pending = null; root.failed = true; root.cacheBust = true;
        }
      });
      var recognized = timeout || __companionComposerImportError(error);
      if (!recognized) {
        emit({ status: "fatal", attempt: attempt, canRetry: false, error: error, modules: null });
        return;
      }
      report(error);
      if (!manual && autoAttempts < 3) {
        emit({ status: "loading", attempt: attempt, canRetry: false, error: error, modules: null });
        var retryGeneration = generation;
        retryTimer = schedule(function () {
          retryTimer = null;
          if (active(retryGeneration)) run(false);
        }, autoAttempts === 1 ? 200 : 600);
      } else emit({ status: "error", attempt: attempt, canRetry: manualAttempts < 3, error: error, modules: null });
    }
    timeoutTimer = schedule(function () {
      fail(new Error("Composer module loading timed out"), true);
    }, 12000);
    Promise.all(roots.map(load)).then(function (modules) {
      if (!active(token)) return;
      clearTimers();
      emit({ status: "ready", attempt: attempt, canRetry: false, error: null, modules: modules });
    }, function (error) { fail(error, false); });
  }
  return {
    getSnapshot: function () { return snapshot; },
    subscribe: function (listener) {
      listeners.add(listener);
      return function () {
        listeners.delete(listener);
        if (listeners.size === 0) {
          generation += 1; clearTimers();
          if (snapshot.status === "loading") snapshot = { status: "idle", attempt: autoAttempts + manualAttempts, canRetry: manualAttempts < 3, error: null, modules: null };
        }
      };
    },
    start: function () {
      if (listeners.size === 0 || snapshot.status !== "idle") return;
      if (autoAttempts < 3) run(false);
      else emit({ status: "error", attempt: autoAttempts + manualAttempts, canRetry: manualAttempts < 3, error: null, modules: null });
    },
    retry: function () {
      if (listeners.size === 0 || snapshot.status !== "error" || manualAttempts >= 3) return false;
      run(true); return true;
    }
  };
}

function __companionCreateComposerRecovery(React, jsx, loaders) {
  var controller = __companionComposerController(loaders);
  return function CompanionComposerRecovery(props) {
    var state = React.useState(controller.getSnapshot), snapshot = state[0], update = state[1];
    React.useEffect(function () {
      var unsubscribe = controller.subscribe(update);
      update(controller.getSnapshot());
      controller.start();
      return unsubscribe;
    }, []);
    if (snapshot.status === "fatal") throw snapshot.error;
    if (snapshot.status === "ready") {
      return jsx.jsx(snapshot.modules[0].ComposerContent, Object.assign({}, props, {
        queuedMessageList: snapshot.modules[1].QueuedMessageList
      }));
    }
    var loading = snapshot.status === "idle" || snapshot.status === "loading";
    var children = [jsx.jsx("p", {
      role: "status", "aria-live": "polite",
      children: loading ? "Загрузка поля сообщения…" : "Не удалось загрузить поле сообщения."
    }, "status")];
    if (!loading) {
      children.push(jsx.jsx("p", { children: "Чат и выполняющаяся задача остаются открыты." }, "context"));
      if (snapshot.canRetry) children.push(jsx.jsx("button", {
        type: "button", onClick: function () { controller.retry(); },
        style: { padding: "6px 12px", border: "1px solid currentColor", borderRadius: "6px", cursor: "pointer" },
        children: "Повторить загрузку"
      }, "retry"));
      else children.push(jsx.jsx("p", {
        children: "Попытки исчерпаны. После завершения задач перезагрузите окно VS Code вручную."
      }, "exhausted"));
    }
    return jsx.jsxs("div", {
      "data-companion-composer-recovery": loading ? "loading" : "error",
      "data-attempt": snapshot.attempt,
      style: { padding: "16px", minHeight: "96px", color: "var(--vscode-foreground, inherit)", fontSize: "13px" },
      children: children
    });
  };
}
