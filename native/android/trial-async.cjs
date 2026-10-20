/*
 * Android can suspend the WebView, then deliver overdue JS timers before
 * queued native callbacks. A wall-clock timeout can therefore reject a
 * successful read immediately on return from the lock screen.
 *
 * Count foreground event-loop time, start no new operation while hidden,
 * and never retry an operation whose native side may already have run.
 */
function foregroundOperation(operation, {
  document, signal, timeoutMs = 15000, timeoutMessage = "foreground-operation-timeout",
  clock = globalThis,
}) {
  return new Promise((resolve, reject) => {
    const quantum = 250;
    let remaining = timeoutMs, timer = null, settled = false, started = false;
    let foreground = document.visibilityState === "visible";
    let previous = clock.performance.now();
    let generation = 0;

    function finish(error, value) {
      if (settled) return;
      settled = true;
      stopTimer();
      document.removeEventListener("visibilitychange", changed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(value);
    }
    function stopTimer() {
      generation++;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    }
    function elapsed() {
      const now = clock.performance.now();
      // A large scheduling gap is a suspended/busy event loop, not evidence
      // that a native callback had a fair opportunity to reach JavaScript.
      const delta = Math.max(0, now - previous);
      if (started && foreground) remaining -= delta > quantum * 4 ? quantum : delta;
      previous = now;
    }
    function arm() {
      if (settled || !foreground || timer !== null) return;
      const current = ++generation;
      timer = clock.setTimeout(() => {
        if (settled || current !== generation) return;
        timer = null;
        if (document.visibilityState !== "visible") {
          foreground = false;
          previous = clock.performance.now();
          return;
        }
        elapsed();
        if (remaining <= 0) finish(new Error(timeoutMessage));
        else arm();
      }, Math.min(quantum, Math.max(1, remaining)));
    }
    function begin() {
      if (started || settled || !foreground) return;
      started = true;
      previous = clock.performance.now();
      // Install the completion handlers before scheduling any timeout tick.
      Promise.resolve().then(() => {
        if (settled) return;
        return operation();
      }).then(value => finish(null, value), error => finish(error));
    }
    function changed() {
      if (settled) return;
      elapsed();
      stopTimer();
      foreground = document.visibilityState === "visible";
      previous = clock.performance.now();
      if (foreground) { begin(); arm(); }
    }
    function aborted() { finish(new Error("plugin-unloaded")); }
    document.addEventListener("visibilitychange", changed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    begin();
    arm();
  });
}

module.exports = { foregroundOperation };
