import "./build-daily.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
const root = resolve(import.meta.dirname, "../..");
const out = resolve(root, "dist/native-delimiter-daily");
const manifest = JSON.parse(await readFile(resolve(out, "manifest.json"), "utf8"));
const files = {};
for (const name of ["main.js", "manifest.json", "LICENSES.txt", "build-report.json"]) {
  files[manifest.id + "/" + name] = new Uint8Array(await readFile(resolve(out, name)));
}
files[manifest.id + "/README.md"] = new Uint8Array(await readFile(resolve(import.meta.dirname, "DAILY.md")));
files[manifest.id + "/NOTICE.md"] = new Uint8Array(await readFile(resolve(root, "NOTICE.md")));
for (const name of ["daily-startup.json", "daily-verification.json", "live-daily.json", "live-daily-recovery.json", "live-package-read.json"]) {
  files[manifest.id + "/" + name] = new Uint8Array(await readFile(resolve(import.meta.dirname, name)));
}
const archive = `native-delimiters-${manifest.version}.zip`;
await writeFile(resolve(out, archive), zipSync(files, { level: 9 }));
const names = ["main.js", "manifest.json", "LICENSES.txt", "build-report.json", archive];
const sums = [];
for (const name of names) {
  const hash = createHash("sha256").update(await readFile(resolve(out, name))).digest("hex");
  sums.push(hash + "  " + name);
}
await writeFile(resolve(out, "SHA256SUMS"), sums.join("\n") + "\n");
console.log(JSON.stringify({ archive, files: Object.keys(files), hostCodeDistributed: false }));
