/* Read-only native bridge probe. Only its own Obsidian plugin data is saved. */
const { Plugin, Notice } = require("obsidian");

const EXPECTED = Object.freeze({
  "app.js": "7591ddf1df0414b26af79b9ae7fcaffc0f210332686520523fc3a391d675800e",
  "worker.js": "a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae",
});
const READS = new Set(["App.getInfo", "WebView.getServerBasePath", "Filesystem.getUri"]);

async function deadline(operation, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function nativeRead(capacitor, plugin, method, options = {}) {
  if (!READS.has(`${plugin}.${method}`)) throw new Error("Non-read method rejected");
  if (typeof capacitor?.nativePromise !== "function") throw new Error("Native bridge unavailable");
  return deadline(capacitor.nativePromise(plugin, method, options));
}

function pathClass(path) {
  if (path === "public") return "bundled-public-assets";
  if (typeof path !== "string" || !path) return "missing";
  if (/^(file:\/\/)?\/data\/(user\/\d+|data)\/md\.obsidian(?:\/|$)/.test(path)) {
    return "obsidian-private-directory";
  }
  return "other-directory";
}

async function hashResource(win, name) {
  if (!Object.hasOwn(EXPECTED, name)) throw new Error("Unexpected resource");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const url = new URL(name, win.location.origin + "/");
    const response = await win.fetch(url.href, {
      cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const digest = await win.crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    return { bytes: bytes.byteLength, sha256, matchesEvaluatedHost: sha256 === EXPECTED[name] };
  } finally {
    clearTimeout(timer);
  }
}

async function collect(win) {
  const capacitor = win.Capacitor;
  const report = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    probeOnly: true,
    platform: capacitor?.getPlatform?.() || "unknown",
    nativeBridge: typeof capacitor?.nativePromise === "function",
    headerMethods: {},
    checks: {},
    activationAttempted: false,
  };
  for (const name of ["App", "WebView", "Filesystem"]) {
    const header = capacitor?.PluginHeaders?.find(item => item.name === name);
    report.headerMethods[name] = header?.methods?.map(item => item.name).sort() || [];
  }
  if (report.platform !== "android" || !report.nativeBridge) {
    report.reason = "This probe targets the Android Capacitor container.";
    return report;
  }
  const checks = {
    app: async () => {
      const info = await nativeRead(capacitor, "App", "getInfo");
      return { id: info.id, version: info.version, build: info.build };
    },
    server: async () => {
      const info = await nativeRead(capacitor, "WebView", "getServerBasePath");
      return { pathKind: pathClass(info.path) };
    },
    privateFiles: async () => {
      const info = await nativeRead(capacitor, "Filesystem", "getUri", { directory: "DATA", path: "" });
      return { pathKind: pathClass(info.uri) };
    },
    appResource: () => hashResource(win, "app.js"),
    workerResource: () => hashResource(win, "worker.js"),
  };
  await Promise.all(Object.entries(checks).map(async ([name, check]) => {
    try {
      report.checks[name] = { ok: true, value: await check() };
    } catch (error) {
      // Native errors can include private paths; retain only the error category.
      report.checks[name] = { ok: false, error: error?.name || "Error", timedOut: error?.message === "timeout" };
    }
  }));
  const ok = name => report.checks[name]?.ok;
  report.readiness = {
    officialApp: ok("app") && report.checks.app.value.id === "md.obsidian",
    evaluatedBinary: ok("app") && report.checks.app.value.version === "1.14.4" &&
      String(report.checks.app.value.build) === "389",
    bundledResourcesActive: ok("server") &&
      report.checks.server.value.pathKind === "bundled-public-assets",
    exactResources: ["appResource", "workerResource"].every(name =>
      ok(name) && report.checks[name].value.matchesEvaluatedHost),
    privateStorageAddressable: ok("privateFiles") &&
      report.checks.privateFiles.value.pathKind === "obsidian-private-directory",
    switchMethodAdvertised: report.headerMethods.WebView.includes("setServerBasePath"),
    restoreMethodAdvertised: report.headerMethods.WebView.includes("setServerAssetPath"),
  };
  report.liveReadChecksPassed = Object.values(report.readiness).every(Boolean);
  // Passing these reads does not prove a switch, full startup or touch/IME parity.
  return report;
}

class NativeDelimiterProbe extends Plugin {
  onload() {
    this.active = true;
    this.running = null;
    this.addCommand({
      id: "inspect-native-container",
      name: "检查 Android 原生资源入口（仅探测）",
      callback: () => this.runProbe(),
    });
    this.app.workspace.onLayoutReady(() => {
      if (this.active) void this.runProbe();
    });
  }
  onunload() {
    this.active = false;
  }
  async runProbe() {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        const report = await collect(window);
        if (!this.active) return;
        await this.saveData(report);
        new Notice(report.liveReadChecksPassed
          ? "原生资源入口探测通过；报告已保存。未切换资源。"
          : "原生资源入口探测完成；报告已保存。未切换资源。", 8000);
      } catch {
        if (this.active) new Notice("探测报告保存失败；未切换资源。", 8000);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}

module.exports = NativeDelimiterProbe;
module.exports._test = { collect, nativeRead, pathClass };
