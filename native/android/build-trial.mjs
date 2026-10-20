import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { patchCore } from "../patch-core.mjs";

const root = resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);
const { installTrialGuard } = require("./trial-bootstrap.cjs");
const { validatePlan, applyInsertions } = require("./trial-core.cjs");
const apk = process.argv[2];
if (!apk) throw Error("Usage: node native/android/build-trial.mjs /path/to/installed/base.apk");
const source = resolve(root, ".local-fixtures/trial-source");
await mkdir(source, { recursive: true });
const inventory = JSON.parse(execFileSync("python", ["-c", `
import importlib.util, json, hashlib, sys, zipfile
from pathlib import Path
spec=importlib.util.spec_from_file_location("overlay",sys.argv[3])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
out=Path(sys.argv[2]);items=[]
with zipfile.ZipFile(sys.argv[1]) as archive:
 config=json.loads(archive.read("assets/capacitor.config.json"))
 assert config.get("appId")=="md.obsidian" and config.get("appendUserAgent")=="obsidian/1.14.4"
 for name,entry in module.asset_entries(archive):
  data=archive.read(entry); digest=hashlib.sha256(data).hexdigest()
  item={"path":name,"bytes":len(data),"sha256":digest,"sourceSha256":digest}
  if "." not in name.rsplit("/",1)[-1]:
   assert name.startswith("lib/pdfjs/") and name.rsplit("/",1)[-1].startswith("LICENSE") and len(data)<16384
   item["localOnly"]=True
   target=out/"local-assets"/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
  items.append(item)
  if name in ["app.js","worker.js","index.html"]: (out/name).write_bytes(data)
print(json.dumps(items))
`, apk, source, resolve(import.meta.dirname, "prepare-overlay.py")], {
  encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, maxBuffer: 1024 * 1024,
}));
const hash = text => createHash("sha256").update(text).digest("hex");
const reports = {};
for (const kind of ["app", "worker"]) {
  const original = await readFile(resolve(source, kind + ".js"), "utf8");
  const patched = await patchCore(original, kind);
  if (applyInsertions(original, patched.insertions) !== patched.output) throw Error("Patch plan differs from evaluated core output");
  const item = inventory.find(item => item.path === kind + ".js");
  Object.assign(item, { bytes: Buffer.byteLength(patched.output), sha256: hash(patched.output), insertions: patched.insertions });
  reports[kind] = patched.report;
  await writeFile(resolve(source, `patched-${kind}.js`), patched.output);
}
const index = await readFile(resolve(source, "index.html"), "utf8");
if ((index.match(/<head>/g) || []).length !== 1) throw Error("Unsupported HTML entry");
const entry = inventory.find(item => item.path === "index.html");
entry.insertions = [{ at: index.indexOf("<head>") + 6, text: '\n<script src="native-lsd-trial-bootstrap.js"></script>\n' }];
const html = applyInsertions(index, entry.insertions);
entry.bytes = Buffer.byteLength(html);
entry.sha256 = hash(html);
const ownSource = `(${installTrialGuard.toString()})(window,{"version":"1.14.4","build":"389"});\n`;
inventory.push({ path: "native-lsd-trial-bootstrap.js", bytes: Buffer.byteLength(ownSource), sha256: hash(ownSource), ownSource });
const plan = validatePlan({ schema: 1, version: "1.14.4", build: "389", assets: inventory.sort((a, b) => a.path.localeCompare(b.path)) });
const out = resolve(root, "dist/native-delimiter-trial");
await mkdir(out, { recursive: true });
for (const item of plan.assets.filter(item => item.localOnly)) {
  const target = resolve(out, "local-assets", item.path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(source, "local-assets", item.path), target);
}
await build({
  entryPoints: [resolve(import.meta.dirname, "trial-plugin.cjs")],
  outfile: resolve(out, "main.js"), bundle: true, format: "cjs", platform: "browser",
  target: "es2022", minify: true, external: ["obsidian", "@codemirror/language", "@codemirror/commands"],
  define: { __TRIAL_PLAN__: JSON.stringify(plan) },
});
await writeFile(resolve(out, "manifest.json"), JSON.stringify({
  id: "native-delimiter-trial", name: "Native Delimiter Trial", version: "0.1.1",
  minAppVersion: "1.14.4", author: "shinokiri", isDesktopOnly: false,
  description: "Non-persistent Android native delimiter trial with verified local resources and recovery.",
}, null, 2) + "\n");
const result = {
  schema: 1, host: { version: "1.14.4", build: "389" }, assets: plan.assets.length,
  stagedBytes: plan.assets.reduce((sum, item) => sum + item.bytes, 0),
  pluginBytes: (await readFile(resolve(out, "main.js"))).byteLength,
  localAuxiliaryFiles: plan.assets.filter(item => item.localOnly).length,
  localAuxiliaryBytes: plan.assets.filter(item => item.localOnly).reduce((sum, item) => sum + item.bytes, 0),
  hostCodeDistributed: false, persistentActivationAvailable: false,
  corePatches: reports, bootstrapAdded: true, htmlEntryChanged: true,
  changedHostAssets: ["app.js", "worker.js", "index.html"], unchangedHostAssets: 321,
};
await writeFile(resolve(root, ".local-fixtures/trial-plan.json"), JSON.stringify(plan));
await writeFile(resolve(out, "build-report.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
