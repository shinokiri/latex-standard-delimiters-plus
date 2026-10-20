const ROOT_NAME = ".obsidian-native-delimiters";
const CACHE = /^\/storage\/emulated\/\d+\/\.obsidian-native-delimiters\/[a-f0-9-]{36}\/public$/;
function cacheRoot(vaultPath) {
  const match = /^\/storage\/emulated\/(\d+)\//.exec(vaultPath || "");
  if (!match && !/^\/sdcard\//.test(vaultPath || "")) throw Error("unsupported-vault-storage");
  return `/storage/emulated/${match ? match[1] : "0"}/${ROOT_NAME}`;
}
function ownedCache(path) { return typeof path === "string" && CACHE.test(path); }
function samePackage(a, b) {
  return Boolean(a?.host && b?.host && a.host.id === b.host.id && a.host.version === b.host.version &&
    a.host.build === b.host.build && a.path === b.path && a.size === b.size && a.mtime === b.mtime);
}
function automaticDecision(data, identity, adapter, cacheExists, recovery) {
  if (!data?.auto) return "off";
  if (data.blocked && samePackage(data.blocked.identity, identity) && data.blocked.adapter === adapter) return "blocked";
  // Moving an accepted cache aside is the external recovery switch, including
  // when the user also happened to install an official update.
  if (data.verifiedKey && !cacheExists) return "missing";
  if (["staging", "switching"].includes(data.phase) &&
      samePackage(data.attemptIdentity || data.identity, identity) &&
      (data.attemptAdapter || data.adapter) === adapter) return "block";
  if (!samePackage(data.identity, identity) || data.adapter !== adapter) return "rebuild";
  if (recovery || ["switching", "staging"].includes(data.phase)) return "block";
  if (!cacheExists) return "missing";
  return "cached";
}
module.exports = { cacheRoot, ownedCache, samePackage, automaticDecision };
