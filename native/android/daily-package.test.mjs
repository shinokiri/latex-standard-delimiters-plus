import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { ownApkFromMaps, extractPublicAssets } = require("./daily-package.cjs");
const { zipSync, strToU8 } = require("fflate");
const basic = {
  "assets/public/index.html": strToU8("<head></head>"),
  "assets/public/app.js": strToU8("app"),
  "assets/public/worker.js": strToU8("worker"),
};
test("APK discovery accepts exactly one installed copy of this application", () => {
  const path = "/data/app/~~token==/md.obsidian-a_B==/base.apk";
  assert.equal(ownApkFromMaps(`100 200 ${path}\n300 400 ${path}`), path);
  assert.throws(() => ownApkFromMaps("/data/app/other.app-xx/base.apk"));
  assert.throws(() => ownApkFromMaps(path + "\n/data/app/md.obsidian-other/base.apk"));
  assert.throws(() => ownApkFromMaps(null));
});
test("APK extraction includes extensionless assets and excludes unrelated package contents", () => {
  const assets = extractPublicAssets(zipSync({
    ...basic, "classes.dex": strToU8("not an asset"),
    "assets/public/lib/pdfjs/LICENSE": strToU8("license"),
  }));
  assert.deepEqual([...assets.keys()].sort(), ["app.js", "index.html", "lib/pdfjs/LICENSE", "worker.js"]);
});
test("APK extraction rejects traversal, incomplete and oversized resource sets", () => {
  for (const path of ["../escape", "a/../../escape", "a%2fb", "a\\b", "/absolute"]) {
    assert.throws(() => extractPublicAssets(zipSync({ ...basic, ["assets/public/" + path]: strToU8("bad") })));
  }
  assert.throws(() => extractPublicAssets(zipSync({ "assets/public/app.js": strToU8("only app") })), /incomplete/);
  assert.throws(() => extractPublicAssets(zipSync({
    ...basic, "assets/public/large.bin": new Uint8Array(16 * 1024 * 1024 + 1),
  })), /invalid-apk-resource/);
});
