const { Plugin, Notice, Modal } = require("obsidian");
const {
  HOST, applyInsertions, safeAsset, safePrivateBase, validatePlan, digest,
  toBase64, fromBase64, ownedAbsolutePath,
} = require("./trial-core.cjs");
const { preview, editorStandard, editorDollar, embedSource, runChecks } = require("./trial-checks.cjs");
const { foregroundOperation } = require("./trial-async.cjs");
const { inspectInstalledPackage } = require("./daily-package.cjs");
const PLAN = __TRIAL_PLAN__;
const PLUS = "latex-standard-delimiters-plus";
const ACTIONS = new Set(["prepare", "start", "verify", "inspect", "inspect-package", "prepare-restart", "restore", "cleanup", "reload-self"]);
const NATIVE = new Set([
  "App.getInfo", "WebView.getServerBasePath", "WebView.setServerBasePath", "WebView.setServerAssetPath",
  "Filesystem.getUri", "Filesystem.writeFile", "Filesystem.readFile", "Filesystem.rmdir",
  "Filesystem.stat",
]);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

class Progress extends Modal {
  onOpen() {
    this.contentEl.createEl("h3", { text: "原生公式试运行" });
    this.message = this.contentEl.createEl("p", { text: "正在校验…" });
    this.contentEl.createEl("p", { text: "请等待操作完成。此次试运行不会保存跨进程的资源切换设置。" });
  }
  update(message) { this.message?.setText(message); }
}

