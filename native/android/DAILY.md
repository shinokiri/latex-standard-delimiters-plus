# Native Delimiters — Android daily loader

This loader gives the official Android application native recognition of
`\(...\)` and `\[...\]`. It uses the same grammar adapter as the successful
0.1.1 trial. Highlighting, rendering, editing and formula previews remain
Obsidian's implementations. Notes keep their original delimiters.

The official APK, signature and update channel stay installed. The helper
reads that app's own installed package locally; ordinary use needs neither
Shizuku nor a network service. This is an internal-container integration,
not a supported Obsidian extension API. Android 1.14.4 / build 389 is the
device-validated host; future parser or container changes can still require
a helper update. This delivery does not implement desktop or iOS activation;
it stays inactive there without changing Android deployment state.

## Startup and updates

The first activation reads the installed APK, finds the parser and editor
hooks structurally, and tests the proposed native worker before switching.
It writes and reads back a complete local resource tree. After switching,
native reading, tables, an embedded note, editor syntax, selection changes
and undo must also pass before the startup path is persisted.

Subsequent process starts load that verified tree directly. They do **not**
load the official interface first, perform another interface reload, unzip
the APK, parse the application source, hash all resources, or run the full
compatibility suite. The early guard checks the binary identity and APK
file metadata; the helper checks its current resource path and startup
state. Returning to an already running app does not rebuild anything.
Local development request polling is disabled after setup and is opt-in
for new installations.

On the test phone, two cold process starts with official resources reached
page initialization plus helper checks at **1,455 / 1,282 ms** after WebView
navigation start; the persisted native cache reached the same measurement
point at **1,381 / 1,209 ms**. These are not icon-tap-to-fully-rendered-page
times. The sample is small and does not establish a speed improvement, but
does not show a substantial added startup cost. Initial preparation took
8,968 ms and the one-time post-switch native suite took 2,405 ms.
See the [raw measurements](daily-startup.json) for both layout-ready and
check-completion timestamps and measurement limitations.

An official version-code or version-name change makes the currently
inspected Android container reset the persisted path itself. In official
mode, the helper discovers the new installed package and builds from that
package's resources. It never applies a previous app bundle to the updated
container. Structural matching tolerates renamed minifier variables and
changed byte offsets. Native behavior must pass again before persistence.
An APK path, size or modification-time change also invalidates the cached
package identity, including a reinstall with the same displayed version.

A failed or interrupted attempt is blocked for that package/adapter
combination. Official resources remain available. A different package or
adapter can be tried automatically; a manual rebuild retries the current
combination. This improves update handling, but cannot promise automatic
compatibility with every future Obsidian release.

## Install and use

With the locked development dependencies installed:

```sh
node native/android/build-daily.mjs
node --test native/android/*.test.mjs
node native/android/package-daily.mjs
```

The distributable `dist/native-delimiter-daily/main.js` and `manifest.json`
contain the helper and our adapter, not Obsidian's source or an APK.
Building this helper does not require an APK. Copy both files to:

```text
<Vault>/.obsidian/plugins/native-delimiter-trial/
```

The retained plugin ID allows upgrades from the trial. Preserve `data.json`.
Enable **Native Delimiters**, then use its command **启用原生公式自动加载**.
Existing trial resources are cleaned during migration; edited test notes
are retained. Tests create temporary synthetic notes and remove only
unchanged generated content. Normal startup does not open a test note or
move the user's current tab.

| Command | Effect |
| --- | --- |
| 启用原生公式自动加载 | Adapt if needed, save open edits, activate, validate, and persist only a healthy cache. |
| 停止自动加载并恢复官方资源 | Save edits, restore bundled resources and clear persistent cache activation. |
| 重新适配当前 Obsidian | Explicitly retry adaptation for the installed package. |
| 检查原生公式兼容性 | Run the full native comparisons on demand. |
| 查看原生公式状态 | Record current served bundle hashes and show activation status. |
| 清理已停用的原生公式缓存 | After stopping automatic loading, delete only the owned inactive cache and unchanged generated test notes. |
| 开启本地调试控制（10 分钟） | Temporarily accept the limited local developer commands below. |

