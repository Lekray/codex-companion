"use strict";
/*
 * Pure drafts-stage transform for the official ChatGPT 26.1021.22027 webview.
 *
 * The optional user-message navigation rail is a lazy import. Its native
 * Vite-generated dependency table contains 2,775 entries: 143 real CSS files
 * and 2,632 speculative JavaScript modulepreloads. The JS graph is already
 * loaded by ordinary ES imports, so the rail's preload list only needs the
 * CSS entries. The same lazy factory also propagates load errors; disabling
 * that lets the native 200 ms retry finish locally and keeps the chat mounted.
 * The URL table itself stays byte-identical; only the preload argument changes.
 *
 * This module never evaluates the source. It parses the exact JSON dependency
 * table and validates the pinned pristine bundle before replacing exactly two
 * spans: the preload index list and the propagateLoadError flag.
 */

const crypto = require("node:crypto");

const SUPPORTED_VERSION = "26.1021.22027";
const FILE = "webview/assets/bookmarked-thread-user-message-navigation-36a0dadf9f5d.js";
const ORIGINAL_HASH = "6295d2141f11872bb070e03049e326a7cc340bd6ffdb3761f5a80bea88ba186b";
const PATCHED_HASH = "dc3e4c4bb1abf3b8b85ad2565e390eb4067a2f322becf038a1c9792ac03e3285";

const DEPENDENCY_COUNT = 2775;
const CSS_DEPENDENCY_COUNT = 143;
const JS_DEPENDENCY_COUNT = 2632;

const MAP_PREFIX = "const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=";
const MAP_CLOSING = "])))=>i.map(i=>d[i]);";

const FACTORY_PREFIX =
  "j=d(async()=>(await n(async()=>{let{AppThreadUserMessageNavigationRail:e}=await import(`./thread-user-message-navigation-rail-app-e1fd1e68ad98.js`);return{AppThreadUserMessageNavigationRail:e}},__vite__mapDeps([";
const FACTORY_SUFFIX =
  "]),import.meta.url)).AppThreadUserMessageNavigationRail,{propagateLoadError:!0})";

const PROPAGATE_TRUE = "propagateLoadError:!0";
const PROPAGATE_FALSE = "propagateLoadError:!1";
const INDEX_LIST = /^(?:0|[1-9]\d*)(?:,(?:0|[1-9]\d*))*$/;

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function countOccurrences(text, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    from = index + needle.length;
  }
}

function requireUnique(text, needle, label) {
  const count = countOccurrences(text, needle);
  if (count !== 1) {
    throw new Error(`webview recovery: ${label} must occur exactly once (found ${count})`);
  }
  return text.indexOf(needle);
}

/*
 * Classify a dependency by its URL pathname. Do not use substring checks such
 * as endsWith(".js") on the whole URL: names like "x.css?cache=.js" or
 * "x.css.js" must not change which asset is preloaded.
 */
function dependencyKind(url) {
  if (typeof url !== "string" || !url.startsWith("./")) {
    throw new Error(`webview recovery: dependency URL is not local: ${JSON.stringify(url)}`);
  }
  const pathname = new URL(url, "https://dependencies.invalid/").pathname;
  const slash = pathname.lastIndexOf("/");
  const dot = pathname.lastIndexOf(".");
  const extension = dot > slash ? pathname.slice(dot) : "";
  if (extension === ".css") return "css";
  if (extension === ".js") return "js";
  throw new Error(`webview recovery: unsupported dependency extension: ${JSON.stringify(url)}`);
}

