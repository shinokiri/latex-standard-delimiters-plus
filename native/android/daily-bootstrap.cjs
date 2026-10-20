/* Serialized inline into the local HTML entry; independent of app.js and plugins. */
function installDailyGuard(win, expected) {
  if (win.__nativeLsdDailyBoot) return;
  const start = win.performance.now();
  let elapsed = 0, last = Date.now(), timer, button, accepted = false;
  const call = (plugin, method, options = {}) => win.Capacitor.nativePromise(plugin, method, options);
  const state = {
    key: expected.key, phase: "starting", startedAt: start, reason: null,
    finish() {
      if (state.phase === "restoring") return false;
      state.phase = "ready";
      state.readyAt = win.performance.now();
      win.clearInterval(timer);
      button?.remove();
      return true;
    },
    restore(reason) {
      if (state.phase === "restoring") return;
      state.phase = "restoring";
      state.reason = reason;
      win.clearInterval(timer);
      try { win.localStorage.setItem("native-lsd-recovery", JSON.stringify({ key: expected.key, reason, at: Date.now() })); } catch {}
      try {
        Promise.resolve(call("WebView", "setServerAssetPath", { path: "public" }))
          .catch(() => { state.reason = "restore-call-failed"; });
      } catch { state.reason = "bridge-unavailable"; }
    },
  };
  win.__nativeLsdDailyBoot = state;
  try {
    const blocked = JSON.parse(win.localStorage.getItem("native-lsd-recovery") || "null");
    if (blocked?.key === expected.key) { state.restore("previous-startup-failed"); return; }
    state.info = Promise.resolve(call("App", "getInfo")).then(async info => {
      if (info.id !== "md.obsidian" || info.version !== expected.identity.host.version ||
          String(info.build) !== expected.identity.host.build) throw Error("binary-changed");
      const stat = await call("Filesystem", "stat", { path: expected.identity.path });
      if (stat.size !== expected.identity.size || stat.mtime !== expected.identity.mtime) throw Error("package-changed");
      return info;
    });
    state.info.catch(() => state.restore("package-changed"));
    win.fetch("/native-lsd-ready.json", { cache: "no-store" })
      .then(response => response.json()).then(marker => { accepted = marker.key === expected.key && marker.passed === true; })
      .catch(() => {});
  } catch { state.restore("bridge-unavailable"); return; }
  timer = win.setInterval(() => {
    const now = Date.now(), gap = now - last;
    last = now;
    if (win.document.visibilityState !== "visible") return;
    elapsed += gap > 1000 ? 250 : Math.max(0, gap);
    const app = win.app;
    // A verified cache may also start in another vault without this helper.
    // Never change that vault's enabled-plugin list.
    if (accepted && app?.workspace?.layoutReady) {
      if (app.plugins?.getPlugin?.("latex-standard-delimiters-plus")) state.restore("renderer-conflict");
      else state.info.then(() => state.finish()).catch(() => {});
      return;
    }
    if (elapsed >= 10000 && !button && win.document.body && !app?.workspace?.layoutReady) {
      button = win.document.createElement("button");
      button.textContent = "恢复官方 Obsidian";
      button.style.cssText = "position:fixed;bottom:24px;left:16px;z-index:2147483647;padding:12px";
      button.onclick = () => state.restore("recovery-button");
      win.document.body.appendChild(button);
    }
    if (elapsed >= 120000) state.restore("startup-timeout");
  }, 250);
}
module.exports = { installDailyGuard };
