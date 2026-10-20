const { parse } = require("acorn");
const { applyInsertions } = require("./trial-core.cjs");

function walk(root, visit, local = false) {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    visit(node);
    if (local && node !== root && /^(Function|ArrowFunction)/.test(node.type)) continue;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") pending.push(child);
      } else if (value && typeof value.type === "string") pending.push(value);
    }
  }
}
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && node.property.name === name;

/** Locate semantic hooks, independent of minifier names and byte offsets.
 * Unknown/ambiguous structures are refused; behavior is checked separately.
 */
function patchSource(source, kind, runtime) {
  if (!["app", "worker"].includes(kind) || typeof source !== "string" || source.includes("native-lsd-core-alias")) {
    throw Error("invalid-or-already-patched-source");
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const parsers = [], modes = [];
  walk(ast, node => {
    if (node.type === "FunctionDeclaration" && node.body) {
      const constructors = new Set(), options = new Set();
      let hasParse = false;
      walk(node.body, child => {
        if (child.type === "NewExpression" && child.callee.type === "Identifier") constructors.add(child.callee.name);
        if (child.type === "CallExpression") {
          if (member(child.callee, "parse") && child.arguments.length === 0) hasParse = true;
          if (member(child.callee, "setOptions") && child.arguments.length === 1 &&
              member(child.arguments[0], "globalOptions") && child.arguments[0].object.type === "Identifier") {
            options.add(child.arguments[0].object.name);
          }
        }
      }, true);
      const names = [...constructors].filter(name => options.has(name));
      if (hasParse && names.length) {
        if (names.length !== 1) throw Error("ambiguous-native-parser");
        parsers.push({ at: node.body.start + 1, name: names[0] });
      }
    }
    if (node.type === "CallExpression" && member(node.callee, "defineMode") &&
        node.arguments[0]?.value === "hypermd" && node.arguments.length >= 2) {
      modes.push(node.arguments[1]);
    }
  });
  if (parsers.length !== 1 || modes.length !== (kind === "app" ? 1 : 0)) {
    throw Error(`unsupported-native-structure:${kind}:${parsers.length}:${modes.length}`);
  }
  const insertions = [
    { at: 0, text: `/* native-lsd-core-alias: locally generated; host code is not redistributed */\n(()=>{\n${runtime}\n` },
    { at: parsers[0].at, text: `__nativeLsd.installGrammar(${parsers[0].name});` },
    ...modes.flatMap(mode => [
      { at: mode.start, text: "__nativeLsd.wrapFactory(" },
      { at: mode.end, text: ")" },
    ]),
    { at: source.length, text: "\n})();\n" },
  ].sort((a, b) => a.at - b.at);
  const output = applyInsertions(source, insertions);
  // A second parse checks that insertion locations did not change expression syntax.
  parse(output, { ecmaVersion: "latest", sourceType: "script" });
  return { output, insertions, hooks: { parser: parsers.length, editor: modes.length } };
}
module.exports = { patchSource };
