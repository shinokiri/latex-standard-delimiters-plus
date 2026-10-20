/* Pure guards shared by the loader and its tests. */
const PRIVATE_ROOT = "native-delimiter-trial/";
const HOST = Object.freeze({
  version: "1.14.4", build: "389",
  app: "7591ddf1df0414b26af79b9ae7fcaffc0f210332686520523fc3a391d675800e",
  worker: "a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae",
});
function applyInsertions(source, insertions) {
  let previous = -1;
  for (const { at, text } of insertions) {
    if (!Number.isSafeInteger(at) || at < 0 || at > source.length || at <= previous || typeof text !== "string") {
      throw new Error("invalid-patch-plan");
    }
    previous = at;
  }
  let output = source;
  for (const { at, text } of [...insertions].reverse()) output = output.slice(0, at) + text + output.slice(at);
  return output;
}
function removeInsertions(output, insertions) {
  let added = 0;
  const ranges = insertions.map(({ at, text }) => {
    const range = { at: at + added, text };
    added += text.length;
    return range;
  });
  let source = output;
  for (const { at, text } of ranges.reverse()) {
    if (source.slice(at, at + text.length) !== text) throw new Error("patched-resource-mismatch");
    source = source.slice(0, at) + source.slice(at + text.length);
  }
  return source;
}
function safeAsset(path) {
  return typeof path === "string" && path.length > 0 && path.length < 240 &&
    !path.startsWith("/") && !/[\\?#%:\u0000-\u001f]/.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== "..");
}
function safePrivateBase(path) {
  return typeof path === "string" && /^native-delimiter-trial\/[a-f0-9-]{36}\/public$/.test(path);
}
function validatePlan(plan) {
  if (plan?.schema !== 1 || plan.version !== HOST.version || plan.build !== HOST.build ||
      !Array.isArray(plan.assets) || plan.assets.length !== 325) throw new Error("invalid-plan");
  const seen = new Set();
  let bytes = 0;
  for (const item of plan.assets) {
    if (!safeAsset(item.path) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 16 * 1024 * 1024) {
      throw new Error("invalid-asset");
    }
    seen.add(item.path);
    bytes += item.bytes;
    if (item.sourceSha256 != null && !/^[a-f0-9]{64}$/.test(item.sourceSha256)) throw new Error("invalid-source-hash");
    if (item.insertions && !["app.js", "worker.js", "index.html"].includes(item.path)) throw new Error("unexpected-patch");
    if (item.ownSource != null && item.path !== "native-lsd-trial-bootstrap.js") throw new Error("unexpected-own-resource");
    if (item.localOnly && (!item.path.startsWith("lib/pdfjs/") ||
        !item.path.split("/").at(-1).startsWith("LICENSE") || item.bytes >= 16384)) throw new Error("unexpected-local-resource");
  }
  if (bytes > 64 * 1024 * 1024 ||
      !["app.js", "worker.js", "index.html", "native-lsd-trial-bootstrap.js"].every(name => seen.has(name))) {
    throw new Error("incomplete-plan");
  }
  if (plan.assets.find(item => item.path === "app.js").sourceSha256 !== HOST.app ||
      plan.assets.find(item => item.path === "worker.js").sourceSha256 !== HOST.worker) {
    throw new Error("unsupported-host");
  }
  return plan;
}
async function digest(bytes) {
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(result), value => value.toString(16).padStart(2, "0")).join("");
}
function toBase64(bytes) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(text);
}
function fromBase64(text) {
  return Uint8Array.from(atob(text), value => value.charCodeAt(0));
}
function ownedAbsolutePath(uri, base) {
  if (!safePrivateBase(base)) throw new Error("invalid-private-base");
  const url = new URL(uri);
  const path = decodeURIComponent(url.pathname);
  if (url.protocol !== "file:" || url.host ||
      !/^\/data\/(?:user\/\d+|data)\/md\.obsidian\/files\//.test(path) ||
      !path.endsWith("/" + base) || path.includes("/../")) throw new Error("unexpected-private-path");
  return path;
}
module.exports = { PRIVATE_ROOT, HOST, applyInsertions, removeInsertions, safeAsset, safePrivateBase, validatePlan, digest, toBase64, fromBase64, ownedAbsolutePath };
