import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { patchSource } = require("./daily-patch.cjs");
const { removeInsertions } = require("./trial-core.cjs");
const source = name => `function parseText(input) {const p=new ${name}(input);p.setOptions(${name}.globalOptions);return p.parse();}`;
const runtime = "const __nativeLsd={installGrammar(){},wrapFactory:x=>x};";
test("adapter tolerates changed names, whitespace, and release banners without distributing host code", () => {
  for (const name of ["a", "Parser2027", "$p"]) {
    const original = "// another official version\n" + source(name) + '\ncm.defineMode("hypermd",function(){return {};});';
    const patch = patchSource(original, "app", runtime);
    assert.equal(removeInsertions(patch.output, patch.insertions), original);
    assert.deepEqual(patch.hooks, { parser: 1, editor: 1 });
    assert.ok(patch.output.includes(`installGrammar(${name})`));
  }
});
test("unknown, ambiguous, malformed, and already patched bundles fail closed", () => {
  for (const input of ["", "function (", source("A") + source("B").replace("parseText", "other"),
    source("A").replace("globalOptions", "differentOptions")]) {
    assert.throws(() => patchSource(input, "worker", runtime));
  }
  assert.throws(() => patchSource(source("A"), "app", runtime), /unsupported/);
  const result = patchSource(source("A"), "worker", runtime);
  assert.throws(() => patchSource(result.output, "worker", runtime), /already-patched/);
});
