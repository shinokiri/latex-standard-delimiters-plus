import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import type { LegacyCodeMirror } from "../src/projection";
import type { NativeMode } from "../src/native-mode";

const fixtures = resolve(import.meta.dirname, "../../.local-fixtures");
export const hasHost = ["codemirror.js", "markdown.js", "modes.min.js", "hypermd.js", "native-codemirror.js", "native-worker.js"]
  .every(name => existsSync(resolve(fixtures, name)));

export function worker(file = "native-worker.js") {
  let response: unknown;
  const context: Record<string, unknown> = { TextDecoder, TextEncoder, console, setTimeout, clearTimeout, postMessage: (data: unknown) => { response = data; } };
  context.self = context;
  vm.runInNewContext(readFileSync(resolve(fixtures, file), "utf8"), context);
  const request = (data: unknown) => {
    response = undefined;
    (context.onmessage as (event: {data: unknown}) => void)({data});
    if (!response) throw new Error("Native parser returned no result");
    return JSON.parse(JSON.stringify(response));
  };
  return {
    sections: (source: string) => request({parseSections: source, options: {breaks: true, commonmark: true}}),
    metadata: (source: string) => request({metadataCache: new TextEncoder().encode(source).buffer})
  };
}

export function host() {
  const dom = new JSDOM("<!doctype html><body></body>", {
    runScripts: "outside-only", pretendToBeVisual: true, url: "https://fixture.invalid"
  });
  const win = dom.window;
  win.eval("var jj,Uj,Wj; var m=Object.assign; String.prototype.contains=String.prototype.includes; Array.prototype.contains=Array.prototype.includes;");
  for (const name of ["codemirror", "markdown", "modes.min", "hypermd"]) win.eval(readFileSync(resolve(fixtures, name + ".js"), "utf8"));
  win.nativeModules = {};
  win.eval(readFileSync(resolve(fixtures, "native-codemirror.js"), "utf8"));
  const runtimePath = resolve(fixtures, "patched-app.js.runtime.js");
  if (existsSync(runtimePath)) win.eval(readFileSync(runtimePath, "utf8") + "\nglobalThis.__nativeLsd = __nativeLsd;");
  const parser = worker();
  return {
    cm: win.CodeMirror as LegacyCodeMirror,
    state: win.nativeModules["@codemirror/state"] as typeof import("@codemirror/state"),
    language: win.nativeModules["@codemirror/language"] as typeof import("@codemirror/language"),
    tokenProp: win.nativeModules.test.tokenProp,
    lineProp: win.nativeModules.test.lineProp,
    coreFactory: win.__nativeLsd?.wrapFactory as ((factory: () => NativeMode) => () => NativeMode) | undefined,
    ...parser,
    close: () => dom.window.close()
  };
}
