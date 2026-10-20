const { Notice, Modal } = require("obsidian");
const Trial = require("./trial-plugin.cjs");
const { digest, toBase64, fromBase64, safeAsset } = require("./trial-core.cjs");
const { foregroundOperation } = require("./trial-async.cjs");
const { packageIdentity, readInstalledPackage } = require("./daily-package.cjs");
const { patchSource } = require("./daily-patch.cjs");
const { installDailyGuard } = require("./daily-bootstrap.cjs");
const { cacheRoot, ownedCache, samePackage, automaticDecision } = require("./daily-state.cjs");
const { runChecks, compareWorkers } = require("./trial-checks.cjs");
const RUNTIME = __DAILY_RUNTIME__;
const ADAPTER = __DAILY_ADAPTER__;
const PLUS = "latex-standard-delimiters-plus";
const ACTIONS = new Set(["enable-auto", "disable-auto", "rebuild", "verify", "inspect", "prepare-restart", "restore", "cleanup", "reload-self", "debug-control", "finish-setup"]);
const NATIVE = new Set([
  "App.getInfo", "WebView.getServerBasePath", "WebView.setServerBasePath", "WebView.setServerAssetPath", "WebView.persistServerBasePath",
  "Filesystem.getUri", "Filesystem.stat", "Filesystem.readFile", "Filesystem.writeFile", "Filesystem.rmdir",
]);
const encode = text => new TextEncoder().encode(text);
const decode = bytes => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

class DailyProgress extends Modal {
  onOpen() {
    this.contentEl.createEl("h3", { text: "原生公式" });
    this.message = this.contentEl.createEl("p");
  }
  update(message) { this.message?.setText(message); }
}

