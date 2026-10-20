import assert from "node:assert/strict";
import test from "node:test";
import { withStandardDelimiters } from "../src/native-mode";
import { projectForNativeParser, restoreSectionPositions } from "../src/projection";
import { hasHost, host } from "./host";

import { cases } from "./cases";

test("standard-delimiter tokens match the installed native dollar grammar", {skip: !hasHost}, () => {
  const h = host();
  try {
    const tokenize = (text: string, standard: boolean) => {
      const mode = h.cm.getMode({}, "hypermd");
      const language = h.language.StreamLanguage.define(standard ? withStandardDelimiters(mode) : mode);
      const state = h.state.EditorState.create({doc: text, extensions: [language]});
      assert.equal(state.doc.toString(), text);
      const result: Array<{text: string; style: string}> = [];
      h.language.syntaxTree(state).iterate({enter(node) {
        const style = node.type.prop(h.tokenProp);
        if (typeof style === "string") {
          let value = text.slice(node.from, node.to);
          if (style.includes("formatting-math-begin") || style.includes("formatting-math-end")) value = value.replace(/\\[()]/g, () => "$").replace(/\\[[\]]/g, () => "$$");
          result.push({text: value, style});
        }
      }});
      return result;
    };
    for (const example of cases) {
      assert.deepEqual(tokenize(example.standard, true), tokenize(example.dollar, false), example.name);
    }
  } finally { h.close(); }
});

test("native reading HTML is identical and section positions return to the original source", {skip: !hasHost}, () => {
  const h = host();
  try {
    for (const example of cases) {
      const projection = projectForNativeParser(example.standard, h.cm);
      assert.equal(projection.text, example.dollar, example.name + ": alias text");
      const actual = h.sections(projection.text), expected = h.sections(example.dollar);
      assert.deepEqual(actual, expected, example.name + ": native reading output");
      restoreSectionPositions(actual, projection);
      for (const section of actual.sections) for (const position of [section.pos.start, section.pos.end]) {
        const start = projection.originalLineStarts[position.line];
        if (start !== undefined) assert.equal(position.offset, start + position.col, example.name);
        else {
          // Native footnotes append synthetic sections on a virtual EOF line.
          assert.equal(position.offset, example.standard.length, example.name);
          assert.equal(position.col, 0, example.name);
        }
        assert.ok(position.offset >= 0 && position.offset <= example.standard.length);
      }
    }
  } finally { h.close(); }
});

test("dollar-only documents pass through byte for byte", {skip: !hasHost}, () => {
  const h = host();
  try {
    for (const example of cases) {
      if (example.dollar.includes("\\(") || example.dollar.includes("\\[")) continue;
      assert.equal(projectForNativeParser(example.dollar, h.cm).text, example.dollar);
    }
  } finally { h.close(); }
});
