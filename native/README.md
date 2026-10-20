# Native delimiter evaluation

This is a separate research route from LaTeX Standard Delimiters Plus 0.4.13.
The requirement is to recognize `\(...\)` and `\[...\]` while keeping the host's
own math tokens, source highlighting, widgets, selection handling and previews.
It adds no custom math widget, preview panel, click mapping, CSS or input handler.
The note's source is never rewritten.

**This directory is an evaluation, not an installable release.** No modified
Obsidian binary, extracted host code or private note is distributed. The stable
plugin is unchanged.

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

The patcher accepts only the locally evaluated **Obsidian 1.14.4 Android**
`app.js` and `worker.js` checksums. It also checks the expected parser/mode hook
counts, rejects repeat patching, and parses the generated JavaScript. It writes
separate evaluation files; it does not modify an APK or installed application.

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

These are isolated parser/CodeMirror tests and JavaScript syntax checks. They
do **not** establish full application startup, Android keyboard/touch behavior,
DOM geometry, every embed/table UI interaction, or desktop/iOS compatibility.
The ordinary plugin prototype is deliberately not packaged for installation.
See `verification.json` for the recorded run and `performance.json` for the
strictly scoped parsing benchmark.

## Delivery assessment

Native recognition should ideally be maintained in Obsidian's own shared
grammars. The current public API offers no registration point that covers all
the native parsing entry points inspected in this evaluation.

An independently signed Android build cannot serve as an ordinary update of
the official signed installation. It needs a separate application identity or
replacement installation and a maintained update process. See
[Android's signing documentation](https://developer.android.com/studio/publish/app-signing).
Obsidian's [current terms](https://obsidian.md/terms) also restrict modification
and redistribution of the application; an upstream change or an agreed extension
point avoids making a redistributed modified app the project deliverable.

The next validation gate for a host change is an independently installed test
build using synthetic notes, then real device testing of editing, IME, undo,
tables, embeds and mode switching. Its test vault must keep Plus and other
delimiter renderers disabled so they do not override the native path.
Evaluation of that route does not authorize
uninstalling the user's official application or migrating their vaults.
