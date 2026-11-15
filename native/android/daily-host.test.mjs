import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import vm from "node:vm";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const { patchSource } = require("./daily-patch.cjs");
const { removeInsertions } = require("./trial-core.cjs");
const root = resolve(import.meta.dirname, "../..");
const fixtures = resolve(root, ".local-fixtures");
const sha256 = source => createHash("sha256").update(source).digest("hex");
let runtime, cases;
async function prepare() {
  if (runtime) return;
  runtime = (await build({
    entryPoints: [resolve(root, "native/src/core-runtime.ts")], bundle: true,
    format: "iife", globalName: "__nativeLsd", write: false, target: "es2022",
  })).outputFiles[0].text;
  const corpus = (await build({
    entryPoints: [resolve(root, "native/tests/cases.ts")], bundle: true,
    format: "iife", globalName: "corpus", write: false, target: "es2022",
  })).outputFiles[0].text;
  cases = vm.runInNewContext(corpus + "\ncorpus.cases;");
}
function worker(source) {
  let response;
  const context = { TextDecoder, TextEncoder, console, setTimeout, clearTimeout, postMessage: value => { response = value; } };
  context.self = context;
  vm.runInNewContext(source, context);
  const request = data => {
    response = undefined;
    context.onmessage({ data });
    assert.ok(response, "worker response");
    return JSON.parse(JSON.stringify(response));
  };
  return {
    sections: source => request({ parseSections: source, options: { breaks: true, commonmark: true } }),
    metadata: source => request({ metadataCache: new TextEncoder().encode(source).buffer }),
  };
}
const html = result => result.sections.map(section => section.html.replace(/ data-heading="[^"]*"/g, "")).join("\n");

// Supply legally obtained local fixtures; host source is never committed or packaged.
for (const [prefix, family] of [["", "indexed"], ["legacy-", "prototype"]]) {
  const available = ["app", "worker"].every(kind => existsSync(resolve(fixtures, prefix + kind + ".js")));
  test("actual local " + family + " app/worker: aliases, unchanged dollars, original positions", { skip: !available }, async t => {
    await prepare();
    let original, patched;
    for (const kind of ["app", "worker"]) {
      const input = readFileSync(resolve(fixtures, prefix + kind + ".js"), "utf8");
      const result = patchSource(input, kind, runtime);
      assert.equal(result.grammar, family);
      assert.equal(removeInsertions(result.output, result.insertions), input);
      t.diagnostic(kind + " source SHA256: " + sha256(input));
      if (kind === "worker") { original = worker(input); patched = worker(result.output); }
    }
    for (const example of cases) {
      assert.equal(html(patched.sections(example.standard)), html(original.sections(example.dollar)), example.name);
      assert.deepEqual(patched.sections(example.dollar), original.sections(example.dollar), example.name + ": dollar sections");
      assert.deepEqual(patched.metadata(example.dollar), original.metadata(example.dollar), example.name + ": dollar metadata");
    }
    t.diagnostic(cases.length + " alias/dollar pairs passed, including paragraph/list/quote/footnote interruption");
    const source = "# Heading\n\nText \\(x\\) [[Target]] #outside\n\n\\[\n# no-heading\n[[not-a-link]] #not-a-tag\n\\]\n\n- [ ] Task \\(y\\) [[Next]]";
    const metadata = patched.metadata(source);
    assert.deepEqual(metadata.links.map(link => link.link), ["Target", "Next"]);
    assert.deepEqual(metadata.tags.map(tag => tag.tag), ["#outside"]);
    assert.deepEqual(metadata.headings.map(heading => heading.heading), ["Heading"]);
    for (const link of metadata.links) {
      assert.equal(source.slice(link.position.start.offset, link.position.end.offset), link.original);
      assert.equal(link.position.start.col, link.position.start.offset - source.lastIndexOf("\n", link.position.start.offset - 1) - 1);
    }
    const math = metadata.sections.filter(section => section.type === "math");
    assert.equal(math.length, 1);
    assert.equal(source.slice(math[0].position.start.offset, math[0].position.end.offset),
      "\\[\n# no-heading\n[[not-a-link]] #not-a-tag\n\\]");
    const heading = "# Heading \\(x_1\\)";
    assert.equal(patched.metadata(heading).headings[0].heading, heading.slice(2));
    assert.ok(patched.sections(heading).sections[0].html.includes('data-heading="' + heading.slice(2) + '"'));
    for (const literal of ["`\\(x\\)`", "    \\[x\\]", "```tex\n\\[x\\]\n```", "\\\\(x\\\\)", "\\(unfinished"]) {
      assert.deepEqual(patched.sections(literal), original.sections(literal), "literal: " + literal);
    }
  });
}
