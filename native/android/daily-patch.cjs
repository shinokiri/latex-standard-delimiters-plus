const { parse } = require("acorn");
const { applyInsertions } = require("./trial-core.cjs");

function walk(root, visit, local = false) {
  const pending = [{ node: root, scope: root }];
  while (pending.length) {
    const { node, scope } = pending.pop();
    visit(node, scope);
    if (local && node !== root && /^(Function|ArrowFunction)/.test(node.type)) continue;
    const childScope = /^(Function|ArrowFunction)/.test(node.type) ? node : scope;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") pending.push({ node: child, scope: childScope });
      } else if (value && typeof value.type === "string") pending.push({ node: value, scope: childScope });
    }
  }
}
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && node.property.name === name;
const property = (node, name) => node?.properties?.find(item =>
  item.type === "Property" && !item.computed && (item.key.name || item.key.value) === name)?.value;
const functionNode = node => /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node?.type);

function mathTokenizer(node, type) {
  if (!functionNode(node) || node.params.length !== 4 || node.params[1].type !== "Identifier") return false;
  let createsMath = false, commitsFrame = false;
  walk(node.body, child => {
    if (child.type === "ObjectExpression" && property(child, "type")?.value === type) createsMath = true;
    if (child.type === "CallExpression" && member(child.callee, "apply")) {
      const eat = child.callee.object;
      if (eat.type === "CallExpression" && member(eat.callee, "eat") &&
          eat.callee.object.name === node.params[1].name) commitsFrame = true;
    }
  }, true);
  return createsMath && commitsFrame;
}

function indexedParser(candidate, declarations) {
  const bindings = new Map();
  for (const declaration of declarations.filter(item => item.scope === candidate.scope)) {
    if (bindings.has(declaration.name)) bindings.set(declaration.name, null);
    else bindings.set(declaration.name, declaration.value);
  }
  const construct = candidate.construct;
  const constructor = bindings.get(construct.callee.name);
  if (constructor?.type !== "ClassExpression") return null;
  const methods = constructor.body.body.filter(item => item.type === "MethodDefinition");
  if (!["constructor", "tokenizeBlock", "tokenizeInline", "point", "toOffset"].every(name =>
    methods.some(item => item.key.name === name)) ||
    methods.find(item => item.kind === "constructor")?.value.params.length !== 4) return null;
  const blocksName = construct.arguments[2].name, inlineName = construct.arguments[3].name;
  const blocks = bindings.get(blocksName), lookup = bindings.get(inlineName);
  if (blocks?.type !== "ArrayExpression" || lookup?.type !== "CallExpression" ||
      lookup.arguments.length !== 1 || lookup.arguments[0].type !== "Identifier") return null;
  const inlineRules = bindings.get(lookup.arguments[0].name);
  if (inlineRules?.type !== "ArrayExpression") return null;
  const findMath = (rules, type) => rules.elements
    .map(rule => property(rule, "fn"))
    .filter(fn => fn?.type === "Identifier" && mathTokenizer(bindings.get(fn.name), type))
    .map(fn => fn.name);
  const blockFns = findMath(blocks, "math"), inlineFns = findMath(inlineRules, "inlineMath");
  if (blockFns.length !== 1 || inlineFns.length !== 1) return null;
  const block = blockFns[0], inline = inlineFns[0], interrupts = [];
  for (const [name, value] of bindings) {
    if (value?.type !== "ArrayExpression" || !value.elements.some(item => item?.name === block)) continue;
    if (value.elements.every(item => item?.type === "Identifier" && functionNode(bindings.get(item.name)))) interrupts.push(name);
  }
  if (!interrupts.length || interrupts.length > 16) return null;
  return {
    at: candidate.node.body.start + 1, family: "indexed",
    hook: "__nativeLsd.installIndexedGrammar(" + [blocksName, inlineName, block, inline,
      "[" + interrupts.join(",") + "]"].join(",") + ");",
  };
}

/** Locate semantic hooks, independent of minifier names and byte offsets.
 * Unknown/ambiguous structures are refused; behavior is checked separately.
 */
function patchSource(source, kind, runtime) {
  if (!["app", "worker"].includes(kind) || typeof source !== "string" || source.includes("native-lsd-core-alias")) {
    throw Error("invalid-or-already-patched-source");
  }
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const parsers = [], modes = [], declarations = [], indexed = [];
  walk(ast, (node, scope) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      declarations.push({ scope, name: node.id.name, value: node.init });
    }
    if (node.type === "FunctionDeclaration" && node.id) declarations.push({ scope, name: node.id.name, value: node });
    if (node.type === "FunctionDeclaration" && node.body) {
      const constructors = new Set(), options = new Set();
      let hasParse = false, root = false;
      const frames = [], tokenized = new Set(), eof = new Set();
      walk(node.body, child => {
        if (child.type === "ObjectExpression" && property(child, "type")?.value === "root") root = true;
        if (child.type === "VariableDeclarator" && child.id.type === "Identifier" &&
            child.init?.type === "NewExpression" && child.init.callee.type === "Identifier" &&
            child.init.arguments.length === 4 &&
            child.init.arguments.slice(2).every(arg => arg.type === "Identifier")) {
          frames.push({ instance: child.id.name, construct: child.init });
        }
        if (member(child, "eof")) eof.add(child.object.name);
        if (child.type === "NewExpression" && child.callee.type === "Identifier") constructors.add(child.callee.name);
        if (child.type === "CallExpression") {
          if (member(child.callee, "tokenizeBlock")) tokenized.add(child.callee.object.name);
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
      if (root) for (const frame of frames) {
        if (tokenized.has(frame.instance) && eof.has(frame.instance)) indexed.push({ node, scope, ...frame });
      }
    }
    if (node.type === "CallExpression" && member(node.callee, "defineMode") &&
        node.arguments[0]?.value === "hypermd" && node.arguments.length >= 2) {
      modes.push(node.arguments[1]);
    }
  });
  for (const candidate of indexed) {
    const parser = indexedParser(candidate, declarations);
    if (parser) parsers.push(parser);
  }
  if (parsers.length !== 1 || modes.length !== (kind === "app" ? 1 : 0)) {
    throw Error(`unsupported-native-structure:${kind}:${parsers.length}:${modes.length}`);
  }
  const grammarHook = parsers[0].hook || "__nativeLsd.installGrammar(" + parsers[0].name + ");";
  const insertions = [
    { at: 0, text: `/* native-lsd-core-alias: locally generated; host code is not redistributed */\n(()=>{\n${runtime}\n` },
    { at: parsers[0].at, text: grammarHook },
    ...modes.flatMap(mode => [
      { at: mode.start, text: "__nativeLsd.wrapFactory(" },
      { at: mode.end, text: ")" },
    ]),
    { at: source.length, text: "\n})();\n" },
  ].sort((a, b) => a.at - b.at);
  const output = applyInsertions(source, insertions);
  // A second parse checks that insertion locations did not change expression syntax.
  parse(output, { ecmaVersion: "latest", sourceType: "script" });
  return { output, insertions, hooks: { parser: parsers.length, editor: modes.length }, grammar: parsers[0].family || "prototype" };
}
module.exports = { patchSource };
