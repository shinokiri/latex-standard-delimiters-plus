const { unzipSync } = require("fflate");
const { safeAsset, digest } = require("./trial-core.cjs");
const { foregroundOperation } = require("./trial-async.cjs");
const MAX_APK = 64 * 1024 * 1024;
const MAX_ASSETS = 64 * 1024 * 1024;

function ownApkFromMaps(maps) {
  if (typeof maps !== "string" || maps.length > 8 * 1024 * 1024) throw Error("invalid-process-maps");
  const paths = new Set(maps.match(/\/data\/app\/(?:[a-zA-Z0-9_~.+=-]+\/)*md\.obsidian-[a-zA-Z0-9_+=-]+\/base\.apk/g));
  if (paths.size !== 1) throw Error("installed-obsidian-apk-not-identified");
  return [...paths][0];
}

function extractPublicAssets(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > MAX_APK) {
    throw Error("unsupported-apk-size");
  }
  const seen = new Map();
  let total = 0;
  const contents = unzipSync(bytes, { filter(file) {
    if (!file.name.startsWith("assets/public/") || file.name.endsWith("/")) return false;
    const path = file.name.slice("assets/public/".length);
    if (!safeAsset(path) || seen.has(path) || seen.size >= 2048 ||
        !Number.isSafeInteger(file.originalSize) || file.originalSize < 0 ||
        file.originalSize > 16 * 1024 * 1024 || ![0, 8].includes(file.compression)) {
      throw Error("invalid-apk-resource");
    }
    total += file.originalSize;
    if (total > MAX_ASSETS) throw Error("apk-resources-too-large");
    seen.set(path, file.originalSize);
    return true;
  } });
  const assets = new Map();
  for (const [name, data] of Object.entries(contents)) {
    const path = name.slice("assets/public/".length);
    if (data.byteLength !== seen.get(path)) throw Error("apk-resource-size-mismatch");
    assets.set(path, data);
  }
  if (!["app.js", "worker.js", "index.html"].every(path => assets.has(path))) throw Error("apk-resources-incomplete");
  return assets;
}

async function packageIdentity(plugin) {
  const info = await plugin.native("App", "getInfo");
  if (info.id !== "md.obsidian") throw Error("wrong-application");
  const maps = await plugin.native("Filesystem", "readFile", { path: "/proc/self/maps", encoding: "utf8" });
  const path = ownApkFromMaps(maps.data);
  const before = await plugin.native("Filesystem", "stat", { path });
  if (before.type !== "file" || !Number.isSafeInteger(before.size) || before.size > MAX_APK || before.size < 22) {
    throw Error("unsupported-apk-size");
  }
  return { host: { id: info.id, version: info.version, build: String(info.build) }, path, size: before.size, mtime: before.mtime };
}
async function readInstalledPackage(plugin) {
  const identity = await packageIdentity(plugin);
  const { host: info, path, size, mtime } = identity;
  const url = new URL(window.Capacitor.convertFileSrc("file://" + path));
  if (url.origin !== location.origin || !url.pathname.startsWith("/_capacitor_file_/data/app/")) {
    throw Error("unexpected-package-file-url");
  }
  const controller = new AbortController();
  let bytes;
  try {
    bytes = await foregroundOperation(async () => {
      const response = await fetch(url.href, {
        cache: "no-store", redirect: "error", credentials: "same-origin", signal: controller.signal,
      });
      if (!response.ok) throw Error("package-read-failed");
      const reader = response.body.getReader(), chunks = [];
      let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > size || length > MAX_APK) {
          await reader.cancel();
          throw Error("package-size-changed");
        }
        chunks.push(value);
      }
      if (length !== size) throw Error("package-size-changed");
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
      return output;
    }, { document, signal: plugin.calls.signal, timeoutMs: 30000, timeoutMessage: "package-read-timeout" });
  } finally { controller.abort(); }
  const after = await plugin.native("Filesystem", "stat", { path });
  const latest = await plugin.native("App", "getInfo");
  if (size !== after.size || mtime !== after.mtime ||
      info.version !== latest.version || String(info.build) !== String(latest.build)) throw Error("application-updated-during-read");
  return {
    host: { id: info.id, version: info.version, build: String(info.build) },
    identity,
    apkBytes: bytes.length, apkSha256: await digest(bytes),
    assets: extractPublicAssets(bytes),
  };
}

async function inspectInstalledPackage(plugin) {
  const pkg = await readInstalledPackage(plugin);
  const hashes = {};
  for (const name of ["app.js", "worker.js"]) hashes[name] = await digest(pkg.assets.get(name));
  return {
    at: new Date().toISOString(), host: pkg.host, apkBytes: pkg.apkBytes,
    apkSha256: pkg.apkSha256, assets: pkg.assets.size,
    assetBytes: [...pkg.assets.values()].reduce((sum, data) => sum + data.length, 0),
    coreHashes: hashes, shizukuRequired: false,
  };
}

module.exports = { ownApkFromMaps, extractPublicAssets, packageIdentity, readInstalledPackage, inspectInstalledPackage };
