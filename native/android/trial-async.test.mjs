import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { foregroundOperation } = createRequire(import.meta.url)("./trial-async.cjs");

function environment(visibility = "visible") {
  const listeners = new Set(), timers = new Map();
  let now = 0, next = 0;
  const document = {
    visibilityState: visibility,
    addEventListener: (_, callback) => listeners.add(callback),
    removeEventListener: (_, callback) => listeners.delete(callback),
  };
  const clock = {
    performance: { now: () => now },
    setTimeout(callback, delay) {
      const id = ++next;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
  };
  function advance(milliseconds) {
    const target = now + milliseconds;
    for (;;) {
      const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!due || due[1].at > target) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = target;
  }
  return {
    document, clock, timers, listeners, advance,
    freeze(milliseconds) {
      now += milliseconds;
      const queued = [...timers].filter(([, value]) => value.at <= now);
      for (const [id, value] of queued) { timers.delete(id); value.callback(); }
    },
    visible(value) {
      document.visibilityState = value ? "visible" : "hidden";
      for (const callback of [...listeners]) callback();
    },
  };
}

test("a hidden page starts no native call and acquires its deadline on foreground", async () => {
  const env = environment("hidden");
  let calls = 0;
  const result = foregroundOperation(() => { calls++; return "read"; }, env);
  env.advance(120000);
  assert.equal(calls, 0);
  assert.equal(env.timers.size, 0);
  env.visible(true);
  assert.equal(await result, "read");
  assert.equal(calls, 1);
  assert.equal(env.listeners.size, 0);
});

test("background time and stale timer callbacks do not reject a pending native result", async () => {
  const env = environment();
  let done, calls = 0;
  const result = foregroundOperation(() => {
    calls++;
    return new Promise(resolve => { done = resolve; });
  }, env);
  await Promise.resolve();
  env.advance(1000);
  const stale = [...env.timers.values()][0].callback;
  env.visible(false);
  env.advance(120000);
  env.visible(true);
  stale();
  done("completed before callback delivery");
  assert.equal(await result, "completed before callback delivery");
  assert.equal(calls, 1);
  assert.equal(env.timers.size, 0);
});

test("an overdue timeout after an event-loop freeze lets queued completion arrive", async () => {
  const env = environment();
  let done;
  const result = foregroundOperation(() => new Promise(resolve => { done = resolve; }), env);
  await Promise.resolve();
  env.freeze(15 * 60 * 1000);
  done("queued native callback");
  assert.equal(await result, "queued native callback");
  assert.equal(env.timers.size, 0);
});

test("a genuinely stalled foreground call times out with its method and is never retried", async () => {
  const env = environment();
  let calls = 0;
  const result = foregroundOperation(() => { calls++; return new Promise(() => {}); }, {
    ...env, timeoutMessage: "native-call-timeout:Filesystem.readFile",
  });
  const checked = assert.rejects(result, /native-call-timeout:Filesystem\.readFile/);
  await Promise.resolve();
  env.advance(15000);
  await checked;
  assert.equal(calls, 1);
  assert.equal(env.listeners.size, 0);
  assert.equal(env.timers.size, 0);
});

test("unload cancels foreground waits and ignores late completion without another call", async () => {
  for (const hidden of [true, false]) {
    const env = environment(hidden ? "hidden" : "visible");
    const controller = new AbortController();
    let calls = 0, done;
    const result = foregroundOperation(() => {
      calls++;
      return new Promise(resolve => { done = resolve; });
    }, { ...env, signal: controller.signal });
    const checked = assert.rejects(result, /plugin-unloaded/);
    await Promise.resolve();
    controller.abort();
    await checked;
    done?.("too late");
    env.visible(true);
    env.advance(30000);
    assert.equal(calls, hidden ? 0 : 1);
    assert.equal(env.listeners.size, 0);
    assert.equal(env.timers.size, 0);
  }
});
