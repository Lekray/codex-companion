"use strict";
/* Pure transform of the exact composer lazy entry, never of its implementation.
 * Keep the dependency URL table and CSS order, prune only speculative JS links.
 * Both native roots remain native import() calls; only a failed root receives
 * one of five bounded retry queries. Existing draft/task state stays above this
 * composer-local loader; runtime errors still reach the native error boundary.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const SUPPORTED_VERSION = "26.1021.22027";
const FILE = "webview/assets/thread-composer-content-lazy-720f6fb84454.js";
const ORIGINAL_HASH = "072d4d42ee5d7d1f29730cba49c3b729fb655e07c1d29e45dc17621a49642994";
const PATCHED_HASH = "5bd7ab9f002c1425ccc20b566ccc58895d2334fcc7d9a62805460cdcefbcfdc3";
const RESOURCE_FILE = path.resolve(__dirname, "../resources/officialComposerRecovery.js");
const IMPORT = 'import{Xx as t,Yx as n,ym as r}from"./app-initial-13f932cb2f13.js";';
const FACTORY = "s=i(async()=>{let[{ComposerContent:e},{QueuedMessageList:t}]=await Promise.all([";
const END = "]);return function(n){return(0,o.jsx)(e,{...n,queuedMessageList:t})}},{propagateLoadError:!0})";
const ROOTS = ["composer-content-1ca427b8427a.js", "queued-message-list-862b10cb6af9.js"];
function sha256(text) { return crypto.createHash("sha256").update(text, "utf8").digest("hex"); }
function unique(source, needle) {
  const at = source.indexOf(needle);
  if (at < 0 || source.indexOf(needle, at + needle.length) >= 0) throw new Error(`composer recovery: missing or duplicated seam ${needle.slice(0, 70)}`);
  return at;
}
function analyze(source) {
  if (typeof source !== "string") throw new TypeError("composer recovery: source must be a string");
  const prefix = "const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=";
  const start = unique(source, prefix) + prefix.length;
  const end = unique(source, "])))=>i.map(i=>d[i]);") + 1;
  const dependencies = JSON.parse(source.slice(start, end));
  if (!Array.isArray(dependencies) || dependencies.length !== 2776 || new Set(dependencies).size !== 2776) throw new Error("composer recovery: unexpected dependency table");
  dependencies.forEach((entry) => {
    if (typeof entry !== "string" || !/^\.\/[\w@.\/-]+\.(js|css)$/.test(entry)) throw new Error("composer recovery: unsupported dependency URL");
  });
  const factoryStart = unique(source, FACTORY);
  const factoryEnd = unique(source, END) + END.length;
  unique(source, IMPORT);
  const factory = source.slice(factoryStart + FACTORY.length, factoryEnd - END.length);
  const imports = [...factory.matchAll(/n\(\(\)=>import\(`\.\/([^`]+)`\),__vite__mapDeps\(\[([\d,]+)\]\),import\.meta\.url\)/g)];
  if (imports.length !== 2 || imports.map((match) => match[0]).join(",") !== factory) throw new Error("composer recovery: unsupported loader shape");
  const roots = imports.map((match, index) => {
    if (match[1] !== ROOTS[index]) throw new Error("composer recovery: unexpected import root");
    const indices = match[2].split(",").map(Number);
    if (new Set(indices).size !== indices.length || indices.some((i) => !Number.isInteger(i) || i < 0 || i >= dependencies.length)) throw new Error("composer recovery: malformed preload indices");
    return { path: match[1], indices, cssIndices: indices.filter((i) => dependencies[i].endsWith(".css")) };
  });
  const cssDependencyCount = dependencies.filter((entry) => entry.endsWith(".css")).length;
  if (cssDependencyCount !== 143) throw new Error("composer recovery: unexpected CSS count");
  return { dependencies, dependencyCount: dependencies.length, cssDependencyCount, jsDependencyCount: dependencies.length - cssDependencyCount, roots, factoryStart, factoryEnd };
}
function transform(source) {
  if (typeof source !== "string") throw new TypeError("composer recovery: source must be a string");
  const hash = sha256(source);
  if (hash === PATCHED_HASH) return source;
  if (hash !== ORIGINAL_HASH) throw new Error(`composer recovery: unsupported ${FILE} SHA256 ${hash}; expected ${ORIGINAL_HASH}`);
  const info = analyze(source);
  const loaders = info.roots.map((root) => `{path:${JSON.stringify(root.path)},load:function(suffix){return n(()=>import(${JSON.stringify("./" + root.path)}+suffix),__vite__mapDeps([${root.cssIndices.join(",")}]),import.meta.url)}}`).join(",");
  const factory = `s=__companionCreateComposerRecovery(__companionComposerReact(),o,[${loaders}])`;
  const native = (source.slice(0, info.factoryStart) + factory + source.slice(info.factoryEnd)).replace(IMPORT, IMPORT.replace("Xx as t,", "rS as __companionComposerReact,Xx as t,"));
  const payload = fs.readFileSync(RESOURCE_FILE, "utf8").replace(/\r\n/g, "\n");
  const output = payload + "\n" + native;
  if (sha256(output) !== PATCHED_HASH) throw new Error("composer recovery: deterministic output hash mismatch");
  return output;
}
module.exports = { SUPPORTED_VERSION, FILE, ORIGINAL_HASH, PATCHED_HASH, RESOURCE_FILE, transform, analyze };
