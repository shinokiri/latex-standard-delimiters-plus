import assert from "node:assert/strict";
import test from "node:test";
import { installReadingAliases, wrapMethod } from "../src/reading";
import type { Projection } from "../src/projection";

const originalSource = "Before \\(x\\).\n\nAfter.";
const aliasedSource = "Before $x$.\n\nAfter.";
function project(source: string): Projection {
  assert.equal(source, originalSource);
  return {original: source, text: aliasedSource, originalLineStarts: [0, 14, 15], toOriginal: offset => offset >= 10 ? offset + 2 : offset >= 8 ? offset + 1 : offset};
}

test("sync native parsing keeps source and returns original section offsets", () => {
  let parsed = "";
  const renderer = {
    text: originalSource, lastText: "", sections: [] as unknown[],
    parseSync() {
      parsed = this.text;
      this.parseFinish(this.text, {sections: [{pos: {start: {offset: 13, line: 2, col: 0}, end: {offset: 19, line: 2, col: 6}}}]});
    },
    parseAsync() {},
    parseFinish(text: string, result: {sections: unknown[]}) { this.lastText = text; this.sections = result.sections; }
  };
  const markdown = {render(...args: unknown[]) {return args;}};
  const dispose = installReadingAliases(renderer, markdown, project);
  try {
    renderer.parseSync();
    assert.equal(parsed, aliasedSource);
    assert.equal(renderer.text, originalSource);
    assert.equal(renderer.lastText, originalSource);
    assert.deepEqual(renderer.sections, [{pos: {start: {offset: 15, line: 2, col: 0}, end: {offset: 21, line: 2, col: 6}}}]);
    assert.equal(markdown.render(null, originalSource)[1], aliasedSource);
  } finally { dispose(); }
  renderer.parseSync();
  assert.equal(parsed, originalSource);
});

test("async native parsing retains its snapshot while the real note changes", async () => {
  let start!: () => void, finish!: () => void;
  const beforeRead = new Promise<void>(resolve => {start = resolve;});
  const beforeFinish = new Promise<void>(resolve => {finish = resolve;});
  let parsed = "", renderReceiver: unknown;
  const renderer = {
    text: originalSource, lastText: "", parsing: false,
    parseSync() {},
    async parseAsync() {
      this.parsing = true;
      await beforeRead;
      const input = this.text;
      parsed = input;
      await beforeFinish;
      this.parseFinish(input, {sections: []});
      this.onRender();
      this.parsing = false;
    },
    parseFinish(text: string, _result: unknown) {this.lastText = text;},
    onRender() {renderReceiver = this;}
  };
  const dispose = installReadingAliases(renderer, {render() {}}, project);
  const pending = renderer.parseAsync();
  assert.equal(renderer.text, originalSource);
  start();
  await Promise.resolve();
  assert.equal(parsed, aliasedSource);
  renderer.text = "A newer document revision.";
  dispose(); // An in-flight native parse must still finish with correct offsets.
  finish();
  await pending;
  assert.equal(renderer.text, "A newer document revision.");
  assert.equal(renderer.lastText, originalSource);
  assert.equal(renderReceiver, renderer);
  assert.equal(renderer.parsing, false);
});

test("unloading beneath another wrapper does not remove that wrapper", () => {
  const target = {run(value: number) {return value + 1;}};
  const dispose = wrapMethod(target, "run", (original, receiver, args) => (original.apply(receiver, args) as number) * 2);
  const wrapped = target.run;
  target.run = value => wrapped(value) + 3;
  assert.equal(target.run(1), 7);
  dispose();
  assert.equal(target.run(1), 5);
});
