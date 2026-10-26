"use strict";
/*
 * Pure transform for the Vite `__vitePreload` helper in the official ChatGPT
 * 26.1021.22027 webview entry bundle.
 *
 * The pristine helper obtains document.getElementsByTagName("link") once per
 * invocation, but then scans that growing live collection for EVERY
 * dependency: 3,203 new dependencies produce ~5.1M href comparisons.
 * This work is one measurable part of webview startup. This module rewrites
 * only that helper so each call builds one index of the links that already
 * exist: a Set of every href (JS/modulepreload identity) and a Set of
 * stylesheet hrefs (CSS identity). Both sets are local to the call and rebuilt
 * on every call: no stale cross-call index, no persistent state.
 *
 * Preserved: dedup cache `x`, URL identity, `rel === "stylesheet"` CSS
 * condition, nonce lookup/attribute, crossOrigin, rel/as selection, insertion
 * order, CSS load/error promises, vite:preloadError dispatch/cancel flow,
 * import callback, and the import.meta.resolve/URL fallbacks.
 *
 * The source is hash-pinned; the bundle is treated as text and never evaluated.
 */

const crypto = require("node:crypto");

const SUPPORTED_VERSION = "26.1021.22027";
const FILE = "webview/assets/app-initial-13f932cb2f13.js";
const ORIGINAL_HASH = "9852ece5b9a25906b654fa8cccd77873105fe1b88556b141fc35dc4062511629";
const PATCHED_HASH = "3753642aab9026fe1fdf361530612b6a3864ec7c084e68778c6f7f003e7c549e";

const ORIGINAL_HELPER =
  "S=function(e,t,n){let r=Promise.resolve();if(t&&t.length>0){let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);function o(e){return Promise.all(e.map(e=>Promise.resolve(e).then(e=>({status:`fulfilled`,value:e}),e=>({status:`rejected`,reason:e}))))}function s(e){return import.meta.resolve?import.meta.resolve(e):new URL(e,import.meta.url).href}r=o(t.map(t=>{if(t=b(t,n),t=s(t),t in x)return;x[t]=!0;let r=t.endsWith(`.css`);for(let n=e.length-1;n>=0;n--){let i=e[n];if(i.href===t&&(!r||i.rel===`stylesheet`))return}let i=document.createElement(`link`);if(i.rel=r?`stylesheet`:y,r||(i.as=`script`),i.crossOrigin=``,i.href=t,a&&i.setAttribute(`nonce`,a),document.head.appendChild(i),r)return new Promise((e,n)=>{i.addEventListener(`load`,e),i.addEventListener(`error`,()=>n(Error(`Unable to preload CSS for ${t}`)))})}))}function i(e){let t=new Event(`vite:preloadError`,{cancelable:!0});if(t.payload=e,window.dispatchEvent(t),!t.defaultPrevented)throw e}return r.then(t=>{for(let e of t||[])e.status===`rejected`&&i(e.reason);return e().catch(i)})}";

const LINK_DECLARATION =
  "let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`);";
const LINK_INDEX =
  "let e=document.getElementsByTagName(`link`),i=document.querySelector(`meta[property=csp-nonce]`),a=i?.nonce||i?.getAttribute(`nonce`),u=new Set,h=new Set;for(let c=e.length-1;c>=0;c--){let l=e[c],m=l.href;u.add(m),l.rel===`stylesheet`&&h.add(m)}";
const REVERSE_SCAN =
  "for(let n=e.length-1;n>=0;n--){let i=e[n];if(i.href===t&&(!r||i.rel===`stylesheet`))return}";
const INDEX_LOOKUP = "if(r?h.has(t):u.has(t))return;";

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

function replaceOnce(text, needle, replacement, label) {
  const first = text.indexOf(needle);
  if (first === -1) {
    throw new Error(`preload index: ${label} is missing`);
  }
  if (text.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`preload index: ${label} must occur exactly once`);
  }
  return text.slice(0, first) + replacement + text.slice(first + needle.length);
}

const PATCHED_HELPER = replaceOnce(
  replaceOnce(ORIGINAL_HELPER, LINK_DECLARATION, LINK_INDEX, "link collection declaration"),
  REVERSE_SCAN,
  INDEX_LOOKUP,
  "reverse link scan"
);

/*
 * Structural analysis without a hash check. Exactly one known variant of the
 * helper must be present; transform() still refuses anything whose whole-file
 * hash is not pinned.
 */
function analyze(source) {
  if (typeof source !== "string") {
    throw new TypeError("preload index: source must be a string");
  }

  const originalCount = countOccurrences(source, ORIGINAL_HELPER);
  const patchedCount = countOccurrences(source, PATCHED_HELPER);
  if (originalCount + patchedCount !== 1) {
    throw new Error(
      `preload index: known preload helper must occur exactly once (original ${originalCount}, indexed ${patchedCount})`
    );
  }

  const patched = patchedCount === 1;
  const helper = patched ? PATCHED_HELPER : ORIGINAL_HELPER;
  const helperStart = source.indexOf(helper);
  return {
    version: SUPPORTED_VERSION,
    file: FILE,
    patched,
    helperStart,
    helperEnd: helperStart + helper.length,
    helperLength: helper.length,
  };
}

function transform(source) {
  if (typeof source !== "string") {
    throw new TypeError("preload index: source must be a string");
  }

  const inputHash = sha256(source);
  if (inputHash === PATCHED_HASH) return source;
  if (inputHash !== ORIGINAL_HASH) {
    throw new Error(
      `preload index: unsupported ${FILE} SHA256 ${inputHash}; expected ${ORIGINAL_HASH}`
    );
  }

  const info = analyze(source);
  if (info.patched) {
    throw new Error("preload index: pristine preload helper is missing");
  }

  const output =
    source.slice(0, info.helperStart) + PATCHED_HELPER + source.slice(info.helperEnd);
  const outputHash = sha256(output);
  if (outputHash !== PATCHED_HASH) {
    throw new Error(
      `preload index: deterministic output SHA256 ${outputHash} does not match ${PATCHED_HASH}`
    );
  }
  return output;
}

module.exports = {
  SUPPORTED_VERSION,
  FILE,
  ORIGINAL_HASH,
  PATCHED_HASH,
  transform,
  analyze,
};

if (require.main === module) {
  process.stderr.write("officialPreloadIndex.cjs exports pure transforms only\n");
  process.exitCode = 2;
}
