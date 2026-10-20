import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
const require = createRequire(import.meta.url);
const identity = { host: { id: "md.obsidian", version: "1.14.4", build: "389" }, path: "/installed.apk", size: 12, mtime: 34 };
const owned = "/storage/emulated/0/.obsidian-native-delimiters/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/public";
async function instance({ native = false, failChecks = false, marker = null } = {}) {
  const calls = [], store = new Map(marker ? [["native-lsd-recovery", JSON.stringify(marker)]] : []);
  const win = {
    Capacitor: { getPlatform: () => "android" },
    __nativeLsdDailyBoot: native ? { key: "test", info: Promise.resolve(identity.host),
      finish: () => (calls.push("finish"), true), restore: reason => calls.push("restore:" + reason) } : null,
  };
  const context = {
    module: { exports: {} }, __DAILY_RUNTIME__: "", __DAILY_ADAPTER__: "v2", __DAILY_VERSION__: "test",
    require(name) {
      if (name === "obsidian") return { Notice: class {}, Modal: class {} };
      if (name === "./trial-plugin.cjs") return class {};
      if (name === "./daily-package.cjs") return { packageIdentity: async () => identity };
      if (name === "./daily-patch.cjs" || name === "./daily-bootstrap.cjs" || name === "./trial-checks.cjs") return {};
      return require(name);
    },
    TextEncoder, TextDecoder, Uint8Array, Date, Promise, Error, Map, Set, JSON, Math, Boolean, AbortController,
    performance: { now: () => 100, timeOrigin: 1000 }, window: win,
    localStorage: { getItem: key => store.get(key), removeItem: key => store.delete(key) },
  };
  vm.runInNewContext(await readFile(new URL("./daily-plugin.cjs", import.meta.url), "utf8"), context);
  const plugin = new context.module.exports();
  Object.assign(plugin, {
    active: true, loadedAt: 50,
    data: { daily: native ? { auto: true, phase: "switching", path: owned, key: "test", adapter: "v2", identity } : { auto: false, phase: "off" } },
    app: { plugins: { enabledPlugins: new Set(), getPlugin: () => null } },
    currentPath: async () => native ? owned : "public",
    native: async (p, method) => { calls.push(method); return {}; },
    cacheExists: async () => native,
    persist: async () => {}, report: async () => {}, restorePlus: async () => {},
    startControl: () => {}, readRequest: async () => {}, writeCache: async () => { calls.push("write-ready"); },
    removePreviousCache: async () => {}, perform: async action => { calls.push(action); },
    saveOpenViews: async () => {},
    verify: async () => {
      calls.push("verify");
      if (failChecks) throw Error("bad-native-behavior");
      plugin.data.daily.tests = { passed: true };
    },
  });
  return { plugin, calls, win };
}
test("first installation with no recovery marker reaches official mode without an exception", async () => {
  const { plugin, calls } = await instance();
  await plugin.initialize();
  assert.equal(plugin.initialized, true);
  assert.equal(plugin.data.daily.phase, "off");
  assert.equal(plugin.data.daily.startup.source, "official");
  assert.deepEqual(calls, []);
});
test("a synced installation on another platform does not read or change Android deployment state", async () => {
  const { plugin, win, calls } = await instance();
  win.Capacitor.getPlatform = () => "web";
  plugin.loadData = async () => { throw Error("must not load Android state"); };
  await plugin.onload();
  assert.deepEqual(calls, []);
});
test("native persistence is written only after compatibility checks and startup health pass", async () => {
  const { plugin, calls } = await instance({ native: true });
  await plugin.initialize();
  assert.deepEqual(calls, ["verify", "write-ready", "finish", "persistServerBasePath"]);
  assert.equal(plugin.data.daily.phase, "active");
  assert.equal(plugin.data.daily.startup.fullChecksRun, true);
});
test("failed native behavior never persists a cache and keeps recovery controls available", async () => {
  const { plugin, calls } = await instance({ native: true, failChecks: true });
  await plugin.initialize();
  assert.deepEqual(calls, ["verify", "restore:compatibility-check-failed"]);
  assert.equal(plugin.data.daily.phase, "blocked");
  assert.equal(plugin.initialized, true);
});
test("APK preparation failure is blocked against the attempted update, not the previous cached package", async () => {
  const { plugin } = await instance();
  plugin.data.daily.identity = { ...identity, host: { ...identity.host, version: "1.14.3" } };
  plugin.data.daily.adapter = "v1";
  plugin.prepare = async () => { throw Error("package-read-failed"); };
  await Object.getPrototypeOf(plugin).perform.call(plugin, "rebuild");
  assert.equal(plugin.data.daily.blocked.identity.host.version, "1.14.4");
  assert.equal(plugin.data.daily.blocked.reason, "package-read-failed");
  const { automaticDecision } = require("./daily-state.cjs");
  assert.equal(automaticDecision(plugin.data.daily, identity, "v2", false, false), "blocked");
});
test("subsequent native boots omit full tests and do not edit or create test notes", async () => {
  const { plugin, calls } = await instance({ native: true });
  plugin.data.daily.phase = "active";
  plugin.data.daily.verifiedKey = "test";
  plugin.data.daily.persistent = true;
  await plugin.initialize();
  assert.deepEqual(calls, ["finish"]);
  assert.equal(plugin.data.daily.startup.fullChecksRun, false);
});
