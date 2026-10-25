/*
 * Companion per-project model+effort preference (pure, dependency-free payload).
 *
 * Injected verbatim into the official Codex extension host (out/extension.js,
 * CommonJS) by scripts/officialModelTransform.cjs. It MUST NOT import/require
 * anything, MUST NOT touch globalThis, and MUST NOT export - it is evaluated as
 * a plain script in the extension host scope. Keep it self-contained.
 *
 * Runtime dependencies (guaranteed by the accepted history + watchdog + title
 * baseline, injected earlier in the same scope):
 *   - cR(): returns the current window's authoritative workspace-root fsPaths.
 *   - __companionNormalizedRoots(roots): normalizes + dedupes root paths.
 *
 * Storage contract:
 *   workspaceState key: "companion.projectModel.v1"
 *   value: { v:1, byProject: { "<hex(fnv1a(sorted normalized roots joined by \0))>":
 *              { model:string, effort:string, updatedAt:number,
 *                intentAt:number|null, source:"picker" } } }
 *
 *   Only the picker-selected handler writes. Hydration/default/fallback must
 *   never write. Empty normalized roots -> no project key -> no persistence.
 *   intentAt is the picker invocation timestamp; a delayed older promise may
 *   not overwrite a newer successful choice for the same project.
 *
 * Exported-in-scope signature (status worker's getState calls this):
 *   function __companionWorkflowGetProjectModel(provider)
 *     -> {model:string,effort:string}|null (synchronous VS Code Memento)
 *   It reads provider.__companionWorkflowContext.workspaceState (a TRUE
 *   ExtensionContext installed by the status worker after the host ctor).
 */

function __companionModelStoreKey() {
  return "companion.projectModel.v1";
}

function __companionModelValidatePair(model, effort) {
  if (typeof model !== "string" || model.length === 0 || model.length > 200) return null;
  if (typeof effort !== "string" || effort.length === 0 || effort.length > 100) return null;
  return { model: model, effort: effort };
}

// FNV-1a 32-bit, hex. Deterministic, no crypto module dependency.
function __companionModelHash(s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

// Stable per-project key: digest of the sorted, normalized, deduped roots.
// Returns null when there are no valid roots (nothing to scope a project by).
function __companionModelProjectKey(roots) {
  var rn;
  try {
    rn = typeof __companionNormalizedRoots === "function" ? __companionNormalizedRoots(roots) : [];
  } catch (e) {
    rn = [];
  }
  rn = rn.slice().sort();
  if (rn.length === 0) return null;
  return __companionModelHash(rn.join("\0"));
}

function __companionModelNormalizeStored(value) {
  if (value === null || typeof value !== "object") return null;
  var by = value.byProject;
  if (by === null || typeof by !== "object") return null;
  var out = {};
  for (var k in by) {
    if (!Object.prototype.hasOwnProperty.call(by, k)) continue;
    var entry = by[k];
    var pair = __companionModelValidatePair(entry && entry.model, entry && entry.effort);
    if (pair === null) continue;
    out[k] = {
      model: pair.model,
      effort: pair.effort,
      updatedAt: typeof (entry && entry.updatedAt) === "number" ? entry.updatedAt : 0,
      intentAt:
        typeof (entry && entry.intentAt) === "number" && isFinite(entry.intentAt)
          ? entry.intentAt
          : null,
      source: "picker"
    };
  }
  return { v: 1, byProject: out };
}

// Serialized writes: every write chains after the previous one, and a failed
// write is swallowed so it can neither corrupt the store nor interrupt the chat.
var __companionModelWriteChain = Promise.resolve();

function __companionModelWrite(provider, pair, intentAt) {
  var ctx = provider && provider.__companionWorkflowContext;
  var ws = ctx && ctx.workspaceState;
  var roots;
  try {
    roots = cR();
  } catch (e) {
    roots = [];
  }
  var key = __companionModelProjectKey(roots);
  if (
    key === null ||
    ws === null ||
    typeof ws !== "object" ||
    typeof ws.get !== "function" ||
    typeof ws.update !== "function"
  ) {
    return Promise.resolve(false);
  }
  var invocationAt =
    typeof intentAt === "number" && isFinite(intentAt) ? intentAt : null;
  var run = __companionModelWriteChain.then(function () {
    return Promise.resolve(ws.get(__companionModelStoreKey())).then(function (current) {
      var base = __companionModelNormalizeStored(current);
      var by = base === null ? {} : base.byProject;
      // An older picker invocation must not overwrite a newer deliberate pick
      // that already reached the store (writes are serialized but promises can
      // settle out of order across webviews).
      var existing = by[key];
      if (
        invocationAt !== null &&
        existing &&
        typeof existing.intentAt === "number" &&
        invocationAt < existing.intentAt
      ) {
        return false;
      }
      by[key] = {
        model: pair.model,
        effort: pair.effort,
        updatedAt: Date.now(),
        intentAt: invocationAt === null ? Date.now() : invocationAt,
        source: "picker"
      };
      return ws.update(__companionModelStoreKey(), { v: 1, byProject: by });
    });
  });
  __companionModelWriteChain = run.then(
    function () {},
    function () {}
  );
  return run;
}

function __companionWorkflowGetProjectModel(provider) {
  var ctx = provider && provider.__companionWorkflowContext;
  var ws = ctx && ctx.workspaceState;
  if (ws === null || typeof ws !== "object" || typeof ws.get !== "function") return null;
  var roots;
  try {
    roots = cR();
  } catch (e) {
    roots = [];
  }
  var key = __companionModelProjectKey(roots);
  if (key === null) return null;
  try {
    var value = ws.get(__companionModelStoreKey());
    var base = __companionModelNormalizeStored(value);
    if (base === null) return null;
    var entry = base.byProject[key];
    return __companionModelValidatePair(entry && entry.model, entry && entry.effort);
  } catch (e) {
    return null;
  }
}
