import assert from "node:assert/strict";
import test from "node:test";
// The patcher is intentionally plain ESM; this test exercises its public guards.
// @ts-expect-error The ESM CLI does not publish a declaration file.
import { patchCore } from "../patch-core.mjs";

test("core patch refuses unsupported, changed and already-patched bundles", async () => {
  await assert.rejects(patchCore("", "other"), /kind must be/);
  await assert.rejects(patchCore("(()=>{})()", "app"), /Unsupported host checksum/);
  await assert.rejects(patchCore("(()=>{})()", "worker"), /Unsupported host checksum/);
  await assert.rejects(patchCore("/* native-lsd-core-alias */", "app"), /already patched/);
});
