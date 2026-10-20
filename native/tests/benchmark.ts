import { performance } from "node:perf_hooks";
import { hasHost, host, worker } from "./host";

if (!hasHost) throw new Error("Local host fixtures are required for this benchmark");
const h = host(), patched = worker("patched-worker.js");
if (!h.coreFactory) throw new Error("Run the app patcher first to prepare its compiled runtime");
const measure = (name: string, fn: () => unknown) => {
  console.error("Measuring", name);
  const budgetStart = performance.now();
  fn();
  const samples = [];
  for (let n = 0; n < 5; n++) {
    const before = performance.now();
    fn();
    samples.push(performance.now() - before);
    if (performance.now() - budgetStart > 5000) break;
  }
  samples.sort((a, b) => a - b);
  const result = {medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(3)), samples: samples.length};
  console.error(name, JSON.stringify(result));
  return result;
};
const results = [];
try {
  for (const [kind, count] of [["inline", 100], ["list", 100]] as const) {
    const standard = Array.from({length: count}, (_, i) => kind === "inline" ?
      `Text \\(x_{${i}}+y\\) after.\n` : `${i + 1}. Item\n\n   \\[\n   x_{${i}}+y\n   \\]\n`).join("\n");
    const dollar = standard.replace(/\\[()]/g, () => "$").replace(/\\[[\]]/g, () => "$$");
    const native = h.language.StreamLanguage.define(h.cm.getMode({}, "hypermd"));
    // The installed editor and the bundled adapter execute in the same realm,
    // as they would inside Obsidian. Avoid cross-realm calls for every token.
    const adapted = h.language.StreamLanguage.define(h.coreFactory(() => h.cm.getMode({}, "hypermd"))());
    const editor = (doc: string, extension: typeof native) => () => {
      const state = h.state.EditorState.create({doc, extensions: [extension]});
      const tree = h.language.ensureSyntaxTree(state, state.doc.length, 2000);
      if (!tree || tree.length < state.doc.length) throw new Error("Benchmark did not finish parsing");
    };
    results.push({
      kind, count, standardChars: standard.length,
      nativeEditorDollar: measure(kind + ": native editor, dollars", editor(dollar, native)),
      adaptedEditorDollar: measure(kind + ": adapted editor, dollars", editor(dollar, adapted)),
      adaptedEditorStandard: measure(kind + ": adapted editor, standard", editor(standard, adapted)),
      nativeReadingDollar: measure(kind + ": native reading, dollars", () => h.sections(dollar)),
      patchedReadingDollar: measure(kind + ": patched reading, dollars", () => patched.sections(dollar)),
      patchedReadingStandard: measure(kind + ": patched reading, standard", () => patched.sections(standard))
    });
  }
  console.log(JSON.stringify({
    scope: "Full syntax parse and native worker section parsing only. No DOM layout, MathJax rendering, physical input or UI latency.",
    adapterExecution: "Bundled adapter and installed editor grammar execute in the same JSDOM realm.",
    platform: `${process.platform}/${process.arch}`, node: process.version, results
  }, null, 2));
} finally { h.close(); }