function parseDependencies(source) {
  const prefixStart = requireUnique(source, MAP_PREFIX, "dependency table prefix");
  const mapStart = prefixStart + MAP_PREFIX.length;
  const mapEnd = requireUnique(source, MAP_CLOSING, "dependency table closing seam");
  if (mapEnd < mapStart) {
    throw new Error("webview recovery: dependency table closing seam precedes its prefix");
  }

  let dependencies;
  try {
    dependencies = JSON.parse(source.slice(mapStart, mapEnd + 1));
  } catch (error) {
    throw new Error(`webview recovery: dependency table is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(dependencies)) {
    throw new Error("webview recovery: dependency table is not an array");
  }
  if (dependencies.length !== DEPENDENCY_COUNT) {
    throw new Error(
      `webview recovery: dependency table must contain ${DEPENDENCY_COUNT} entries (found ${dependencies.length})`
    );
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new Error("webview recovery: dependency URLs must be unique");
  }

  const kinds = dependencies.map(dependencyKind);
  return { dependencies, kinds, mapStart, mapEnd, mapEndExclusive: mapEnd + 1 };
}

/*
 * Structural analysis without a hash check, so callers and tests can inspect
 * broken/duplicated seams directly. transform() never trusts this output until
 * the pinned original hash has matched.
 */
function analyze(source) {
  if (typeof source !== "string") {
    throw new TypeError("webview recovery: source must be a string");
  }

  const map = parseDependencies(source);

  const factoryStart = requireUnique(source, FACTORY_PREFIX, "lazy factory prefix");
  if (factoryStart < map.mapEnd) {
    throw new Error("webview recovery: lazy factory precedes the dependency table");
  }
  const listStart = factoryStart + FACTORY_PREFIX.length;
  const listEnd = requireUnique(source, FACTORY_SUFFIX, "lazy factory suffix");
  if (listEnd < listStart) {
    throw new Error("webview recovery: lazy factory suffix precedes its dependency list");
  }

  const listText = source.slice(listStart, listEnd);
  if (!INDEX_LIST.test(listText)) {
    throw new Error("webview recovery: dependency index list is malformed");
  }
  const indices = listText.split(",").map(Number);
  if (indices.length !== DEPENDENCY_COUNT) {
    throw new Error(
      `webview recovery: dependency index list must contain ${DEPENDENCY_COUNT} entries (found ${indices.length})`
    );
  }
  for (let index = 0; index < indices.length; index += 1) {
    if (indices[index] !== index) {
      throw new Error(`webview recovery: dependency index list is not exactly 0..${DEPENDENCY_COUNT - 1}`);
    }
  }

  const propagateStart = requireUnique(source, PROPAGATE_TRUE, "propagateLoadError flag");
  const expectedPropagateStart = listEnd + FACTORY_SUFFIX.indexOf(PROPAGATE_TRUE);
  if (propagateStart !== expectedPropagateStart) {
    throw new Error("webview recovery: propagateLoadError flag is outside the lazy factory");
  }
  if (source.includes(PROPAGATE_FALSE)) {
    throw new Error("webview recovery: propagateLoadError flag is already disabled");
  }

  const cssDependencyCount = map.kinds.filter((kind) => kind === "css").length;
  const jsDependencyCount = map.kinds.filter((kind) => kind === "js").length;
  if (cssDependencyCount !== CSS_DEPENDENCY_COUNT || jsDependencyCount !== JS_DEPENDENCY_COUNT) {
    throw new Error(
      `webview recovery: unexpected dependency mix (CSS ${cssDependencyCount}, JS ${jsDependencyCount})`
    );
  }

  const retainedDependencyIndices = [];
  for (let index = 0; index < map.kinds.length; index += 1) {
    if (map.kinds[index] === "css") retainedDependencyIndices.push(index);
  }

  let removedDependencyCount = 0;
  for (const kind of map.kinds) {
    if (kind !== "css") removedDependencyCount += 1;
  }

  return {
    version: SUPPORTED_VERSION,
    file: FILE,
    dependencyCount: map.dependencies.length,
    cssDependencyCount,
    jsDependencyCount,
    dependencies: map.dependencies,
    kinds: map.kinds,
    retainedDependencyIndices,
    retainedDependencyUrls: retainedDependencyIndices.map((index) => map.dependencies[index]),
    removedDependencyCount,
    mapStart: map.mapStart,
    mapEnd: map.mapEnd,
    mapEndExclusive: map.mapEndExclusive,
    factoryStart,
    listStart,
    listEnd,
    propagateStart,
  };
}

function transform(source) {
  if (typeof source !== "string") {
    throw new TypeError("webview recovery: source must be a string");
  }

  const inputHash = sha256(source);
  if (inputHash === PATCHED_HASH) return source;
  if (inputHash !== ORIGINAL_HASH) {
    throw new Error(
      `webview recovery: unsupported ${FILE} SHA256 ${inputHash}; expected ${ORIGINAL_HASH}`
    );
  }

  const info = analyze(source);
  const replacement = info.retainedDependencyIndices.join(",");
  const output = source.slice(0, info.listStart) + replacement + source.slice(info.listEnd);
  const shift = replacement.length - (info.listEnd - info.listStart);
  const propagateStart = info.propagateStart + shift;

  const patched =
    output.slice(0, propagateStart) +
    PROPAGATE_FALSE +
    output.slice(propagateStart + PROPAGATE_TRUE.length);

  const outputHash = sha256(patched);
  if (outputHash !== PATCHED_HASH) {
    throw new Error(
      `webview recovery: deterministic output SHA256 ${outputHash} does not match ${PATCHED_HASH}`
    );
  }
  return patched;
}

module.exports = {
  SUPPORTED_VERSION,
  FILE,
  ORIGINAL_HASH,
  PATCHED_HASH,
  DEPENDENCY_COUNT,
  CSS_DEPENDENCY_COUNT,
  JS_DEPENDENCY_COUNT,
  MAP_PREFIX,
  MAP_CLOSING,
  FACTORY_PREFIX,
  FACTORY_SUFFIX,
  PROPAGATE_TRUE,
  PROPAGATE_FALSE,
  dependencyKind,
  transform,
  analyze,
};

if (require.main === module) {
  process.stderr.write("officialWebviewRecovery.cjs exports pure transforms only\n");
  process.exitCode = 2;
}