class NativeDelimiters extends Trial {
  async onload() {
    this.loadedAt = performance.now();
    this.active = true;
    this.calls = new AbortController();
    this.busy = false;
    this.controlTimer = null;
    this.initialized = false;
    // A synced plugin installation on desktop/iOS must not overwrite this
    // Android loader's deployment state with an unsupported-platform failure.
    if (window.Capacitor?.getPlatform?.() !== "android") return;
    this.data = await this.loadData() || { schema: 1, phase: "idle" };
    this.data.daily ||= { auto: false, phase: "off", control: false };
    for (const [action, name] of [
      ["enable-auto", "启用原生公式自动加载"],
      ["disable-auto", "停止自动加载并恢复官方资源"],
      ["rebuild", "重新适配当前 Obsidian"],
      ["verify", "检查原生公式兼容性"],
      ["inspect", "查看原生公式状态"],
      ["cleanup", "清理已停用的原生公式缓存"],
      ["debug-control", "开启本地调试控制（10 分钟）"],
    ]) this.addCommand({ id: action, name, callback: () => this.perform(action) });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.initialized) this.startControl();
    });
    // The live checks need Obsidian's workspace and plugin manager initialized.
    this.app.workspace.onLayoutReady(() => {
      if (this.active) void this.initialize().catch(error => this.fail(error));
    });
  }
  async native(plugin, method, options = {}) {
    if (!NATIVE.has(`${plugin}.${method}`)) throw Error("native-method-refused");
    if (!this.active) throw Error("plugin-unloaded");
    return foregroundOperation(() => window.Capacitor.nativePromise(plugin, method, options), {
      document, signal: this.calls.signal, timeoutMessage: `native-call-timeout:${plugin}.${method}`,
    });
  }
  showProgress(message) {
    if (!this.progress) { this.progress = new DailyProgress(this.app); this.progress.open(); }
    this.progress.update(message);
  }
  async report(extra = {}) {
    if (!this.active) return;
    const d = this.data.daily;
    await this.app.vault.adapter.write(this.manifest.dir + "/daily-report.json", JSON.stringify({
      schema: 1, generatedAt: new Date().toISOString(), helperVersion: __DAILY_VERSION__, adapter: ADAPTER,
      automatic: d.auto, phase: d.phase, host: d.identity?.host || null, key: d.key || null,
      persistent: Boolean(d.persistent), stagedFiles: d.stagedFiles || 0, stagedBytes: d.stagedBytes || 0,
      action: this.data.action || null, error: this.data.error || null, blocked: d.blocked?.reason || null,
      timings: d.timings || null, startup: d.startup || null, tests: d.tests || null,
      preflight: d.preflight || null, runtime: d.runtime || null, ...extra,
    }, null, 2));
  }
  async fail(error) {
    if (!this.active) return;
    this.initialized = true;
    this.startControl();
    const d = this.data.daily;
    d.phase = "blocked";
    d.blocked = { identity: d.attemptIdentity || d.identity, adapter: ADAPTER, reason: error?.message || "unknown-error" };
    this.data.error = d.blocked.reason;
    await this.persist();
    await this.report();
    this.progress?.close(); this.progress = null;
    new Notice("原生公式已暂停自动加载：" + this.data.error + "。可继续使用官方功能，或运行“重新适配当前 Obsidian”。", 12000);
    const boot = window.__nativeLsdDailyBoot;
    if (boot && ownedCache(d.path) && await this.currentPath() === d.path) {
      try { await this.saveOpenViews(); }
      catch { new Notice("请先完成输入并保存笔记，再运行“停止自动加载并恢复官方资源”。", 10000); return; }
      boot.restore("compatibility-check-failed");
    }
  }
  async loadPlan() {
    const plan = JSON.parse(await this.app.vault.adapter.read(this.manifest.dir + "/daily-plan.json"));
    if (plan.key !== this.data.daily.key || !Array.isArray(plan.assets) ||
        !["app.js", "worker.js", "index.html"].every(name => plan.assets.some(item => item.path === name))) {
      throw Error("daily-plan-mismatch");
    }
    return plan;
  }
  async cacheExists() {
    if (!ownedCache(this.data.daily.path)) return false;
    try { return (await this.native("Filesystem", "stat", { path: this.data.daily.path + "/index.html" })).type === "file"; }
    catch { return false; }
  }
  async initialize() {
    if (window.Capacitor?.getPlatform?.() !== "android") throw Error("android-only");
    const d = this.data.daily, path = await this.currentPath();
    this.layoutAt = performance.now();
    if (path === "public") {
      // Persisting the official asset name is safe: it is not an absolute file
      // directory, so native startup falls back to bundled assets.
      if (d.persistent || localStorage.getItem("native-lsd-recovery")) {
        await this.native("WebView", "persistServerBasePath");
        d.persistent = false;
      }
      await this.restorePlus();
      const identity = await packageIdentity(this);
      let recovery = null;
      try { recovery = JSON.parse(localStorage.getItem("native-lsd-recovery") || "null"); } catch {}
      const decision = automaticDecision(d, identity, ADAPTER, await this.cacheExists(),
        Boolean(recovery && recovery.key === d.key && recovery.reason !== "disabled"));
      localStorage.removeItem("native-lsd-recovery");
      if (["block", "missing"].includes(decision)) {
        d.blocked = { identity, adapter: ADAPTER, reason: decision === "missing" ? "cache-removed" : recovery?.reason || "incomplete-previous-start" };
        d.phase = "blocked";
        d.auto = false;
        new Notice("原生公式已恢复官方资源，自动加载已暂停。运行“启用原生公式自动加载”可重新开启。", 10000);
      }
      if (decision === "off") d.phase = "off";
      d.startup = this.startupRecord("official");
      await this.persist();
      await this.report();
      this.initialized = true;
      this.startControl();
      const controlled = await this.readRequest();
      if (!controlled && this.active && !this.busy && d.auto && ["cached", "rebuild"].includes(decision)) {
        await this.perform(decision === "rebuild" ? "rebuild" : "enable-auto");
      }
      return;
    }
    if (path !== d.path || !ownedCache(path) || window.__nativeLsdDailyBoot?.key !== d.key) {
      throw Error("another-resource-override-is-active");
    }
    this.busy = true;
    try {
      const boot = window.__nativeLsdDailyBoot;
      await boot.info;
      if (this.app.plugins.enabledPlugins.has(PLUS) || this.app.plugins.getPlugin(PLUS)) throw Error("plus-still-active");
      if (!d.auto) { await this.restore(); return; }
      const first = d.verifiedKey !== d.key || d.adapter !== ADAPTER;
      if (d.adapter !== ADAPTER) {
        d.phase = "update-helper";
        await this.persist();
        // Official mode will rebuild with the new adapter after this one-time reload.
        void this.native("WebView", "setServerAssetPath", { path: "public" }).catch(error => this.fail(error));
        return;
      }
      if (first) {
        await this.verify();
        if (!d.tests?.passed) throw Error("native-compatibility-tests-failed");
        await this.writeCache("native-lsd-ready.json", encode(JSON.stringify({ key: d.key, passed: true })));
        d.verifiedKey = d.key;
      }
      if (!boot.finish()) throw Error("startup-already-reverting");
      d.phase = "active";
      d.blocked = null;
      delete d.attemptIdentity; delete d.attemptAdapter;
      delete this.data.error;
      d.startup = this.startupRecord("native-cache");
      d.startup.fullChecksRun = first;
      if (!d.persistent) await this.native("WebView", "persistServerBasePath");
      d.persistent = true;
      this.data.action = { name: "enable-auto", status: "complete" };
      await this.persist();
      await this.report();
      if (first) {
        await this.removePreviousCache();
        new Notice("原生公式已自动加载；兼容性检查通过。以后启动直接使用本地缓存。", 8000);
      }
    } catch (error) { await this.fail(error); }
    finally { this.busy = false; this.progress?.close(); this.progress = null; }
    this.initialized = true;
    this.startControl();
    void this.readRequest();
  }
  startupRecord(source) {
    return {
      source, timeOrigin: performance.timeOrigin, readyAt: Date.now(),
      pluginLoadedMs: Math.round(this.loadedAt), layoutReadyMs: Math.round(this.layoutAt),
      checkedMs: Math.round(performance.now()),
      fullChecksRun: this.data.daily.phase === "switching",
    };
  }
  startControl() {
    // Earlier development builds had no control flag. Normal installations
    // opt in through a command, and setup explicitly closes this test channel.
    if (this.data.daily.control === false) return;
    this.controlDeadline = this.data.daily.controlUntil || Date.now() + 10 * 60 * 1000;
    if (this.controlTimer != null || Date.now() >= this.controlDeadline) return;
    this.controlTimer = window.setInterval(() => {
      if (Date.now() >= this.controlDeadline) {
        window.clearInterval(this.controlTimer); this.controlTimer = null; return;
      }
      if (this.active && !this.busy && document.visibilityState === "visible") void this.readRequest();
    }, 1500);
  }
  async readRequest() {
    if (this.data.daily.control === false || this.readingRequest || this.busy || !this.active) return;
    this.readingRequest = true;
    try {
      const path = this.manifest.dir + "/request.json";
      if (!await this.app.vault.adapter.exists(path)) return;
      const request = JSON.parse(await this.app.vault.adapter.read(path));
      if (!/^[a-z0-9-]{1,80}$/.test(request.id || "") || !ACTIONS.has(request.action) || request.id === this.data.lastRequest) return;
      this.data.lastRequest = request.id;
      await this.persist();
      await this.perform(request.action);
      return true;
    } catch (error) { await this.fail(error); }
    finally { this.readingRequest = false; }
  }
  async perform(action) {
    if (!ACTIONS.has(action) || this.busy) return;
    this.busy = true;
    this.startControl();
    this.data.action = { name: action, status: "running" };
    const d = this.data.daily;
    try {
      await this.persist(); await this.report();
      if (action === "debug-control") {
        d.control = true; d.controlUntil = Date.now() + 10 * 60 * 1000;
        this.startControl();
        new Notice("本地调试控制已开启，10 分钟后自动停止。", 5000);
      } else if (action === "finish-setup") {
        d.control = false;
        delete d.controlUntil;
        window.clearInterval(this.controlTimer); this.controlTimer = null;
      } else if (action === "enable-auto" || action === "rebuild") {
        d.auto = true;
        d.blocked = null;
        localStorage.removeItem("native-lsd-recovery");
        if (await this.currentPath() !== "public") {
          if (action === "rebuild") {
            d.adapter = "rebuild-requested";
            await this.saveOpenViews(); await this.persist();
            void this.native("WebView", "setServerAssetPath", { path: "public" }).catch(error => this.fail(error));
          }
        } else {
          const identity = await packageIdentity(this);
          if (action === "rebuild" || !samePackage(d.identity, identity) || d.adapter !== ADAPTER || !await this.cacheExists()) {
            // Record the target before APK reading/parsing can fail or be
            // interrupted; an old cache identity must not defeat the breaker.
            d.attemptIdentity = identity; d.attemptAdapter = ADAPTER; d.phase = "staging";
            await this.persist();
            await this.prepare();
          }
          await this.start();
        }
      } else if (action === "restore" || action === "disable-auto") {
        d.auto = false;
        await this.persist();
        await this.restore();
      } else if (action === "prepare-restart") {
        this.showProgress("正在保存笔记，准备检查完整重启后的自动加载。");
        await this.saveOpenViews();
        this.data.restartCheckpoint = { saved: true, at: new Date().toISOString() };
        this.holdProgress = true;
      } else if (action === "reload-self") {
        if (await this.currentPath() !== "public") throw Error("restore-before-reloading-helper");
        const manager = this.app.plugins, id = this.manifest.id;
        setTimeout(async () => { await manager.disablePlugin(id); await manager.enablePlugin(id); }, 100);
      } else await this[action]();
      this.data.action = { name: action, status: "complete" };
      if (d.phase !== "blocked") delete this.data.error;
      await this.persist(); await this.report();
    } catch (error) {
      this.data.action = { name: action, status: "failed" };
      await this.fail(error);
    } finally {
      if (!this.holdProgress) { this.progress?.close(); this.progress = null; }
      this.busy = false;
    }
  }
  async writeCache(name, bytes) {
    const path = this.data.daily.path;
    if (!ownedCache(path) || !safeAsset(name)) throw Error("cache-write-refused");
    await this.native("Filesystem", "writeFile", { path: path + "/" + name, data: toBase64(bytes), recursive: true });
  }
  async readCache(name) {
    const path = this.data.daily.path;
    if (!ownedCache(path) || !safeAsset(name)) throw Error("cache-read-refused");
    return fromBase64((await this.native("Filesystem", "readFile", { path: path + "/" + name })).data);
  }
  async prepare() {
    if (await this.currentPath() !== "public") throw Error("official-resources-required");
    await this.saveOpenViews();
    if (this.data.base) await super.cleanup();
    const began = performance.now(), d = this.data.daily;
    this.showProgress("正在读取本机官方安装包，检查此次版本的兼容性。");
    const pkg = await readInstalledPackage(this);
    for (const name of ["app.js", "worker.js"]) {
      if (await digest(await this.localResource(name)) !== await digest(pkg.assets.get(name))) {
        throw Error("installed-package-does-not-match-official-runtime");
      }
    }
    d.identity = pkg.identity;
    const patched = {};
    for (const kind of ["app", "worker"]) {
      this.progress.update("正在适配原生" + (kind === "app" ? "编辑器" : "阅读解析器") + "。");
      // Yield before CPU work so progress paints.
      await pause(30);
      patched[kind] = patchSource(decode(pkg.assets.get(kind + ".js")), kind, RUNTIME);
    }
    this.progress.update("正在比较标准 delimiter 与原生美元公式。");
    d.preflight = await compareWorkers(decode(pkg.assets.get("worker.js")), patched.worker.output, this.calls.signal);
    if (d.preflight.total !== 32 || d.preflight.passed !== d.preflight.total) throw Error("new-version-worker-check-failed");
    const root = cacheRoot(this.app.vault.adapter.basePath || this.app.vault.adapter.getBasePath?.());
    if (ownedCache(d.path)) d.previousPath = d.path;
    d.path = root + "/" + crypto.randomUUID() + "/public";
    d.key = pkg.apkSha256 + "-" + ADAPTER;
    d.adapter = ADAPTER;
    delete d.verifiedKey;
    d.phase = "staging";
    d.stagedFiles = 0; d.stagedBytes = 0;
    d.timings = { adaptedMs: Math.round(performance.now() - began) };
    await this.persist();
    const plan = { key: d.key, host: pkg.host, assets: [] };
    for (const kind of ["app", "worker"]) {
      const name = kind + ".js", original = pkg.assets.get(name);
      plan.assets.push({ path: name, sourceSha256: await digest(original), insertions: patched[kind].insertions });
      pkg.assets.set(name, encode(patched[kind].output));
    }
    let html = decode(pkg.assets.get("index.html"));
    if ((html.match(/<head>/g) || []).length !== 1) throw Error("unsupported-html-entry");
    const expected = JSON.stringify({ key: d.key, identity: pkg.identity }).replaceAll("<", "\\u003c");
    const bootstrap = `\n<script>(${installDailyGuard.toString()})(window,${expected});</script>\n`;
    html = html.replace("<head>", "<head>" + bootstrap);
    pkg.assets.set("index.html", encode(html));
    // Write entry last; never persist a directory until every file and native test passes.
    const entries = [...pkg.assets.entries()].filter(([name]) => name !== "index.html");
    entries.push(["index.html", pkg.assets.get("index.html")]);
    for (let offset = 0; offset < entries.length; offset += 4) {
      await Promise.all(entries.slice(offset, offset + 4).map(async ([name, bytes]) => {
        const hash = await digest(bytes);
        await this.writeCache(name, bytes);
        if (await digest(await this.readCache(name)) !== hash) throw Error("cache-write-verification-failed");
        const item = plan.assets.find(item => item.path === name) || { path: name };
        Object.assign(item, { sha256: hash, bytes: bytes.length });
        if (!plan.assets.includes(item)) plan.assets.push(item);
        d.stagedFiles++; d.stagedBytes += bytes.length;
      }));
      this.progress.update(`正在准备并校验本地缓存 ${d.stagedFiles}/${entries.length}。`);
    }
    d.timings.preparedMs = Math.round(performance.now() - began);
    d.phase = "staged";
    await this.app.vault.adapter.write(this.manifest.dir + "/daily-plan.json", JSON.stringify(plan));
    await this.persist(); await this.report();
  }
  async start() {
    const d = this.data.daily;
    if (await this.currentPath() !== "public" || !await this.cacheExists()) throw Error("cache-not-ready");
    const plan = await this.loadPlan();
    this.showProgress("正在保存当前笔记并加载原生公式。");
    for (const name of ["app.js", "worker.js", "index.html"]) {
      if (await digest(await this.readCache(name)) !== plan.assets.find(item => item.path === name).sha256) {
        throw Error("cached-core-changed");
      }
    }
    if (!samePackage(d.identity, await packageIdentity(this))) throw Error("application-updated-during-prepare");
    await this.saveOpenViews();
    this.data.plusRestoreRequired = this.app.plugins.enabledPlugins.has(PLUS);
    if (this.data.plusRestoreRequired) {
      await this.app.plugins.disablePluginAndSave(PLUS); await this.app.plugins.saveConfig();
    }
    d.phase = "switching";
    await this.persist(); await this.report();
    void this.native("WebView", "setServerBasePath", { path: d.path }).catch(error => this.fail(error));
    await pause(1000);
  }
  async verify() {
    const d = this.data.daily;
    if (await this.currentPath() !== d.path) throw Error("native-cache-not-active");
    this.showProgress("正在验证原生阅读、表格、嵌入、着色与撤销。此检查只在适配后或手动请求时运行。");
    const previous = this.app.workspace.activeLeaf;
    await this.createNotes();
    const start = performance.now();
    try {
      d.tests = await runChecks(this, await this.loadPlan());
      d.timings ||= {};
      d.timings.validationMs = Math.round(performance.now() - start);
      await this.persist(); await this.report();
      if (!d.tests.passed) throw Error("native-compatibility-tests-failed");
    } finally {
      if (previous?.view) this.app.workspace.setActiveLeaf(previous, { focus: false });
      if (this.active) await this.cleanNotes();
    }
  }
  async cleanNotes() {
    for (const [name, path] of Object.entries(this.data.notes || {})) {
      if (!this.data.noteFolder || !path.startsWith(this.data.noteFolder + "/")) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && await digest(encode(await this.app.vault.read(file))) === this.data.noteHashes[name]) await this.app.vault.delete(file);
    }
    const folder = this.app.vault.getAbstractFileByPath(this.data.noteFolder || "");
    if (folder?.children?.length === 0 && folder.path === this.data.noteFolder) await this.app.vault.delete(folder);
    delete this.data.notes; delete this.data.noteHashes; delete this.data.noteFolder;
    await this.persist();
  }
  async restore() {
    const d = this.data.daily, path = await this.currentPath();
    this.showProgress("正在保存笔记并恢复官方资源。");
    await this.saveOpenViews();
    if (path === "public") {
      await this.native("WebView", "persistServerBasePath");
      d.persistent = false;
      d.phase = "off";
      d.blocked = null;
      delete this.data.error;
      await this.restorePlus();
      return;
    }
    if (path !== d.path || !ownedCache(path)) throw Error("foreign-resource-directory");
    d.phase = "restoring";
    await this.persist(); await this.report();
    window.__nativeLsdDailyBoot.restore("disabled");
    await pause(1000);
  }
  async inspect() {
    const path = await this.currentPath(), d = this.data.daily, info = await this.native("App", "getInfo");
    const hashes = {};
    for (const name of ["app.js", "worker.js"]) hashes[name] = await digest(await this.localResource(name));
    d.runtime = { host: { version: info.version, build: String(info.build) }, source: path === "public" ? "official" : path === d.path ? "native-cache" : "other", hashes };
    await this.persist(); await this.report();
    new Notice(`原生公式：${d.runtime.source === "native-cache" ? "原生缓存" : "官方资源"}；自动加载${d.auto ? "已启用" : "已停止"}。`, 5000);
  }
  async removePreviousCache() {
    const d = this.data.daily;
    if (!ownedCache(d.previousPath) || d.previousPath === d.path || await this.currentPath() === d.previousPath) return;
    try { await this.native("Filesystem", "rmdir", { path: d.previousPath.slice(0, -7), recursive: true }); }
    catch { return; }
    delete d.previousPath;
    await this.persist();
  }
  async cleanup() {
    const d = this.data.daily;
    if (await this.currentPath() !== "public" || d.auto) throw Error("disable-auto-before-cleanup");
    await this.saveOpenViews();
    await this.native("WebView", "persistServerBasePath");
    d.persistent = false;
    await this.removePreviousCache();
    if (ownedCache(d.path)) await this.native("Filesystem", "rmdir", { path: d.path.slice(0, -7), recursive: true });
    await this.cleanNotes();
    delete d.path; delete d.verifiedKey;
    d.phase = "off";
    d.stagedFiles = 0; d.stagedBytes = 0;
  }
}
module.exports = NativeDelimiters;
