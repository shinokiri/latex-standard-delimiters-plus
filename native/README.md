# Native delimiter evaluation

This is a separate research route from LaTeX Standard Delimiters Plus 0.4.13.
The requirement is to recognize `\(...\)` and `\[...\]` while keeping the host's
own math tokens, source highlighting, widgets, selection handling and previews.
It adds no custom math widget, preview panel, click mapping, CSS or input handler.
The note's source is never rewritten.

**This directory is an evaluation, not a stable native delimiter release.**
The Android subdirectory includes **Native Delimiters 0.2.0**, an installable
[daily loader](android/DAILY.md) inside the official signed application.
It extends the historical non-persistent trial with direct cached startup,
APK-local adaptation and externally recoverable persistent activation.
The [daily verification](android/daily-verification.json) and
[startup measurements](android/daily-startup.json) record the new scope.
Full application startup, automatic native rendering/editor checks, explicit
restore and complete process restart have passed on Android 1.14.4 / build 389.
After the 0.1.1 timeout fix, the user reported no issues in manual device use.
The individual touch and IME scenarios were not separately enumerated.
No modified Obsidian binary, extracted host code or private note is distributed.
The stable Plus plugin is unchanged.

## Two evaluated approaches

| Approach | Result |
| --- | --- |
| Ordinary plugin (`src/main.ts`, `reading.ts`, `projection.ts`) | Can reuse the native editor grammar and native reading renderer. Its API-level reading wrappers do not reach direct internal table, embed and metadata parser calls. Source-derived heading labels also need separate care. It does not meet full native parity. |
| Host grammar extension (`src/core-runtime.ts`, `patch-core.mjs`) | Registers delimiter aliases in the central native Markdown grammar and wraps the native HyperMD factory. The central app parser and worker parser receive the same aliases. Existing native consumers continue using their original AST, source positions, renderer and widgets. This is the closer fit to the requested architecture. |

The core path adapts native tokenizer input only while recognizing a boundary,
then commits the resulting native node against the original source. Native
headings retain the original delimiter spelling in their anchors and metadata.
The editor path obtains both delimiter boundaries from real syntax tokens;
there is no assumption that the opener is one character long.

The original offline patcher accepts only the locally evaluated **Obsidian 1.14.4 Android**
`app.js` and `worker.js` checksums. It also checks the expected parser/mode hook
counts, rejects repeat patching, and parses the generated JavaScript. It writes
separate evaluation files; it does not modify an APK or installed application.
The daily loader's separate `android/daily-patch.cjs` discovers hooks from
syntax and gates unknown package activation on native behavior checks.

## Verification and reproduction

Install this repository's development dependencies, then supply your own
matching APK. Host files stay in the root's ignored `.local-fixtures/`.

```sh
python3 native/prepare-fixtures.py /path/to/your/Obsidian-1.14.4-Android.apk
node native/patch-core.mjs worker .local-fixtures/native-worker.js .local-fixtures/patched-worker.js
node native/patch-core.mjs app .local-fixtures/app.js .local-fixtures/patched-app.js
node --import tsx --test --test-concurrency=1 native/tests/*.test.ts
npx tsc -p native/tsconfig.json
node --import tsx native/tests/benchmark.ts
```

The parity corpus covers 32 pairs of standard/dollar Markdown inputs, including
inline/display math, indentation, lists, quotes, callouts, tables, boxed formulas,
headings, footnotes, front matter, escaped examples, code and Unicode.
Tests compare actual installed native token styles and worker output, including
original source offsets and source-derived heading labels. Additional tests
exercise incremental edits, every selection offset in an edited example,
restricted table-cell syntax, long formulas, async wrapper disposal and patch
version guards. Without local host fixtures, host-dependent tests are skipped.

These particular commands run isolated parser/CodeMirror tests and JavaScript
syntax checks. They do **not** establish Android keyboard/touch behavior,
DOM geometry, every embed/table UI interaction, or desktop/iOS compatibility.
The ordinary plugin prototype is deliberately not packaged for installation.
See `verification.json` for the recorded run and `performance.json` for the
strictly scoped parsing benchmark. The later full-application trial has its
own [Android verification report](android/verification.json).

## Delivery assessment

Native recognition should ideally be maintained in Obsidian's own shared
grammars. The current public API offers no registration point that covers all
the native parsing entry points inspected in this evaluation.

The delivery requirement is to retain the official signed installation and
its normal updates. An independently signed Android build is **not** the
selected route: it cannot serve as an ordinary update of the official signed
installation. See
[Android's signing documentation](https://developer.android.com/studio/publish/app-signing).

Further inspection found a different Android delivery candidate: the official
1.14.4 APK includes and registers Capacitor's core `WebView` plugin. Its
`setServerBasePath` can load a local web-resource directory without changing
the APK. The installed native bridge also contains the binary-version check
that clears a persisted directory after an application update. This is an
internal container interface, not a documented Obsidian plugin extension point.

See [the Android assessment](android/README.md) for the installed-APK evidence
and [the trial guide](android/TRIAL.md) for building, using and reverting the
helper. The parser adapter changes only `app.js` and `worker.js`. Trial delivery
also inserts an early recovery script in `index.html`; 321 original resources
remain byte-identical.

The official application successfully loaded the patched resources. The
[live trial](android/live-trial.json) passed 32 worker comparisons, 10 native
reading checks including a table and embedded note, and real editor token,
selection and undo checks. Both the [restore command](android/live-restore.json)
and [complete process restart](android/live-restart.json) returned the actual
served scripts to their original hashes.

The helper never calls `persistServerBasePath` or automatically reapplies the
trial on startup. Plus is temporarily disabled only if enabled at the start,
and that recorded state is restored on return to the official resources.
Other delimiter renderers must also be inactive. The core switch affects the
whole app process. Desktop/iOS delivery and physical Android touch/IME behavior
are not certified by these automatic checks.

Obsidian's [current terms](https://obsidian.md/terms) restrict modification and
redistribution of the application. This repository publishes only our adapter,
tools and measurements; users supply their own matching installed resources.
An upstream grammar change or supported extension point remains preferable
for long-term maintenance.