class NativeDelimiterTrial extends Plugin {
  async onload() {
    this.active = true;
    this.calls = new AbortController();
    this.busy = false;
    this.controlTimer = null;
    this.initialized = false;
    this.data = await this.loadData() || { schema: 1, phase: "idle" };
    validatePlan(PLAN);
    for (const [action, name] of [
      ["prepare", "准备并校验原生公式试运行"],
      ["start", "启动原生公式试运行（会重载界面）"],
      ["verify", "重新检查原生公式试运行"],
      ["restore", "退出试运行并恢复官方资源"],
      ["cleanup", "清理已退出的试运行资源"],
    ]) this.addCommand({ id: action, name, callback: () => this.perform(action) });
    this.app.workspace.onLayoutReady(() => {
      if (this.active) void this.initialize().catch(error => this.recordError(error));
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.initialized) this.startControl();
    });
  }
  onunload() {
    this.active = false;
    this.calls.abort();
    window.clearInterval(this.controlTimer);
    this.progress?.close();
  }
  async persist() {
    if (this.active === false) return;
    await this.saveData(this.data);
  }
  async report(extra = {}) {
    if (this.active === false) return;
    const report = {
      schema: 1, generatedAt: new Date().toISOString(), phase: this.data.phase,
      host: { version: HOST.version, build: HOST.build }, persistentOverrideWritten: false,
      stagedFiles: this.data.stagedFiles || 0, stagedBytes: this.data.stagedBytes || 0,
      plusRestoreRequired: Boolean(this.data.plusRestoreRequired),
      boot: this.data.boot || null, tests: this.data.tests || null,
      runtime: this.data.runtime || null,
      action: this.data.action || null, ...extra,
    };
    await this.app.vault.adapter.write(this.manifest.dir + "/trial-report.json", JSON.stringify(report, null, 2));
  }
  async recordError(error) {
    if (this.active === false) return;
    this.data.error = error?.message || "unknown-error";
    await this.persist();
    await this.report({ error: this.data.error });
    new Notice("原生公式试运行：" + this.data.error, 10000);
  }
  async native(plugin, method, options = {}) {
    if (!NATIVE.has(`${plugin}.${method}`)) throw new Error("native-method-refused");
    if (!this.active) throw new Error("plugin-unloaded");
    return foregroundOperation(() => window.Capacitor.nativePromise(plugin, method, options), {
      document, signal: this.calls.signal,
      timeoutMessage: `native-call-timeout:${plugin}.${method}`,
    });
  }
  async localResource(path) {
    if (!safeAsset(path)) throw new Error("invalid-resource-path");
    const controller = new AbortController();
    try {
      return await foregroundOperation(async () => {
        const response = await fetch(new URL("/" + path, location.origin).href, {
          credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
        });
        if (!response.ok) throw new Error("resource-fetch-failed");
        return new Uint8Array(await response.arrayBuffer());
      }, {
        document, signal: this.calls.signal, timeoutMessage: "resource-fetch-timeout",
      });
    } finally { controller.abort(); }
  }
  async privateRead(path) {
    if (!safePrivateBase(this.data.base) || !safeAsset(path)) throw new Error("private-read-refused");
    const result = await this.native("Filesystem", "readFile", { directory: "DATA", path: this.data.base + "/" + path });
    return fromBase64(result.data);
  }
  async currentPath() {
    return (await this.native("WebView", "getServerBasePath")).path;
  }
  async checkBinary() {
    const info = await this.native("App", "getInfo");
    if (info.id !== "md.obsidian" || info.version !== HOST.version || String(info.build) !== HOST.build) {
      throw new Error("unsupported-obsidian-version");
    }
  }
  async originalPreflight() {
    await this.checkBinary();
    if (await this.currentPath() !== "public") throw new Error("official-resources-required");
    for (const [path, expected] of [["app.js", HOST.app], ["worker.js", HOST.worker]]) {
      if (await digest(await this.localResource(path)) !== expected) throw new Error("official-resource-hash-mismatch");
    }
    const manager = this.app.plugins;
    if (typeof manager.disablePluginAndSave !== "function" || typeof manager.enablePluginAndSave !== "function" ||
        typeof manager.saveConfig !== "function") throw new Error("plugin-manager-unavailable");
  }
  async initialize() {
    if (window.Capacitor?.getPlatform?.() !== "android") throw new Error("android-only");
    const path = await this.currentPath();
    if (path === "public") {
      if (this.data.plusRestoreRequired) await this.restorePlus();
      if (["switching", "active", "restoring"].includes(this.data.phase)) {
        this.data.phase = "restored";
        this.data.action = { name: "restore", status: "complete" };
        this.data.recoveryReason = sessionStorage.getItem("native-delimiter-trial-recovery") || "official-process-start";
        sessionStorage.removeItem("native-delimiter-trial-recovery");
        await this.persist();
      }
      if (this.data.phase === "restored" && this.data.action?.name === "restore") {
        this.data.action.status = "complete";
        await this.persist();
      }
      await this.report();
    } else if (safePrivateBase(this.data.base) && path === this.data.absolutePath && window.__nativeLsdTrialBoot) {
      this.busy = true;
      try {
        await this.checkBinary();
        for (const name of ["app.js", "worker.js"]) {
          const item = PLAN.assets.find(item => item.path === name);
          if (await digest(await this.localResource(name)) !== item.sha256) throw new Error("active-resource-hash-mismatch");
        }
        if (this.app.plugins.enabledPlugins.has(PLUS) || this.app.plugins.getPlugin(PLUS)) throw new Error("plus-still-active");
        if (!window.__nativeLsdTrialBoot.finish()) throw new Error("startup-already-reverting");
        this.data.phase = "active";
        this.data.action = { name: "start", status: "complete" };
        this.data.boot = { success: true, exactPatchedResources: true, plusInactive: true, at: new Date().toISOString() };
        delete this.data.error;
        await this.persist();
        await this.report();
        await this.verify();
      } catch (error) {
        await this.recordError(error);
        window.__nativeLsdTrialBoot.restore("startup-check-failed");
      } finally { this.busy = false; }
    } else {
      throw new Error("another-resource-override-is-active");
    }
    await this.inspect();
    this.initialized = true;
    this.startControl();
    void this.readRequest();
  }
  startControl() {
    this.controlDeadline = Date.now() + 10 * 60 * 1000;
    if (this.controlTimer != null) return;
    this.controlTimer = window.setInterval(() => {
      if (Date.now() > this.controlDeadline) {
        window.clearInterval(this.controlTimer);
        this.controlTimer = null;
        return;
      }
      if (this.active && !this.busy && document.visibilityState === "visible") void this.readRequest();
    }, 1500);
  }
  async readRequest() {
    if (this.readingRequest || this.busy || !this.active) return;
    this.readingRequest = true;
    try {
      const path = this.manifest.dir + "/request.json";
      if (!await this.app.vault.adapter.exists(path)) return;
      const request = JSON.parse(await this.app.vault.adapter.read(path));
      if (typeof request.id !== "string" || !/^[a-z0-9-]{1,80}$/.test(request.id) ||
          !ACTIONS.has(request.action) || request.id === this.data.lastRequest) return;
      this.data.lastRequest = request.id;
      await this.persist();
      await this.perform(request.action);
    } catch (error) { await this.recordError(error); }
    finally { this.readingRequest = false; }
  }
  async perform(action) {
    if (!ACTIONS.has(action) || this.busy) return;
    this.startControl();
    this.busy = true;
    this.data.action = { name: action, status: "running" };
    try {
      await this.persist();
      await this.report();
      if (action === "reload-self") {
        if (await this.currentPath() !== "public") throw new Error("restore-before-reloading-helper");
        const manager = this.app.plugins, id = this.manifest.id;
        setTimeout(async () => {
          await manager.disablePlugin(id);
          await manager.enablePlugin(id);
        }, 100);
      } else if (action === "inspect-package") {
        const result = await inspectInstalledPackage(this);
        await this.app.vault.adapter.write(this.manifest.dir + "/package-report.json", JSON.stringify(result, null, 2));
      } else if (action === "prepare-restart") {
        this.showProgress("笔记正在保存。保存完成后将完整重启，以验证回退。");
        await this.saveOpenViews();
        this.holdProgress = true;
        this.data.restartCheckpoint = { saved: true, at: new Date().toISOString() };
      } else await this[action]();
      this.data.action = { name: action, status: "complete" };
      delete this.data.error;
      await this.persist();
      await this.report();
    } catch (error) {
      if (!this.active) return;
      if (action === "start" && this.data.phase === "switching" && await this.currentPath() === "public") {
        await this.restorePlus();
        this.data.phase = "staged";
      }
      this.data.action = { name: action, status: "failed" };
      await this.recordError(error);
    } finally {
      if (!this.holdProgress) {
        this.progress?.close();
        this.progress = null;
      }
      this.busy = false;
    }
  }
  showProgress(message) {
    if (!this.progress) { this.progress = new Progress(this.app); this.progress.open(); }
    this.progress.update(message);
  }
  async prepare() {
    await this.originalPreflight();
    if (this.data.base) await this.removePrivateResources();
    this.data.base = "native-delimiter-trial/" + crypto.randomUUID() + "/public";
    this.data.phase = "staging";
    this.data.stagedFiles = 0;
    this.data.stagedBytes = 0;
    await this.persist();
    const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true });
    for (const item of PLAN.assets) {
      this.showProgress(`正在校验并准备资源 ${this.data.stagedFiles + 1}/${PLAN.assets.length}`);
      let bytes;
      if (item.ownSource != null) bytes = encoder.encode(item.ownSource);
      else {
        bytes = item.localOnly
          ? new Uint8Array(await this.app.vault.adapter.readBinary(this.manifest.dir + "/local-assets/" + item.path))
          : await this.localResource(item.path);
        if (await digest(bytes) !== item.sourceSha256) throw new Error("source-hash-mismatch:" + item.path);
        if (item.insertions) bytes = encoder.encode(applyInsertions(decoder.decode(bytes), item.insertions));
      }
      if (bytes.byteLength !== item.bytes || await digest(bytes) !== item.sha256) throw new Error("patch-result-mismatch");
      await this.native("Filesystem", "writeFile", {
        directory: "DATA", path: this.data.base + "/" + item.path, data: toBase64(bytes), recursive: true,
      });
      if (await digest(await this.privateRead(item.path)) !== item.sha256) throw new Error("write-verification-failed");
      this.data.stagedFiles++;
      this.data.stagedBytes += bytes.byteLength;
      if (this.data.stagedFiles % 25 === 0) { await this.persist(); await this.report(); }
    }
    const result = await this.native("Filesystem", "getUri", { directory: "DATA", path: this.data.base });
    this.data.absolutePath = ownedAbsolutePath(result.uri, this.data.base);
    this.data.phase = "staged";
    await this.persist();
    await this.report();
  }
  async inspect() {
    const path = await this.currentPath();
    const info = await this.native("App", "getInfo");
    const hashes = {};
    for (const name of ["app.js", "worker.js"]) hashes[name] = await digest(await this.localResource(name));
    this.data.runtime = {
      at: new Date().toISOString(), version: info.version, build: info.build,
      source: path === "public" ? "official" : path === this.data.absolutePath ? "trial" : "other",
      hashes,
    };
    await this.persist();
    await this.report();
  }
  async saveOpenViews() {
    const leaves = [];
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view?.file && typeof leaf.view.getViewData === "function") leaves.push(leaf); });
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view.editor?.cm?.composing) throw new Error("finish-input-composition-first");
      if (typeof view.save !== "function") throw new Error("open-view-cannot-be-saved");
      for (let attempt = 0; attempt < 50 && (view.saving || view.saveAgain); attempt++) await pause(100);
      if (view.saving || view.saveAgain) throw new Error("open-view-still-saving");
      const before = view.getViewData();
      await view.save();
      for (let attempt = 0; attempt < 50 && (view.saving || view.saveAgain); attempt++) await pause(100);
      if (view.getViewData() !== before || await this.app.vault.read(view.file) !== before) {
        throw new Error("open-view-not-fully-saved");
      }
    }
    await this.app.workspace.saveLayout();
  }
  async createNotes() {
    if (this.data.notes) return;
    const folder = "Native Delimiter Trial " + crypto.randomUUID().slice(0, 8);
    await this.app.vault.createFolder(folder);
    this.data.noteFolder = folder;
    this.data.notes = {};
    this.data.noteHashes = {};
    for (const [name, filename, text] of [
      ["preview", "原生公式试运行.md", preview + "\n## 嵌入\n\n![[" + folder + "/嵌入目标]]\n"],
      ["editor", "编辑检查.md", editorStandard],
      ["dollar", "美元编辑对照.md", editorDollar],
      ["embed", "嵌入目标.md", embedSource],
    ]) {
      const path = folder + "/" + filename;
      await this.app.vault.create(path, text);
      this.data.notes[name] = path;
      this.data.noteHashes[name] = await digest(new TextEncoder().encode(text));
    }
    await this.persist();
  }
  async start() {
    if (!["staged", "restored"].includes(this.data.phase) || !this.data.base || !this.data.absolutePath ||
        this.data.stagedFiles !== PLAN.assets.length) await this.prepare();
    await this.originalPreflight();
    this.showProgress("再次校验全部资源，并等待当前笔记保存。");
    for (const [index, item] of PLAN.assets.entries()) {
      this.progress.update(`再次校验资源 ${index + 1}/${PLAN.assets.length}，完成后保存笔记并重载。`);
      if (await digest(await this.privateRead(item.path)) !== item.sha256) throw new Error("staged-resource-changed");
    }
    await this.saveOpenViews();
    await this.createNotes();
    this.data.plusRestoreRequired = this.app.plugins.enabledPlugins.has(PLUS);
    this.data.plusEnabledAtStart = this.data.plusRestoreRequired;
    this.data.phase = "switching";
    await this.persist();
    if (this.data.plusRestoreRequired) {
      await this.app.plugins.disablePluginAndSave(PLUS);
      await this.app.plugins.saveConfig();
      if (this.app.plugins.getPlugin(PLUS)) throw new Error("plus-did-not-unload");
    }
    const check = ownedAbsolutePath("file://" + this.data.absolutePath, this.data.base);
    await this.report();
    this.showProgress("资源已校验，正在重载到原生公式试运行。");
    // These native methods can unload the page before their promise resolves.
    void this.native("WebView", "setServerBasePath", { path: check }).catch(async error => {
      if (!this.active) return;
      if (await this.currentPath() === "public") {
        await this.restorePlus();
        this.data.phase = "restored";
      }
      await this.recordError(error);
    });
    await pause(1000);
  }
  async verify() {
    if (this.data.phase !== "active") throw new Error("trial-not-active");
    this.showProgress("正在检查原生解析、阅读渲染、编辑与撤销。");
    this.data.tests = await runChecks(this, PLAN);
    await this.persist();
    await this.report();
    this.progress?.close();
    this.progress = null;
    const file = this.app.vault.getAbstractFileByPath(this.data.notes.preview);
    if (file) await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "source", source: false } });
    new Notice(this.data.tests.passed
      ? "原生公式试运行检查通过。测试笔记已打开；完整重启会恢复官方资源。"
      : "原生公式试运行已启动，但有检查未通过；详情已保存。", 12000);
  }
  async restorePlus() {
    if (!this.data.plusRestoreRequired) return;
    if (!this.app.plugins.enabledPlugins.has(PLUS)) {
      const enabled = await this.app.plugins.enablePluginAndSave(PLUS);
      if (!enabled) throw new Error("could-not-restore-plus");
      await this.app.plugins.saveConfig();
    }
    this.data.plusRestoreRequired = false;
    await this.persist();
  }
  async restore() {
    const path = await this.currentPath();
    if (path === "public") {
      await this.restorePlus();
      this.data.phase = "restored";
      return;
    }
    if (path !== this.data.absolutePath || !safePrivateBase(this.data.base)) throw new Error("foreign-resource-directory");
    this.showProgress("正在保存笔记并恢复官方资源。");
    await this.saveOpenViews();
    this.data.phase = "restoring";
    await this.persist();
    await this.report();
    void this.native("WebView", "setServerAssetPath", { path: "public" }).catch(error => {
      if (this.active) void this.recordError(error);
    });
    await pause(1000);
  }
  async removePrivateResources() {
    if (!this.data.base) return;
    if (!safePrivateBase(this.data.base) || await this.currentPath() !== "public") throw new Error("resource-cleanup-refused");
    try {
      await this.native("Filesystem", "rmdir", { directory: "DATA", path: this.data.base.slice(0, -"/public".length), recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT" && !/does not exist|not exist|not found|ENOENT/.test(error.message)) throw error;
    }
    delete this.data.base;
    delete this.data.absolutePath;
  }
  async cleanup() {
    if (await this.currentPath() !== "public") throw new Error("restore-before-cleanup");
    this.showProgress("正在保存笔记，并清理已退出的试运行资源。");
    await this.saveOpenViews();
    await this.restorePlus();
    await this.removePrivateResources();
    for (const [name, path] of Object.entries(this.data.notes || {})) {
      if (!this.data.noteFolder || !path.startsWith(this.data.noteFolder + "/")) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file && await digest(new TextEncoder().encode(await this.app.vault.read(file))) === this.data.noteHashes[name]) {
        await this.app.vault.delete(file);
      }
    }
    const folder = this.app.vault.getAbstractFileByPath(this.data.noteFolder || "");
    if (folder?.children?.length === 0 && folder.path === this.data.noteFolder) await this.app.vault.delete(folder);
    delete this.data.notes;
    delete this.data.noteHashes;
    delete this.data.noteFolder;
    this.data.stagedFiles = 0;
    this.data.stagedBytes = 0;
    this.data.phase = "cleaned";
    new Notice("试运行资源已清理；改动过的测试笔记会保留。", 8000);
  }
}
module.exports = NativeDelimiterTrial;
