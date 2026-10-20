import assert from "node:assert/strict";
import test from "node:test";
import type { EditorState } from "@codemirror/state";
import { withStandardDelimiters } from "../src/native-mode";
import { wrapFactory } from "../src/core-runtime";
import { hasHost, host } from "./host";

type Host = ReturnType<typeof host>;
function snapshot(h: Host, state: EditorState, normalize = false) {
  const result: unknown[] = [];
  const text = state.doc.toString();
  h.language.ensureSyntaxTree(state, state.doc.length, 2000);
  h.language.syntaxTree(state).iterate({enter(node) {
    const token = node.type.prop(h.tokenProp), line = node.type.prop(h.lineProp);
    if (!token && !line) return;
    let content = text.slice(node.from, node.to);
    if (normalize) content = content.replace(/\\[()]/g, () => "$").replace(/\\[[\]]/g, () => "$$");
    result.push(normalize ? {token, line, content} : {from: node.from, to: node.to, token, line, content});
  }});
  return result;
}

test("incremental edits and selection changes agree with a fresh native parse", {skip: !hasHost}, () => {
  const h = host();
  try {
    const language = h.language.StreamLanguage.define(withStandardDelimiters(h.cm.getMode({}, "hypermd")));
    const original = "Before \\(x_1+\\frac{1}{y}\\) after.\n\n\\[\n\\boxed{a+b}\n\\]\n\nTail.";
    let state = h.state.EditorState.create({doc: original, extensions: [language]});
    const check = () => {
      const fresh = h.state.EditorState.create({doc: state.doc, extensions: [language]});
      assert.deepEqual(snapshot(h, state), snapshot(h, fresh));
    };
    check();
    for (const [needle, replacement] of [
      ["x_1", "x_2"], ["\\frac{1}{y}", "\\frac{12}{yz}"],
      ["\\)", "\\"], ["\\ after", "\\) after"],
      ["\\[", "\\"], ["\\\n\\boxed", "\\[\n\\boxed"],
      ["a+b", "a+b+c"], ["\\]", ""], ["\n\nTail", "\n\\]\n\nTail"],
      ["Before ", "Before 😀 "],
    ] as const) {
      const from = state.doc.toString().indexOf(needle);
      assert.ok(from >= 0, needle);
      state = state.update({changes: {from, to: from + needle.length, insert: replacement}}).state;
      check();
    }
    const beforeSelection = snapshot(h, state);
    for (let anchor = 0; anchor <= state.doc.length; anchor++) {
      state = state.update({selection: {anchor}}).state;
      assert.deepEqual(snapshot(h, state), beforeSelection);
    }
  } finally { h.close(); }
});

test("core factory preserves the native restricted table-cell grammar", {skip: !hasHost}, () => {
  const h = host();
  try {
    const options = {name: "hypermd", front_matter: false, table: false,
      fencedCodeBlockHighlighting: false, taskLists: false, headers: false,
      blockquotes: false, indentedCode: false, lists: false, hr: false, blockId: false};
    const factory = h.coreFactory ? h.coreFactory(() => h.cm.getMode({}, options)) : wrapFactory(() => h.cm.getMode({}, options));
    const adapted = h.language.StreamLanguage.define(factory());
    const native = h.language.StreamLanguage.define(h.cm.getMode({}, options));
    for (const [standard, dollar] of [
      ["Before \\(x+1\\) after", "Before $x+1$ after"],
      ["\\[\\boxed{x+y}\\]", "$$\\boxed{x+y}$$"],
      ["# \\(x\\) > text", "# $x$ > text"],
      ["`\\(literal\\)` then \\(x\\)", "`\\(literal\\)` then $x$"],
    ]) {
      const actual = h.state.EditorState.create({doc: standard, extensions: [adapted]});
      const expected = h.state.EditorState.create({doc: dollar, extensions: [native]});
      assert.deepEqual(snapshot(h, actual, true), snapshot(h, expected, true));
      assert.equal(actual.doc.toString(), standard);
    }
  } finally { h.close(); }
});

test("long formulas preserve native token and line styles", {skip: !hasHost}, () => {
  const h = host();
  try {
    const body = Array.from({length: 800}, (_, i) => `x_{${i}}`).join("+");
    for (const [standard, dollar] of [[`\\(${body}\\)`, `$${body}$`], [`\\[\n${body}\n\\]`, `$$\n${body}\n$$`]]) {
      const actual = h.state.EditorState.create({doc: standard, extensions: [
        h.language.StreamLanguage.define(withStandardDelimiters(h.cm.getMode({}, "hypermd")))
      ]});
      const expected = h.state.EditorState.create({doc: dollar, extensions: [
        h.language.StreamLanguage.define(h.cm.getMode({}, "hypermd"))
      ]});
      assert.deepEqual(snapshot(h, actual, true), snapshot(h, expected, true));
    }
  } finally { h.close(); }
});
