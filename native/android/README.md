# Official Android installation: native delimiter trial

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

**Live validation passed on the official application.** The
[trial report](live-trial.json) records a successful startup with exact patched
resources and successful automatic native parser, renderer and editor checks.
The [explicit restore](live-restore.json) and
[complete process restart](live-restart.json) reports both record the original
bundle hashes afterward. See [TRIAL.md](TRIAL.md) for installation and recovery.
The helper's resource switch itself does not use Shizuku.

## How the trial works

1. Read resources from the user's own matching installed APK.
2. Verify the exact app/worker hashes and expected parser hooks.
3. Copy the web-resource directory locally and apply the existing core grammar
   adapter to `app.js` and `worker.js`. No note is rewritten.
4. The in-app helper stages the result in an app-owned files directory,
   reads back and verifies every file, saves pending edits, and asks the
   official container to serve it for the current process.
5. The parser, highlighting, widgets, source positions and previews remain
   native. The helper manages deployment rather than rendering formulas.

The APK, package identity and signing certificate are unchanged by a resource
directory switch, so the signing conflict of a replacement APK does not arise.
This does not make the internal interface a supported Obsidian API, nor
guarantee compatibility with future releases.

The parser-only offline build contains **324 files**. The runnable trial
contains **325 files / 25,464,521 bytes**, approximately **24.3 MiB**:
`app.js`, `worker.js` and the HTML entry change, an early recovery script is
added, and **321 original files remain byte-identical**.
The grammar adapter adds 8,007 bytes across the two JS bundles. This is disk size, not a
measurement of peak staging memory, app startup time or rendering latency.
There is no fallback to APK assets for arbitrary missing overlay files in the
inspected local server path, so a complete resource tree is required.

The distributable helper contains our code, insertion offsets and expected
hashes, not copies of Obsidian's scripts. Most files are read from the running
official app. Eight small PDF.js dependency license files (20,403 bytes) are
copied locally by the builder: the container's HTML5 fallback serves the HTML
entry for those extensionless URLs. They remain hash-checked, rather than
being silently skipped. These local build assets are not committed.

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
switch/restore methods advertised. That probe did not switch resources;
the separate trial helper subsequently performed the live validation above.
The temporary probe can be disabled after collecting its report.

## Trial and recovery design

The supplied trial is **non-persistent**. Its native-call allowlist rejects
`persistServerBasePath`. It starts from verified bundled resources, checks
the binary and complete staged inventory, saves pending edits, and explicitly
switches once. A complete process restart starts from the official bundle;
this was verified on the test installation, which had no previous persistent
override. No automatic activation on cold startup is included.

The bootstrap checks the binary and starts a 45-second startup watchdog
before the host scripts. A successful helper handshake cancels it. Unknown
binaries or startup timeout request a return to bundled assets. These failure
branches have unit tests; a deliberately hung startup was not induced on the
device. Complete process restart remains the recovery path if the bootstrap
or bridge cannot run.

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

The actual trial uses generated synthetic notes in the existing vault. It
does not convert user formulas or rewrite their delimiters. It uses the host's
save operation before reload and verifies that open text views match disk.
Cleanup also saves first and deletes generated notes only if their content is
unchanged. A modified test note or added file is preserved.

Use the restore command **before disabling or removing the helper**. Disabling
a plugin cannot unload the app code already running. If the helper is disabled
while the trial is active, a complete process restart restores official code;
re-enable the helper afterward if it still needs to restore the recorded Plus
state.

## Verification and reproduction

With the repository's locked development dependencies available:

```sh
node --test native/android/*.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s native/android -p 'test_*.py' -v
python3 native/android/prepare-overlay.py /path/to/your/Obsidian.apk
node native/android/build-trial.mjs /path/to/your/Obsidian.apk
```

The builder accepts only evaluated app/worker hashes and Android container
configuration. It rejects unsafe ZIP paths, symlinks, oversized entries,
unknown builds, output outside the ignored `.local-fixtures/` directory,
and existing output. It stages atomically and removes incomplete staging
after errors. It invokes the existing syntax-aware core patcher.

The generated `verification.json` summarizes the result; `inventory.json`
contains all staged file hashes. These resources and their derivatives stay
local and must not be committed or redistributed.

The live automatic checks passed:

- 32 pairs through the actual native worker: standard/dollar rendered HTML
  matches, and complete dollar-input worker output remains unchanged.
- 10 native reading checks, including lists, quotes, callouts, boxed formulas,
  tables, display math inside a table and an actual embedded note.
- Actual Live Preview syntax token names match the dollar reference;
  25 selection changes preserve source; insert followed by native undo
  restores the original generated test note.
- Explicit restore and complete Android process restart both return to the
  original app/worker hashes.
- 18 JavaScript tests (4 probe, 9 trial, 5 foreground-deadline tests) and
  3 Python resource-builder guard tests pass.
  Conditional restoration of an originally enabled Plus is
  unit-tested; Plus was already disabled at the recorded live trial start.

Physical taps, IME composition, rendered geometry, table editing and every
malformed input are not covered by these checks. The helper opens a generated
comparison note for manual verification. The parsing benchmark in
[`../performance.json`](../performance.json) is not a UI latency measurement.

## Alternatives considered

| Route | Assessment for the current requirements |
| --- | --- |
| Ordinary renderer plugin / public Markdown wrappers | Works for narrower coverage, but previously inspected direct internal table/embed/worker calls are not all covered. |
| Shizuku rewriting the installed APK or private app files | Shell privileges do not provide the needed write access or remove signature requirements. |
| Separately signed APK | Rejected delivery: conflicts with the requested official update workflow. |
| Root process hooks | Requires root, which the available Shizuku session does not provide; unnecessary if the existing container interface works. |
| Service-worker interception | Adds script-scope, lifecycle and cache/update coordination issues; no working installation path validated here. |
| Capacitor local resource directory | Implemented as the non-persistent trial. Actual startup, native checks, restore and complete process restart passed on Android 1.14.4 / build 389. |
| Upstream grammar support / supported parser extension API | Best maintenance outcome; not an immediate change we can make to the official release. |
