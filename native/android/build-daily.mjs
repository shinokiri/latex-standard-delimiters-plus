import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
const root = resolve(import.meta.dirname, "../..");
const version = "0.2.0";
const runtime = (await build({
  entryPoints: [resolve(root, "native/src/core-runtime.ts")],
  bundle: true, format: "iife", globalName: "__nativeLsd", write: false, minify: true, target: "es2022",
})).outputFiles[0].text;
const hash = createHash("sha256").update(runtime);
for (const file of ["daily-patch.cjs", "daily-bootstrap.cjs"]) hash.update(await readFile(resolve(import.meta.dirname, file)));
const adapter = "v2-" + hash.digest("hex").slice(0, 16);
const out = resolve(root, "dist/native-delimiter-daily");
await mkdir(out, { recursive: true });
const notices = [];
for (const [name, path] of [
  ["Project (MIT)", "LICENSE"],
  ["Acorn 8.18.0 (MIT)", "node_modules/acorn/LICENSE"],
  ["fflate 0.8.3 (MIT)", "node_modules/fflate/LICENSE"],
]) notices.push(name + "\n\n" + await readFile(resolve(root, path), "utf8"));
const licenses = notices.join("\n\n");
await build({
  entryPoints: [resolve(import.meta.dirname, "daily-plugin.cjs")],
  outfile: resolve(out, "main.js"), bundle: true, format: "cjs", platform: "browser", target: "es2022", minify: true,
  external: ["obsidian", "@codemirror/language", "@codemirror/commands"],
  define: {
    __TRIAL_PLAN__: "{}", __DAILY_RUNTIME__: JSON.stringify(runtime),
    __DAILY_VERSION__: JSON.stringify(version), __DAILY_ADAPTER__: JSON.stringify(adapter),
  },
  footer: { js: "/*\n" + licenses.replaceAll("*/", "* /") + "\n*/" },
});
await writeFile(resolve(out, "manifest.json"), JSON.stringify({
  id: "native-delimiter-trial", name: "Native Delimiters", version, minAppVersion: "1.14.4",
  author: "shinokiri", isDesktopOnly: false,
  description: "Android native LaTeX delimiter aliases with cached startup, local update adaptation and official-resource recovery.",
}, null, 2) + "\n");
await writeFile(resolve(out, "LICENSES.txt"), licenses + "\n");
const report = { version, adapter, bytes: (await readFile(resolve(out, "main.js"))).length, hostCodeDistributed: false, buildRequiresAPK: false };
await writeFile(resolve(out, "build-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
