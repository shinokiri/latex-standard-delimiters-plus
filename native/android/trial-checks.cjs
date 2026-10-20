const { MarkdownRenderer, Component } = require("obsidian");
const { ensureSyntaxTree } = require("@codemirror/language");
const { undo } = require("@codemirror/commands");
const { cases } = require("../tests/cases.ts");
const { digest, removeInsertions } = require("./trial-core.cjs");
const { foregroundOperation } = require("./trial-async.cjs");

const editorStandard = String.raw`编辑检查（测试笔记）

行内 \(x_1+\frac{1}{y}\) 结束。

\[
\boxed{a^2+b^2=c^2}
\]

公式之外。
`;
const editorDollar = editorStandard.replaceAll("\\(", "$").replaceAll("\\)", "$")
  .replaceAll("\\[", () => "$$").replaceAll("\\]", () => "$$");
const embedSource = "# 嵌入目标\n\n行内 \\(u+v\\)。\n\n\\[\n\\frac{u}{v}\n\\]\n";

const preview = String.raw`# 原生 delimiter 试运行

此笔记由试运行工具创建。原笔记无需改写。

## 行内与美元符号对照

标准：\(x_1+\frac{1}{y}\)；原生美元：$x_1+\frac{1}{y}$。

## 独立公式与方框

\[
\boxed{(A\cap B)\cup(A\cap B^c)=A}
\]

$$
\boxed{(A\cap B)\cup(A\cap B^c)=A}
$$

## 列表、引用与表格

1. 缩进公式：

   \[
   \sum_{k=1}^{n}k=\frac{n(n+1)}2
   \]

> \[
> a^2+b^2=c^2
> \]

| 标准 delimiter | 美元 delimiter |
| --- | --- |
| \(x+1\) | $x+1$ |
| \[\frac{1}{2}\] | $$\frac{1}{2}$$ |

## 字面源码

这些示例应保持原样：` + "`\\(x\\)`、`\\[x\\]`。\n\n" +
  "## 手动体验\n\n在实时预览中点击公式，测试源码着色、光标、输入法、撤销；再切换阅读模式比较。试运行没有开启跨进程自动加载，完整重启将恢复官方资源。\n";

function workerClient(url, signal) {
  const worker = new Worker(url);
  return {
    async request(data) {
      return foregroundOperation(() => new Promise((resolve, reject) => {
        worker.onmessage = event => resolve(event.data);
        worker.onerror = () => reject(new Error("worker-error"));
        worker.postMessage(data);
      }), { document, signal, timeoutMs: 8000, timeoutMessage: "worker-timeout" });
    },
    close() { worker.terminate(); },
  };
}

async function waitFor(check, milliseconds = 10000, signal) {
  let timer;
  try {
    await foregroundOperation(() => new Promise((resolve, reject) => {
      const poll = () => { try { if (check()) resolve(); } catch (error) { reject(error); } };
      timer = setInterval(poll, 50);
      poll();
    }), { document, signal, timeoutMs: milliseconds, timeoutMessage: "render-timeout" });
  } finally { clearInterval(timer); }
}

async function checkWorker(plugin, plan) {
  const item = plan.assets.find(item => item.path === "worker.js");
  const bytes = await plugin.localResource("worker.js");
  if (await digest(bytes) !== item.sha256) throw new Error("active-worker-hash-mismatch");
  const original = removeInsertions(new TextDecoder().decode(bytes), item.insertions);
  if (await digest(new TextEncoder().encode(original)) !== item.sourceSha256) throw new Error("original-worker-hash-mismatch");
  return compareWorkers(original, new TextDecoder().decode(bytes), plugin.calls?.signal);
}

