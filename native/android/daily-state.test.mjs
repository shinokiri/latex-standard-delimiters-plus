import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { cacheRoot, ownedCache, samePackage, automaticDecision } = require("./daily-state.cjs");
const identity = { host: { id: "md.obsidian", version: "1.14.4", build: "389" }, path: "/data/app/current/base.apk", size: 123, mtime: 456 };
const data = () => ({ auto: true, phase: "active", identity, adapter: "v2" });
test("unchanged verified cache is reused; actual package or adapter changes rebuild", () => {
  assert.equal(automaticDecision(data(), identity, "v2", true, false), "cached");
  assert.equal(automaticDecision(data(), { ...identity, path: "/data/app/reinstalled/base.apk" }, "v2", true, false), "rebuild");
  assert.equal(automaticDecision(data(), identity, "v3", true, false), "rebuild");
  assert.equal(automaticDecision(data(), { ...identity, mtime: 457 }, "v2", true, false), "rebuild");
  assert.equal(automaticDecision({ ...data(), auto: false }, identity, "v2", true, false), "off");
});
test("failed and interrupted starts never loop; a new official release may be tried", () => {
  assert.equal(automaticDecision(data(), identity, "v2", true, true), "block");
  assert.equal(automaticDecision({ ...data(), phase: "switching" }, identity, "v2", true, false), "block");
  assert.equal(automaticDecision({ ...data(), phase: "staging" }, identity, "v2", true, false), "block");
  const failed = { ...data(), blocked: { identity, adapter: "v2" } };
  assert.equal(automaticDecision(failed, identity, "v2", true, false), "blocked");
  const updated = { ...identity, host: { ...identity.host, version: "1.15.0", build: "400" } };
  assert.equal(automaticDecision(failed, updated, "v2", true, true), "rebuild");
});
test("external cache removal restores official mode instead of recreating itself", () => {
  assert.equal(automaticDecision(data(), identity, "v2", false, false), "missing");
  assert.equal(samePackage(null, identity), false);
  assert.equal(cacheRoot("/storage/emulated/10/Documents/Books"), "/storage/emulated/10/.obsidian-native-delimiters");
  assert.equal(cacheRoot("/sdcard/Documents/Books"), "/storage/emulated/0/.obsidian-native-delimiters");
  assert.throws(() => cacheRoot("/data/other"));
  assert.ok(ownedCache("/storage/emulated/0/.obsidian-native-delimiters/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/public"));
  for (const path of ["/storage/emulated/0/Documents/Books", "/data/app/base", "/storage/emulated/0/.obsidian-native-delimiters/../public"]) {
    assert.equal(ownedCache(path), false);
  }
});
test("external recovery takes precedence when cache removal coincides with an official update", () => {
  const updated = { ...identity, host: { ...identity.host, version: "1.15.0", build: "400" } };
  assert.equal(automaticDecision({ ...data(), verifiedKey: "accepted" }, updated, "v3", false, false), "missing");
});
test("an interrupted rebuild is blocked against its new target, even before the old cache identity changes", () => {
  const updated = { ...identity, host: { ...identity.host, version: "1.15.0", build: "400" } };
  const pending = { ...data(), phase: "staging", attemptIdentity: updated, attemptAdapter: "v3" };
  assert.equal(automaticDecision(pending, updated, "v3", true, false), "block");
  assert.equal(automaticDecision(pending, { ...updated, mtime: 999 }, "v3", true, false), "rebuild");
});
