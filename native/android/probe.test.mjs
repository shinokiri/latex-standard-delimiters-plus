import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const context = {
  module: { exports: {} },
  require: name => {
    assert.equal(name, "obsidian");
    return { Plugin: class {}, Notice: class {} };
  },
  setTimeout, clearTimeout, URL, AbortController, Uint8Array,
};
vm.runInNewContext(await readFile(new URL("./probe.cjs", import.meta.url), "utf8"), context);
const { collect, nativeRead, pathClass } = context.module.exports._test;

test("probe can only call its three allowlisted native read methods", async () => {
  const calls = [];
  const cap = { nativePromise: (...args) => { calls.push(args); return Promise.resolve({}); } };
  for (const method of ["setServerBasePath", "setServerAssetPath", "persistServerBasePath"]) {
    await assert.rejects(nativeRead(cap, "WebView", method), /Non-read/);
  }
  await assert.rejects(nativeRead(cap, "Filesystem", "writeFile"), /Non-read/);
  assert.equal(calls.length, 0);
  await nativeRead(cap, "WebView", "getServerBasePath");
  assert.equal(calls.length, 1);
});

test("probe tolerates missing bridges and does not probe non-Android hosts", async () => {
  const report = await collect({});
  assert.equal(report.nativeBridge, false);
  assert.equal(report.activationAttempted, false);
  const other = await collect({ Capacitor: { getPlatform: () => "ios", nativePromise() { throw Error("unexpected"); } } });
  assert.equal(other.activationAttempted, false);
});

test("probe redacts private paths, checks local hashes and reports failures separately", async () => {
  const calls = [], requests = [];
  const win = {
    location: { origin: "http://localhost" },
    crypto: webcrypto,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode("unknown new host").buffer };
    },
    Capacitor: {
      getPlatform: () => "android",
      PluginHeaders: [{ name: "WebView", methods: ["getServerBasePath", "setServerBasePath", "setServerAssetPath"].map(name => ({ name })) }],
      nativePromise: async (plugin, method) => {
        calls.push(`${plugin}.${method}`);
        if (plugin === "App") return { id: "md.obsidian", version: "1.14.4", build: "389" };
        if (plugin === "WebView") return { path: "public" };
        return { uri: "file:///data/user/0/md.obsidian/files/private-name" };
      },
    },
  };
  const report = await collect(win);
  assert.equal(report.readiness.evaluatedBinary, true);
  assert.equal(report.readiness.exactResources, false);
  assert.equal(report.readiness.privateStorageAddressable, true);
  assert.equal(report.liveReadChecksPassed, false);
  assert.equal(JSON.stringify(report).includes("private-name"), false);
  assert.deepEqual(calls.sort(), ["App.getInfo", "Filesystem.getUri", "WebView.getServerBasePath"]);
  assert.deepEqual(requests.map(request => request.url).sort(), ["http://localhost/app.js", "http://localhost/worker.js"]);
  assert.ok(requests.every(request => request.options.redirect === "error"));
  win.Capacitor.nativePromise = async () => { throw new Error("/private/path"); };
  const failed = await collect(win);
  assert.equal(failed.checks.app.ok, false);
  assert.equal(failed.checks.appResource.ok, true);
  assert.equal(JSON.stringify(failed).includes("/private/path"), false);
});

test("only the actual Android application directory qualifies as private storage", () => {
  assert.equal(pathClass("file:///data/user/0/md.obsidian/files"), "obsidian-private-directory");
  assert.equal(pathClass("/data/data/md.obsidian/files"), "obsidian-private-directory");
  assert.equal(pathClass("/data/user/0/md.obsidian-other/files"), "other-directory");
  assert.equal(pathClass("/sdcard/test"), "other-directory");
});
