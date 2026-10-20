# Official Android installation: resource-directory evaluation

The goal is native recognition of `\(...\)` and `\[...\]` while retaining the
official Obsidian package, signature and update channel. This assessment does
not select a separately signed APK or require root.

## Finding and current evidence

The installed Obsidian **1.14.4 / Android build 389** contains Capacitor's core
`WebView` plugin, including `getServerBasePath`, `setServerBasePath`,
`setServerAssetPath` and `persistServerBasePath`. The installed DEX was inspected,
rather than assuming that current upstream Capacitor code ships in Obsidian.

| Installed implementation | Observation |
| --- | --- |
| `com.getcapacitor.k.m0()` | Registers `com.getcapacitor.plugin.WebView` as a core plugin. |
| `WebView.getServerBasePath` → `k.H()` | Reads the currently served base path. |
| `WebView.setServerBasePath` → `k.C0(String)` | Calls the local server's file-directory host method and posts a WebView reload. |
| `WebView.setServerAssetPath` → `k.B0(String)` | Calls the asset-directory host method and posts a reload. |
| `WebView.persistServerBasePath` | Saves the current path under `CapWebViewSettings/serverBasePath`. Persistence is a separate operation. |
| `k.Q()` | Compares the installed package's version code and version name with saved values; on a change writes an empty `serverBasePath`. |
| `k.W()` | Starts with bundled `public` assets; loads a persisted file path only when deployment is enabled, the binary is unchanged, the path is nonempty, and it exists. |
| `k.N()` and packaged `res/xml/config.xml` | `DisableDeploy` defaults to false; the packaged Cordova configuration has no override. |

`assets/native-bridge.js` also contains forwarding methods for the WebView
plugin. These findings correspond to the upstream
[WebView plugin](https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/plugin/WebView.java),
[Bridge](https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/Bridge.java)
and [local resource server](https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/WebViewLocalServer.java).
Obfuscated names above apply only to this inspected APK.