async function compareWorkers(original, output, signal) {
  const originalURL = URL.createObjectURL(new Blob([original], { type: "application/javascript" }));
  const patchedURL = URL.createObjectURL(new Blob([output], { type: "application/javascript" }));
  const baseline = workerClient(originalURL, signal);
  const patched = workerClient(patchedURL, signal);
  const results = [];
  try {
    for (const example of cases) {
      const [a, b] = await Promise.all([
        baseline.request({ parseSections: example.dollar, options: { breaks: true, commonmark: true } }),
        patched.request({ parseSections: example.standard, options: { breaks: true, commonmark: true } }),
      ]);
      const html = result => result.sections.map(section => section.html.replace(/ data-heading="[^"]*"/g, "")).join("\n");
      const unchanged = await patched.request({ parseSections: example.dollar, options: { breaks: true, commonmark: true } });
      results.push({ name: example.name, equalHTML: html(a) === html(b), dollarUnchanged: JSON.stringify(a) === JSON.stringify(unchanged) });
    }
    return { total: results.length, passed: results.filter(item => item.equalHTML && item.dollarUnchanged).length, cases: results };
  } finally {
    baseline.close(); patched.close(); URL.revokeObjectURL(originalURL); URL.revokeObjectURL(patchedURL);
  }
}

async function checkReading(plugin) {
  const selected = cases.filter(example =>
    ["inline", "display", "indented display", "list", "quote", "callout", "boxed", "table", "display in table"].includes(example.name));
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:0;top:0;width:320px;visibility:hidden;pointer-events:none";
  document.body.appendChild(container);
  const component = new Component();
  component.load();
  const results = [];
  try {
    for (const example of selected) {
      const pair = [];
      for (const source of [example.dollar, example.standard]) {
        const node = document.createElement("div");
        container.appendChild(node);
        await MarkdownRenderer.render(plugin.app, source, node, plugin.data.notes.preview, component);
        await waitFor(() => node.querySelectorAll("mjx-container").length > 0, 10000, plugin.calls?.signal);
        pair.push({ math: node.querySelectorAll("mjx-container").length, errors: node.querySelectorAll("mjx-merror, .math-error").length });
      }
      results.push({ name: example.name, ...pair[1], matchesDollar: pair[0].math === pair[1].math && pair[1].errors === 0 });
      container.replaceChildren();
    }
    const embedded = document.createElement("div");
    container.appendChild(embedded);
    await MarkdownRenderer.render(plugin.app, "![[" + plugin.data.notes.embed.replace(/\.md$/, "") + "]]",
      embedded, plugin.data.notes.preview, component);
    await waitFor(() => embedded.querySelectorAll(".markdown-embed mjx-container").length >= 2, 10000, plugin.calls?.signal);
    results.push({ name: "native embedded note", math: embedded.querySelectorAll(".markdown-embed mjx-container").length,
      matchesDollar: embedded.querySelectorAll("mjx-merror, .math-error").length === 0 });
    return { total: results.length, passed: results.filter(item => item.matchesDollar).length, cases: results };
  } finally { component.unload(); container.remove(); }
}

async function checkEditor(plugin) {
  const leaf = plugin.app.workspace.getLeaf("tab");
  const result = { syntaxMatchesDollar: false, selectionMoves: 0, sourceUnchanged: false, undoRestoresSource: false };
  const signatures = [];
  try {
    for (const name of ["dollar", "editor"]) {
      const file = plugin.app.vault.getAbstractFileByPath(plugin.data.notes[name]);
      await leaf.openFile(file, { state: { mode: "source", source: false } });
      await waitFor(() => Boolean(leaf.view.editor?.cm?.state), 10000, plugin.calls?.signal);
      const cm = leaf.view.editor.cm;
      const tree = ensureSyntaxTree(cm.state, cm.state.doc.length, 1000);
      if (!tree) throw new Error("editor-syntax-incomplete");
      const math = [];
      tree.iterate({ enter(node) { if (/math/i.test(node.name)) math.push(node.name); } });
      signatures.push(math);
      if (name === "editor") {
        const source = cm.state.doc.toString();
        if (source !== editorStandard || leaf.view.file.path !== plugin.data.notes.editor) throw new Error("test-document-mismatch");
        for (let offset = 0; offset <= source.length; offset += 3) {
          cm.dispatch({ selection: { anchor: offset } });
          result.selectionMoves++;
        }
        result.sourceUnchanged = cm.state.doc.toString() === source;
        const at = source.indexOf("x_1") + 1;
        cm.dispatch({ changes: { from: at, insert: "+z" }, selection: { anchor: at + 2 } });
        result.undoRestoresSource = undo(cm) && cm.state.doc.toString() === source;
        // The generated test note is the only file edited by this check.
        if (cm.state.doc.toString() !== source) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: source } });
        await leaf.view.save();
      }
    }
    result.syntaxMatchesDollar = signatures[0].length > 0 && JSON.stringify(signatures[0]) === JSON.stringify(signatures[1]);
    result.mathTokenNames = signatures;
    return result;
  } finally { leaf.detach(); }
}

async function runChecks(plugin, plan) {
  const report = { generatedAt: new Date().toISOString(), physicalTouchAndIME: "requires-user-test", checks: {} };
  for (const [name, operation] of [
    ["worker", () => checkWorker(plugin, plan)],
    ["reading", () => checkReading(plugin)],
    ["editor", () => checkEditor(plugin)],
  ]) {
    if (plugin.calls?.signal.aborted) throw new Error("plugin-unloaded");
    try { report.checks[name] = { ok: true, result: await operation() }; }
    catch (error) { report.checks[name] = { ok: false, error: error.message }; }
  }
  const checks = report.checks;
  report.passed = checks.worker.ok && checks.worker.result.passed === checks.worker.result.total &&
    checks.reading.ok && checks.reading.result.passed === checks.reading.result.total &&
    checks.editor.ok && checks.editor.result.syntaxMatchesDollar && checks.editor.result.sourceUnchanged &&
    checks.editor.result.undoRestoresSource;
  return report;
}

module.exports = { preview, editorStandard, editorDollar, embedSource, runChecks, compareWorkers };
