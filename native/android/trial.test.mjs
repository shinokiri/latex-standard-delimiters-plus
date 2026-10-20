import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const { installTrialGuard } = require("./trial-bootstrap.cjs");
const { applyInsertions, removeInsertions, safeAsset, safePrivateBase, ownedAbsolutePath, toBase64, fromBase64, digest } = require("./trial-core.cjs");

test("insertion-only delivery preserves host source and rejects ambiguous offsets", () => {
  const source = "a😀b()";
  const insertions = [{ at: 0, text: "prefix" }, { at: 4, text: "wrap(" }, { at: source.length, text: ")suffix" }];
  const patched = applyInsertions(source, insertions);
  assert.equal(removeInsertions(patched, insertions), source);
  assert.throws(() => applyInsertions(source, [{ at: 0, text: "a" }, { at: 0, text: "b" }]), /invalid/);
  assert.throws(() => applyInsertions(source, [{ at: -1, text: "a" }]), /invalid/);
  assert.throws(() => removeInsertions("modified" + patched, insertions), /mismatch/);
});

test("resource and cleanup paths stay inside the owned Android files directory", () => {
  const base = "native-delimiter-trial/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/public";
  assert.ok(safePrivateBase(base));
  assert.equal(ownedAbsolutePath("file:///data/user/0/md.obsidian/files/" + base, base), "/data/user/0/md.obsidian/files/" + base);
  for (const path of ["../notes", "/absolute", "a/../b", "a\\b", "a%2fb", "a?b", "a#b", "a//b"]) assert.equal(safeAsset(path), false);
  for (const uri of [
    "file:///sdcard/" + base,
    "file:///data/user/0/another.app/files/" + base,
    "file:///data/user/0/md.obsidian/files/../" + base,
    "https://localhost/" + base,
  ]) assert.throws(() => ownedAbsolutePath(uri, base));
});

test("binary resource transfer preserves arbitrary bytes and large inputs", () => {
  const data = Uint8Array.from({ length: 200000 }, (_, i) => i % 256);
  assert.deepEqual(fromBase64(toBase64(data)), data);
});

function fakeWindow(info = { id: "md.obsidian", version: "1.14.4", build: "389" }) {
  let timeout;
  const calls = [], saved = [];
  return {
    calls, saved, runTimeout: () => timeout?.(),
    setTimeout(callback) { timeout = callback; return 1; },
    clearTimeout() { timeout = null; },
    sessionStorage: { setItem: (...args) => saved.push(args) },
    Capacitor: { nativePromise: async (plugin, method, options) => {
      calls.push({ plugin, method, options });
      return method === "getInfo" ? info : {};
    } },
  };
}

test("startup watchdog restores official assets once without persisting any path", async () => {
  const win = fakeWindow();
  installTrialGuard(win, { version: "1.14.4", build: "389" });
  await Promise.resolve();
  win.runTimeout();
  win.__nativeLsdTrialBoot.restore("again");
  assert.equal(win.calls.filter(call => call.method === "setServerAssetPath").length, 1);
  assert.equal(win.calls.some(call => call.method === "persistServerBasePath"), false);
  assert.equal(win.__nativeLsdTrialBoot.finish(), false);
});

test("healthy startup cancels watchdog; unknown binary restores immediately", async () => {
  const win = fakeWindow();
  installTrialGuard(win, { version: "1.14.4", build: "389" });
  await Promise.resolve();
  assert.equal(win.__nativeLsdTrialBoot.finish(), true);
  win.runTimeout();
  assert.equal(win.calls.length, 1);
  const updated = fakeWindow({ id: "md.obsidian", version: "1.14.5", build: "390" });
  installTrialGuard(updated, { version: "1.14.4", build: "389" });
  await Promise.resolve();
  assert.equal(updated.__nativeLsdTrialBoot.phase, "restoring");
  assert.equal(updated.calls[1].method, "setServerAssetPath");
});

async function pluginClass() {
  const context = {
    module: { exports: {} }, __TRIAL_PLAN__: {},
    require(name) {
      if (name === "obsidian") return { Plugin: class {}, Notice: class {}, Modal: class {} };
      if (name === "./trial-core.cjs" || name === "./trial-async.cjs") return require(name);
      if (name === "./trial-checks.cjs" || name === "./daily-package.cjs") return {};
      throw Error(name);
    },
    setTimeout, clearTimeout, TextEncoder, TextDecoder, Uint8Array, URL,
    window: { Capacitor: { nativePromise() { throw Error("unexpected native call"); } } },
  };
  vm.runInNewContext(await readFile(new URL("./trial-plugin.cjs", import.meta.url), "utf8"), context);
  return context.module.exports;
}

