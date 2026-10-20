import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { installDailyGuard } = require("./daily-bootstrap.cjs");
const expected = { key: "abc-v2", identity: { host: { id: "md.obsidian", version: "1.14.4", build: "389" }, path: "/installed.apk", size: 10, mtime: 20 } };
function environment({ accepted = false, changed = false, recovery = null } = {}) {
  let now = 0, interval;
  const calls = [], storage = new Map(recovery ? [["native-lsd-recovery", JSON.stringify(recovery)]] : []);
  const win = {
    performance: { now: () => now }, document: { visibilityState: "visible" },
    setInterval: callback => (interval = callback, 1), clearInterval: () => { interval = null; },
    fetch: async () => ({ json: async () => ({ key: expected.key, passed: accepted }) }),
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    Capacitor: { nativePromise: async (plugin, method) => {
      calls.push(method);
      if (method === "getInfo") return expected.identity.host;
      if (method === "stat") return { size: changed ? 11 : 10, mtime: 20 };
      return {};
    } },
  };
  vm.runInNewContext(`(${installDailyGuard.toString()})(win,expected)`, { win, expected, Date: { now: () => now }, Promise, JSON, Error, Math });
  return { win, calls, storage, tick: ms => { now += ms; interval?.(); } };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test("cached startup performs small native checks and no resource rebuild or persistence", async () => {
  const env = environment({ accepted: true });
  env.win.app = { workspace: { layoutReady: true }, plugins: { getPlugin: () => null } };
  await flush(); env.tick(250); await flush();
  assert.equal(env.win.__nativeLsdDailyBoot.phase, "ready");
  assert.deepEqual(env.calls, ["getInfo", "stat"]);
});
test("unknown cache waits for validation; same-version APK replacement restores official resources", async () => {
  const env = environment();
  await flush(); env.tick(250);
  assert.equal(env.win.__nativeLsdDailyBoot.phase, "starting");
  assert.equal(env.win.__nativeLsdDailyBoot.finish(), true);
  const changed = environment({ changed: true });
  await flush();
  assert.equal(changed.win.__nativeLsdDailyBoot.phase, "restoring");
  assert.ok(changed.calls.includes("setServerAssetPath"));
});
test("recovery marker blocks repeat loads and inactive time does not trigger the watchdog", async () => {
  const failed = environment({ recovery: { key: expected.key } });
  assert.equal(failed.win.__nativeLsdDailyBoot.phase, "restoring");
  assert.deepEqual(failed.calls, ["setServerAssetPath"]);
  const hidden = environment();
  await flush();
  hidden.win.document.visibilityState = "hidden";
  hidden.tick(200000);
  hidden.win.document.visibilityState = "visible";
  hidden.tick(200000);
  assert.equal(hidden.win.__nativeLsdDailyBoot.phase, "starting");
  for (let i = 0; i < 480; i++) hidden.tick(250);
  assert.equal(hidden.win.__nativeLsdDailyBoot.phase, "restoring");
});
