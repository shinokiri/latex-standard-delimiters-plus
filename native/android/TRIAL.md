# Native Delimiter Trial

This document describes the historical non-persistent 0.1.x helper.
For automatic daily loading and update adaptation, see [DAILY.md](DAILY.md).

This experimental helper lets the official **Obsidian Android 1.14.4 / build
389** recognize `\(...\)` and `\[...\]` through its native grammars. Formula
highlighting, rendering, widgets, preview and selection handling are then
provided by Obsidian. There is no custom click mapper or preview renderer.

The official APK, package ID, signing certificate and update channel stay in
place. The helper uses an existing internal Capacitor interface to select a
verified local resource directory for the current process. It requires
neither root nor a continuously running Shizuku service.

This is a trial on the research branch, not a replacement for the stable Plus
release. Other Obsidian builds, desktop and iOS are not supported by this
helper. Unknown versions or resource hashes are rejected. A future official
update may require a new adapter before standard delimiters work again.

## Build and install

Supply your own matching installed APK and the repository's locked development
dependencies:

```sh
node native/android/build-trial.mjs /path/to/your/Obsidian.apk
node --test native/android/*.test.mjs
```

The builder needs the locked TypeScript and esbuild packages. It generates:

```text
dist/native-delimiter-trial/
  main.js
  manifest.json
  build-report.json
  local-assets/...
```

Copy `main.js`, `manifest.json` and the complete `local-assets/` subtree to
`<Vault>/.obsidian/plugins/native-delimiter-trial/`. Preserve an existing
`data.json` when updating. Enable **Native Delimiter Trial** in community
plugins. Enabling alone does not activate the native resource trial.

The helper contains our adapter and patch instructions, with exact host
hashes; it does not embed Obsidian's app or worker source. The eight local
auxiliary files are small dependency license notices taken from the supplied
APK. Extracted or patched host resources stay in ignored local directories and
must not be committed or redistributed.

## Use

Run the following commands from Obsidian's command palette. Each appears under
**Native Delimiter Trial**.

| Command | Behavior |
| --- | --- |
| 准备并校验原生公式试运行 | Stage and read back all 325 resources; about 24.3 MiB in the app's private files directory. |
| 启动原生公式试运行（会重载界面） | Prepare if needed, recheck every file, save open edits, remember Plus's enabled state, disable Plus if necessary, then reload once into the native trial. |
| 重新检查原生公式试运行 | Run native comparisons against generated synthetic notes and open the comparison note. |
| 退出试运行并恢复官方资源 | Save open edits and reload the original official resources; restore Plus if it was enabled at trial start. |
| 清理已退出的试运行资源 | After restore, save pending edits, remove the owned private resource directory, and delete only unchanged generated notes. |

The helper refuses a reload while an editor is actively composing IME input
or an open text view cannot be confirmed saved. Finish the edit and retry.
It creates a uniquely named `Native Delimiter Trial …` folder with comparison
and editor test notes; it does not convert existing notes.

Helper **0.1.1** pauses native/resource-read deadlines in the background and
does not start a new native call until the page is visible. Long WebView
suspensions do not become instant timeouts on resume. A genuinely stalled
foreground call still times out and reports its interface name. Calls are
never automatically repeated, because their native side may already have
completed. Successful startup also clears a previous attempt's error.

The core switch affects the **whole application process**, not just the vault
where the helper is installed. Keep other delimiter renderers inactive.
Avoid switching vaults during the trial: this helper must be enabled in the
active vault for its startup handshake and restoration of the prior Plus
state. Dollar formulas continue through the native grammar.

## Restore and recover

Use **退出试运行并恢复官方资源** before disabling or removing the helper.
Turning off the helper alone does not unload app code already in memory.
Plus's enabled state at trial start is preserved: an already disabled Plus
stays disabled on restore.

A **complete app process restart** also returns to official resources. Merely
hiding the app, closing a note or reloading the interface is not sufficient.
If the interface cannot open, stop Obsidian from Android's application settings
and open it again. Do not clear its application data or uninstall it.

The helper never writes `persistServerBasePath` and does not automatically
reactivate on startup. To try native delimiters after a full restart, run the
start command again. If Plus was disabled before the trial, the official
fallback will not acquire standard-delimiter support on its own.

An early 45-second watchdog requests official resources if startup fails.
Complete process restart still works when that script or the bridge cannot
run. This recovery assumes the installation had no pre-existing persistent
resource override; the trial does not modify or reset somebody else's
persistent settings.

## What has been verified

The [live trial](live-trial.json), [explicit restore](live-restore.json) and
[cold restart](live-restart.json) ran in the official signed application.
Startup checks confirmed the expected patched script hashes; the recovery
reports record the original served script hashes afterward. The trial passed:

- 32 worker comparisons, including unchanged dollar-input worker results.
- 10 native reading checks, including tables and an embedded note.
- Matching native math syntax token names, 25 selection moves without source
  changes, and insertion followed by native undo.
- 18 JavaScript guard tests and 3 Python builder tests passed locally. Five
  deadline tests cover background waits, stale timers, a suspended event loop,
  a real foreground timeout and unloading with a call still pending.

These checks do not certify physical tap positioning, Android IME composition,
preview geometry, full table editing, all malformed formulas, or other
platforms. Compare the generated standard/dollar examples manually in Live
Preview and Reading view. The helper adds no custom input behavior to hide
differences.

On 2026-10-20, after installing helper 0.1.1, the user reported no issues in
manual device use. This is a successful user smoke test; individual formulas,
tap positions and IME scenarios were not separately recorded. It does not
change the trial's non-persistent activation or platform/version scope.

The existing [parsing benchmark](../performance.json) measures only parsing.
The 24.3 MiB directory is an on-disk deployment cost, not a measurement of
memory use or rendering overhead. The helper's local request polling pauses
in the background and stops after ten idle minutes; returning to the
foreground or running a command reopens that window.

## Reports and developer control

`trial-report.json` contains test results, lifecycle state and resource hashes.
`data.json` also contains local private paths and generated-note names; do not
publish it. Review any error text before sharing a failed report.

For a local development session, `request.json` in the helper directory
accepts one narrow command:

```json
{"id":"unique-lowercase-id","action":"inspect"}
```

Supported actions are `prepare`, `start`, `verify`, `inspect`, `prepare-restart`,
`restore`, `cleanup`, and `reload-self`. IDs prevent replay. The helper accepts
no arbitrary script or native method. It processes requests while the app is
visible within the control window described above.

`reload-self` updates the helper only while official resources are active.
`prepare-restart` saves open text views, records a save checkpoint and holds
the progress dialog while an external controlled process restart is performed.
These developer actions are not needed for ordinary use.
