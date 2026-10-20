import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { build } from "esbuild";

const known = {
  app: "7591ddf1df0414b26af79b9ae7fcaffc0f210332686520523fc3a391d675800e",
  worker: "a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae"
};
const hash = source => createHash("sha256").update(source).digest("hex");

/** Produce a separate patched artifact. Never edit an installed application.
 * Application identifiers are discovered from syntax, not guessed/minifier names.
 * Host binaries and generated derivatives must not be committed or redistributed.
 */
export async function patchCore(input, kind) {
  if (!["app", "worker"].includes(kind)) throw new Error("kind must be app or worker");
  if (input.includes("native-lsd-core-alias")) throw new Error("Input is already patched");
  if (hash(input) !== known[kind]) throw new Error("Unsupported host checksum: only the evaluated Obsidian 1.14.4 Android bundles are accepted");
  const ast = ts.createSourceFile(kind + ".js", input, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error("Host bundle could not be parsed");
  const parsers = [], modes = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body) {
      const body = node.body.getText(ast);
      const constructors = [...body.matchAll(/\bnew ([\w$]+)\(/g)].map(match => match[1]);
      const parser = constructors.find(name => body.includes(".setOptions(" + name + ".globalOptions)"));
      if (parser && body.includes(".parse()")) parsers.push({node, parser});
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "defineMode" && node.arguments.length >= 2 &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "hypermd") modes.push(node.arguments[1]);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (parsers.length !== 1 || modes.length !== (kind === "app" ? 1 : 0)) {
    throw new Error(`Unsupported host structure: ${parsers.length} central parsers, ${modes.length} HyperMD factories`);
  }
  const changes = [{
    from: parsers[0].node.body.getStart(ast) + 1,
    to: parsers[0].node.body.getStart(ast) + 1,
    text: `__nativeLsd.installGrammar(${parsers[0].parser});`
  }];
  for (const mode of modes) changes.push({
    from: mode.getStart(ast), to: mode.end,
    text: `__nativeLsd.wrapFactory(${mode.getText(ast)})`
  });
  let output = input;
  for (const change of changes.sort((a, b) => b.from - a.from)) output = output.slice(0, change.from) + change.text + output.slice(change.to);
  const runtime = await build({
    entryPoints: [resolve(import.meta.dirname, "src/core-runtime.ts")],
    bundle: true, format: "iife", globalName: "__nativeLsd", write: false, minify: true, target: "es2022"
  });
  output = `/* native-lsd-core-alias: evaluation artifact; Obsidian host code is not redistributed */\n(()=>{\n${runtime.outputFiles[0].text}\n${output}\n})();\n`;
  if (ts.createSourceFile("patched.js", output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS).parseDiagnostics.length) {
    throw new Error("Patched bundle did not parse");
  }
  return {
    output,
    runtime: runtime.outputFiles[0].text,
    report: {kind, hostVersion: "1.14.4", hostPlatform: "Android", centralParserHooks: 1, editorModeHooks: modes.length, originalBytes: Buffer.byteLength(input),
      patchedBytes: Buffer.byteLength(output), originalSha256: hash(input), patchedSha256: hash(output)}
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath || !outputPath || resolve(inputPath) === resolve(outputPath)) {
    throw new Error("Usage: node native/patch-core.mjs app|worker INPUT.js DIFFERENT_OUTPUT.js");
  }
  const result = await patchCore(await readFile(inputPath, "utf8"), kind);
  await mkdir(dirname(resolve(outputPath)), {recursive: true});
  await writeFile(outputPath, result.output);
  await writeFile(outputPath + ".runtime.js", result.runtime);
  await writeFile(outputPath + ".verification.json", JSON.stringify(result.report, null, 2) + "\n");
  console.log(JSON.stringify(result.report));
}