test("loader cannot invoke persistent settings and never cleans active or foreign resources", async () => {
  const Plugin = await pluginClass();
  const plugin = new Plugin();
  plugin.active = true;
  await assert.rejects(plugin.native("WebView", "persistServerBasePath"), /refused/);
  const calls = [];
  plugin.native = async (...args) => { calls.push(args); };
  plugin.currentPath = async () => "/active";
  plugin.data = { base: "native-delimiter-trial/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/public" };
  await assert.rejects(plugin.removePrivateResources(), /refused/);
  plugin.currentPath = async () => "public";
  plugin.data.base = "../other";
  await assert.rejects(plugin.removePrivateResources(), /refused/);
  assert.equal(calls.length, 0);
});

test("Plus recovery preserves an originally disabled plugin and restores an enabled one once", async () => {
  const Plugin = await pluginClass();
  const plugin = new Plugin();
  const enabled = new Set(), events = [];
  plugin.app = { plugins: {
    enabledPlugins: enabled,
    async enablePluginAndSave(id) { events.push(id); enabled.add(id); return true; },
    async saveConfig() { events.push("save"); },
  } };
  plugin.persist = async () => {};
  plugin.data = { plusRestoreRequired: false };
  await plugin.restorePlus();
  assert.equal(events.length, 0);
  plugin.data.plusRestoreRequired = true;
  await plugin.restorePlus();
  await plugin.restorePlus();
  assert.deepEqual(events, ["latex-standard-delimiters-plus", "save"]);
});

test("reload preparation rejects active composition and verifies saved text", async () => {
  const Plugin = await pluginClass();
  const plugin = new Plugin();
  let writes = 0, disk = "before", text = "after";
  const view = {
    file: { path: "synthetic.md" }, editor: { cm: { composing: true } },
    getViewData: () => text, async save() { writes++; disk = text; },
  };
  plugin.app = {
    workspace: { iterateAllLeaves: visit => visit({ view }), saveLayout: async () => {} },
    vault: { read: async () => disk },
  };
  await assert.rejects(plugin.saveOpenViews(), /composition/);
  assert.equal(writes, 0);
  view.editor.cm.composing = false;
  await plugin.saveOpenViews();
  assert.equal(disk, "after");
  view.save = async () => { disk = "out-of-date"; };
  await assert.rejects(plugin.saveOpenViews(), /not-fully-saved/);
});

test("cleanup saves pending edits, preserves changed notes, and stops if saving fails", async () => {
  const Plugin = await pluginClass();
  const plugin = new Plugin();
  const files = new Map([
    ["trial/original.md", { path: "trial/original.md", text: "original" }],
    ["trial/edited.md", { path: "trial/edited.md", text: "original" }],
  ]);
  const initialHash = await digest(new TextEncoder().encode("original"));
  const events = [];
  plugin.currentPath = async () => "public";
  plugin.showProgress = () => {};
  plugin.restorePlus = async () => {};
  plugin.removePrivateResources = async () => { events.push("remove-resources"); };
  plugin.saveOpenViews = async () => {
    files.get("trial/edited.md").text = "unsaved user edit";
    events.push("saved");
  };
  plugin.data = {
    noteFolder: "trial",
    notes: { original: "trial/original.md", edited: "trial/edited.md" },
    noteHashes: { original: initialHash, edited: initialHash },
  };
  plugin.app = { vault: {
    getAbstractFileByPath: path => files.get(path) || (path === "trial" ? { path, children: [...files.values()] } : null),
    read: async file => file.text,
    delete: async file => { events.push(file.path); files.delete(file.path); },
  } };
  await plugin.cleanup();
  assert.deepEqual(events, ["saved", "remove-resources", "trial/original.md"]);
  assert.equal(files.get("trial/edited.md").text, "unsaved user edit");
  plugin.saveOpenViews = async () => { throw Error("open-view-not-fully-saved"); };
  events.length = 0;
  await assert.rejects(plugin.cleanup(), /not-fully-saved/);
  assert.deepEqual(events, []);
});