The device's Shizuku process was checked with `id`: it runs as **UID 2000,
SELinux `u:r:shell:s0`**, not root. The installed package is not debuggable.
Shizuku provides the privileges of its startup process, as described in its
[introduction](https://shizuku.rikka.app/introduction/); it does not make
private application files generally writable or bypass APK signatures.
It can assist with package discovery and controlled recovery operations,
but the resource switch belongs inside the app's existing native bridge.
Shizuku is not expected to be needed continuously for this candidate route.

## How the candidate works

1. Read resources from the user's own matching installed APK.
2. Verify the exact app/worker hashes and expected parser hooks.
3. Copy the web-resource directory locally and apply the existing core grammar
   adapter to `app.js` and `worker.js`. No note is rewritten.
4. An in-app helper could stage the result in an app-owned directory and ask
   the official container to serve it. This step has **not** been performed.
5. The parser, highlighting, widgets, source positions and previews remain
   native. The helper manages deployment rather than rendering formulas.

The APK, package identity and signing certificate are unchanged by a resource
directory switch, so the signing conflict of a replacement APK does not arise.
This does not make the internal interface a supported Obsidian API, nor
guarantee compatibility with future releases.

The offline build contains **324 files**, approximately **24.3 MiB**:
`app.js` and `worker.js` changed, **322 files remained byte-identical**.
The adapter added 8,007 bytes across the two bundles. This is disk size, not a
measurement of peak staging memory, app startup time or rendering latency.
There is no fallback to APK assets for arbitrary missing overlay files in the
inspected local server path, so a complete resource tree is required.

## Runtime probe

`probe.cjs` is a tiny Obsidian plugin. Package it as `main.js` with
`probe-manifest.json` renamed to `manifest.json` in
`.obsidian/plugins/native-delimiter-probe/`. Enabling it runs the probe after
layout readiness. Its command can rerun the probe.

It reads:

- Application ID, version and build through `App.getInfo`.
- Current resource-path category through `WebView.getServerBasePath`.
- The private files-directory URI through `Filesystem.getUri`, without creating
  a directory. The recorded report contains only a path category.
- The advertised native plugin methods.
- SHA-256 checksums of same-origin `app.js` and `worker.js`.

It saves `data.json` only in its own plugin directory. It does not read note
content, send reports over the network, switch resources, persist a path,
reload the interface, or edit the enabled-plugin list. A native-call allowlist
rejects all switching/persistence/file-write methods. Native errors are
redacted because they can contain private paths.

`liveReadChecksPassed: true` establishes only that the **read checks** and
advertised methods match this evaluation. It does not prove that resource
switching, full app startup, touch input or IME behavior works.

The user enabled the probe in the official application. The recorded
[live result](live-probe.json) passed every read check on 2026-10-20:
Android app `md.obsidian`, version 1.14.4 / build 389, bundled assets active,
exact app/worker checksums, private files directory addressable, and both
switch/restore methods advertised. No resource switch was attempted.
The temporary probe can be disabled after collecting its report.

## Trial and recovery design

The first live trial must be **non-persistent**. Do not call
`persistServerBasePath`. Start from verified bundled resources, verify the
binary and complete staged inventory, let current edits finish saving, and
explicitly switch once. A complete process restart then starts from the
official bundle, provided no previous persisted override exists.

Closing a note, hiding the app or merely reloading the page is not a complete
process restart. `setServerAssetPath({path: "public"})` can restore the running
process, but cannot by itself clear a previously persisted file path.

An automatic helper that reapplies a non-persistent overlay on every cold
start needs an attempt marker, a recovery bypass and a strict unknown-version
fallback. It also incurs an additional interface startup/reload. That cost
has not been measured and should not be hidden behind a claim of full parity.

Persistent activation requires more work: a successful startup handshake,
early recovery code, and recovery even when the resource tree is incomplete.
The native loader checks only whether a directory exists, not whether its
`index.html` and all resources are intact. Cache storage is not a substitute
for that recovery design: Android can remove cache files under storage
pressure ([Android documentation](https://developer.android.com/training/data-storage/app-specific#internal-remove-cache)).
No persistent activation command is shipped here.

The native binary-version reset provides useful update behavior: a new
official version clears the old resource path and uses its bundled code.
Our helper must additionally refuse an unknown version or hash; it must not
reapply an old bundle after that reset. Official updates can proceed, while
standard-delimiter support may wait for a validated adapter for the new build.
Future Capacitor/container changes still require review.

The switch affects the app process, not just one vault. A synthetic test vault
protects note content during validation, but is not a separate app sandbox.
Plus and other delimiter renderers must be inactive during the native trial.
Desktop and iOS delivery are not validated by this Android finding.

## Reproduce the offline checks

With the repository's locked development dependencies available:

```sh
node --test native/android/probe.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s native/android -p 'test_*.py' -v
python3 native/android/prepare-overlay.py /path/to/your/Obsidian.apk
```

The builder accepts only evaluated app/worker hashes and Android container
configuration. It rejects unsafe ZIP paths, symlinks, oversized entries,
unknown builds, output outside the ignored `.local-fixtures/` directory,
and existing output. It stages atomically and removes incomplete staging
after errors. It invokes the existing syntax-aware core patcher.

The generated `verification.json` summarizes the result; `inventory.json`
contains all staged file hashes. These resources and their derivatives stay
local and must not be committed or redistributed.

## Alternatives considered

| Route | Assessment for the current requirements |
| --- | --- |
| Ordinary renderer plugin / public Markdown wrappers | Works for narrower coverage, but previously inspected direct internal table/embed/worker calls are not all covered. |
| Shizuku rewriting the installed APK or private app files | Shell privileges do not provide the needed write access or remove signature requirements. |
| Separately signed APK | Rejected delivery: conflicts with the requested official update workflow. |
| Root process hooks | Requires root, which the available Shizuku session does not provide; unnecessary if the existing container interface works. |
| Service-worker interception | Adds script-scope, lifecycle and cache/update coordination issues; no working installation path validated here. |
| Capacitor local resource directory | Leading Android candidate. Installed native code, offline resources and live read-only bridge checks passed; switching/startup validation is still pending. |
| Upstream grammar support / supported parser extension API | Best maintenance outcome; not an immediate change we can make to the official release. |