Active IME composition or an unconfirmed save prevents a switch or
controlled restart. Finish that input and retry. The helper remembers
whether Plus was enabled before activation and restores that state on
return to official resources.

The resource selection belongs to the **whole application process**.
Install/enable the helper in each vault where automatic update adaptation
is needed. A previously verified cache can boot in a vault without the
helper, but that vault cannot rebuild it after an update. The guard returns
to official resources if the older Plus renderer is active there; it does
not change another vault's plugin configuration. Use the restore command
before disabling or uninstalling the helper.

## Recovery

The cache is outside vaults, in the hidden shared-storage directory:

```text
/storage/emulated/<Android user ID>/.obsidian-native-delimiters/<UUID>/public
```

It is local generated application data, not something to publish or sync
with this repository. The 1.14.4 resource tree uses about 24.3 MiB.
While replacing an existing cache, both copies may briefly exist; the old
copy is removed after the new one passes its startup checks.

An inline guard runs before the main app script. If startup stalls, it
offers **恢复官方 Obsidian** after 10 seconds of foreground progress and
requests recovery after 120 seconds. Background suspension and large
event-loop gaps do not count as elapsed foreground time. A failed-start
marker prevents repeated attempts with the same cached build.

If the interface or the HTML entry cannot run:

1. Stop Obsidian from Android's application settings.
2. Show hidden files in a file manager and rename
   `.obsidian-native-delimiters` to `.obsidian-native-delimiters-disabled`.
3. Open Obsidian. The inspected native container ignores a persisted
   directory that no longer exists and starts its official assets.
4. The helper pauses automatic loading when its previously valid cache was
   removed. It does not immediately recreate the directory.

This external recovery path does not need root, Shizuku, application-data
clearing or reinstallation. Renaming the cache does not touch notes.
Delete the renamed generated cache after recovery, or move it back before
explicitly enabling automatic loading again.

## Reports and development

`daily-report.json` records sanitized startup state, timings and compatibility
results. `daily-plan.json` records hashes and our insertion instructions.
`data.json` contains local paths and must not be published. Keep this helper's
`data.json` and `daily-plan.json` local to the Android installation rather
than synchronizing its deployment state across devices. Review errors
before sharing any failed report because a native error may include a path.

During the explicit ten-minute debug window, `request.json` accepts:

```json
{"id":"unique-lowercase-id","action":"inspect"}
```

Allowed actions are `enable-auto`, `disable-auto`, `rebuild`, `verify`,
`inspect`, `prepare-restart`, `restore`, `cleanup`, `reload-self`,
`debug-control`, and `finish-setup`. IDs prevent replay. There is no
arbitrary JavaScript/native-method execution endpoint. `finish-setup`
closes the debug polling window. `prepare-restart` saves open views and
holds a modal until an external controlled restart. `reload-self` is
accepted only with official resources active.

The guard tests cover new installations, absent recovery state, changed
packages, unsupported/ambiguous source, failed-start suppression, incomplete
staging, persistence only after native validation, background suspension,
and the cached path that omits full checks. The patcher is tested with
renamed bindings and changed formatting; these fixtures are compatibility
simulations, not evidence of testing an unreleased official version.

The [verification record](daily-verification.json) records 37 passing
JavaScript tests, local APK extraction, 32 native worker pairs before
activation, 32 live worker comparisons, 10 reading checks, native editor
token parity, 25 selection moves and native undo. Two complete cold starts
confirmed persistent activation without re-running those suites.
The [external recovery report](live-daily-recovery.json) confirms exact
official app/worker hashes after moving the owned cache aside; automatic
loading remained paused until explicitly re-enabled.
