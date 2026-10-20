/* Runs before the host scripts. No persistent resource setting is written. */
function installTrialGuard(win, expected) {
  if (win.__nativeLsdTrialBoot) return;
  let timer;
  const state = {
    version: expected.version,
    build: expected.build,
    phase: "starting",
    reason: null,
    finish() {
      if (state.phase !== "starting") return false;
      state.phase = "ready";
      win.clearTimeout(timer);
      return true;
    },
    restore(reason) {
      if (state.phase === "restoring") return;
      state.phase = "restoring";
      state.reason = reason;
      win.clearTimeout(timer);
      try {
        win.sessionStorage.setItem("native-delimiter-trial-recovery", reason);
      } catch {}
      try {
        const result = win.Capacitor.nativePromise("WebView", "setServerAssetPath", { path: "public" });
        Promise.resolve(result).catch(() => { state.reason = "restore-call-failed"; });
      } catch {
        state.reason = "restore-call-failed";
      }
    },
  };
  win.__nativeLsdTrialBoot = state;
  timer = win.setTimeout(() => state.restore("startup-timeout"), 45000);
  try {
    Promise.resolve(win.Capacitor.nativePromise("App", "getInfo", {})).then(info => {
      if (info.id !== "md.obsidian" || info.version !== expected.version ||
          String(info.build) !== expected.build) state.restore("unexpected-binary");
    }, () => state.restore("binary-check-failed"));
  } catch {
    state.restore("bridge-unavailable");
  }
}

module.exports = { installTrialGuard };
