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

// Independently written fixture for the explicit-frame, char-indexed API.
const indexedSource = prefix => `
  const ZZParser = class {
    constructor(source, options, blocks, inline) {}
    point() {} toOffset() {} tokenizeBlock() {} tokenizeInline() {}
  };
  const ZZblock = (parser, frame, source, silent) =>
    frame.eat(source).apply({type: "math", value: source});
  const ZZinline = (parser, frame, source, silent) =>
    frame.eat(source).apply({type: "inlineMath", value: source});
  const ZZtext = () => {};
  const ZZblocks = [{fn:ZZblock, block: (a,b) => b === 36}];
  const ZZrules = [{fn:ZZinline,chars:"$"},{fn:ZZtext}];
  const ZZlookup = lookup(ZZrules);
  const ZZinterrupts = [ZZtext, ZZblock];
  function ZZparse(source, options) {
    const parser = new ZZParser(source, options, ZZblocks, ZZlookup);
    return {type:"root", children:parser.tokenizeBlock(source), position:{end:parser.eof}};
  }
`.replaceAll("ZZ", prefix);
test("indexed parser binds native rules, frame math and interrupt tables in the same scope", () => {
  for (const prefix of ["a", "$renamed2027"]) {
    const original = "(()=>{" + indexedSource(prefix) + "})();";
    const result = patchSource(original, "worker", runtime);
    assert.equal(result.grammar, "indexed");
    assert.equal(removeInsertions(result.output, result.insertions), original);
    assert.ok(result.output.includes("installIndexedGrammar(" + prefix + "blocks," + prefix +
      "lookup," + prefix + "block," + prefix + "inline,[" + prefix + "interrupts])"));
  }
});
test("indexed parser refuses missing interrupts, changed frames, unknown classes and ambiguous entry points", () => {
  const source = indexedSource("a");
  for (const changed of [
    source.replace("const ainterrupts = [atext, ablock];", ""),
    source.replaceAll(".apply(", ".differentCommit("),
    source.replace("tokenizeInline() {}", "differentInline() {}"),
    source + indexedSource("b"),
    source.replace("const ablocks = [{fn:ablock", "const ablocks = [{fn:atext"),
  ]) assert.throws(() => patchSource(changed, "worker", runtime), /unsupported-native-structure/);
});
test("a tokenizer in another lexical scope cannot supply a missing binding", () => {
  const source = indexedSource("a").replace(
    'const ablock = (parser, frame, source, silent) =>\n    frame.eat(source).apply({type: "math", value: source});', "");
  assert.throws(() => patchSource(source + `
    function unrelated() { const ablock = (p, frame, s, silent) =>
      frame.eat(s).apply({type:"math"}); }
  `, "worker", runtime), /unsupported-native-structure/);
});
