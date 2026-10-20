import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { projectForNativeParser, restoreSectionPositions, type Projection } from "../src/projection";
import { cases } from "./cases";
import { hasHost, host, worker } from "./host";

const hasPatched = hasHost && existsSync(resolve(import.meta.dirname, "../../.local-fixtures/patched-worker.js"));

function restorePositions(value: unknown, projection: Projection): void {
  if (!value || typeof value !== "object") return;
  const position = value as {offset?: number; line?: number; col?: number};
  if (typeof position.offset === "number" && typeof position.line === "number" && typeof position.col === "number") {
    position.offset = projection.toOriginal(position.offset);
    if (projection.originalLineStarts[position.line] !== undefined) {
      position.col = position.offset - projection.originalLineStarts[position.line];
    }
  } else for (const item of Object.values(value)) restorePositions(item, projection);
}

test("core patch parses original standard Markdown through the actual native worker", {skip: !hasPatched}, () => {
  const h = host(), patched = worker("patched-worker.js");
  try {
    for (const example of cases) {
      const projection = projectForNativeParser(example.standard, h.cm);
      const expected = h.sections(example.dollar);
      restoreSectionPositions(expected, projection);
      if (example.name === "heading") {
        // Native anchors retain literal source, independently of math rendering.
        expected.sections[0].html = expected.sections[0].html.replace(
          'data-heading="' + example.dollar.slice(3) + '"',
          'data-heading="' + example.standard.slice(3) + '"'
        );
      }
      assert.deepEqual(patched.sections(example.standard), expected, example.name);
    }
  } finally { h.close(); }
});

test("core heading anchors and metadata retain the original delimiter spelling", {skip: !hasPatched}, () => {
  const patched = worker("patched-worker.js");
  const source = "# Heading \\(x_1\\)";
  assert.match(patched.sections(source).sections[0].html, /data-heading="Heading \\\(x_1\\\)"/);
  assert.equal(patched.metadata(source).headings[0].heading, source.slice(2));
});

test("core patch leaves dollar documents and literal code examples unchanged", {skip: !hasPatched}, () => {
  const original = worker(), patched = worker("patched-worker.js");
  for (const example of cases) {
    assert.deepEqual(patched.sections(example.dollar), original.sections(example.dollar), example.name);
    assert.deepEqual(patched.metadata(example.dollar), original.metadata(example.dollar), example.name);
  }
});

test("core metadata uses original offsets and ignores Markdown syntax inside math", {skip: !hasPatched}, () => {
  const h = host(), patched = worker("patched-worker.js");
  const standard = "# Heading\n\nText \\(x\\) [[Target]] #outside\n\n\\[\n# no-heading\n[[not-a-link]] #not-a-tag\n\\]\n\n- [ ] Task \\(y\\) [[Next]]\n\n![[Image.png]]";
  const dollar = "# Heading\n\nText $x$ [[Target]] #outside\n\n$$\n# no-heading\n[[not-a-link]] #not-a-tag\n$$\n\n- [ ] Task $y$ [[Next]]\n\n![[Image.png]]";
  try {
    const expected = h.metadata(dollar);
    restorePositions(expected, projectForNativeParser(standard, h.cm));
    assert.deepEqual(patched.metadata(standard), expected);
  } finally { h.close(); }
});
