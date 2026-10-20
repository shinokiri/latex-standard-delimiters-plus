# LaTeX Standard Delimiters Plus

Render `\(...\)` and `\[...\]` in Obsidian Reading view and Live Preview while preserving the original Markdown, whitespace and delimiters.

This is a fork of [DicksonKam/latex-standard-delimiters](https://github.com/DicksonKam/latex-standard-delimiters), starting from [0.4.7 / 758615a](https://github.com/DicksonKam/latex-standard-delimiters/commit/758615a5d3e10f0e642345d1a22dcc2c60d2f3e1). That project derives from [Andreas Burger's LaTeX Delimiter Renderer](https://github.com/BurgerAndreas/latex-delimiter-renderer). The upstream history, MIT license and attribution are retained.

**Current release: 0.4.13 · Obsidian 1.13.7+ · Plugin ID: `latex-standard-delimiters-plus`**

On the `research/native-delimiters-1.14.4` branch, the separate
[Native Delimiters daily loader](native/android/DAILY.md) adds grammar aliases
inside the official Android app. Version 0.2.0 supports direct cached startup,
local update adaptation and official-resource recovery. It remains an
experimental Android delivery; the stable Plus release below is unchanged.

## Features

- Render inline and display formulas, including multiline displays in lists and blockquotes. Center standalone displays in their available content area.
- Use Obsidian's MathJax; native dollar math continues to use Obsidian's own renderer. Code spans and fenced examples remain literal.
- Show an additional editing preview for **both inline and display math**, with source highlighting and brace matching.
- Click a rendered symbol or the editing preview to move to its corresponding TeX token when that mapping is unambiguous. Repeated symbols, fractions, scripts and limits are mapped within their source scopes.
- Remember each equation's previous caret for blank or unmapped clicks. This memory follows edits and stays within the editor session.
- Keep the editing preview stable through selections and IME composition. Retain the last valid preview for temporarily invalid TeX, with a dashed border; it becomes current again when the expression is valid.
- Keep delimiter backslashes visible when an IME starts, while allowing CodeMirror to retain the actual composing text node.
- Support Android, iOS and desktop loading without Node or Electron runtime dependencies. Scrolls, long presses and multi-touch do not activate a formula.

Normal rendering does not change note text. An optional repair command displays a proposed change and requires Apply before editing through Obsidian's undoable editor API.

## Install or update

1. Download `main.js`, `manifest.json` and `styles.css` from the same [GitHub release](https://github.com/shinokiri/latex-standard-delimiters-plus/releases/latest), or download and extract its installation ZIP.
2. Place those files in `<Vault>/.obsidian/plugins/latex-standard-delimiters-plus/`. The ZIP contains that plugin directory.
3. Disable **LaTeX Delimiter Renderer** and **LaTeX Standard Delimiters** if installed, then enable **LaTeX Standard Delimiters Plus**. Restart Obsidian or reload the plugin after updating.

The same installation files work on mobile and desktop. The plugin is not listed in Obsidian's community directory. Preserve any existing `data.json` when updating. To roll back, install the three matching files from an earlier Plus release.

Developers can also run `python3 scripts/install-local.py --vault /path/to/vault` after packaging. This verifies build hashes, backs up existing plugin assets and the enabled-plugin list in `dist/install-backups/`, and selects Plus for the next restart. It does not restart Obsidian.

## Editing behavior and limits

A mapped click places one caret before or after the corresponding source token. TeX commands are kept atomic. Clicking blank space or an ambiguous expression restores that equation's last caret; first entry starts at its first source token. The same fallback works when the host does not provide MathJax source annotations. Custom macro expansions are not assumed to correspond to individual source characters.

The preview highlights the expression corresponding to the source caret and can be clicked without closing it. A newer source selection takes priority over a pending preview click. During composition, the preview retains the last committed result. If the outer delimiter pair is removed, the text stops being recognized as a complete equation.

Source mode and Vim normal mode retain source text. The plugin pauses when either upstream delimiter renderer is enabled. Reading view, Live Preview and Source mode have distinct behavior; the additional editing preview is available in Live Preview.

See [Examples.md](Examples.md) for a small note to try, and [CHANGELOG.md](CHANGELOG.md) for the fork's changes.

## Development

Use Node **22.12+** or a newer supported LTS, npm, and Python 3 for packaging:

```sh
npm ci
npm run check
npm run package:release
```

`npm run check` checks version consistency, lint, tests, types and the production build. Packaging runs these checks and creates installation/source ZIPs, a test/build report and SHA-256 checksums in `dist/`. The source ZIP includes development instructions, tests and CI configuration. See [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md).

GitHub Actions runs the checks on `main`, pull requests and manual dispatch. Upstream debug reports and ad hoc app scripts remain accessible in Git history; they are not current verification for this fork.

## Verification scope

The automated suite uses real CodeMirror state/view objects, markdown-it and jsdom. It checks parsing, exact TeX forwarding, DOM restoration, source navigation, touch activation, pending browser input, IME text-node retention and delimiter visibility. A small formatting fixture models Obsidian's escape hiding; it is not the full host Markdown parser. Geometry tests supply explicit sizes because jsdom does not perform browser layout.

The 0.4.13 development run passed **110 tests**, including fourteen additional runs against an isolated core from the locally installed Obsidian 1.14.4 and checks with its MathJax 4.1.3. The sanitized [development report](docs/development-verification-0.4.13.json) records that scope. Those host bundles and the private note fixture are not distributed. In a clean checkout, their optional tests are skipped or omitted; each release's `verification.json` records the actual results of its build.

The bundled MathJax HTML fixtures use original synthetic expressions. Optional local fixtures belong only in ignored `.local-fixtures/`: `native-codemirror.js`, `obsidian-mathjax.js` and `probability-list.md`. Do not commit or redistribute private notes or extracted application code.

These tests do not certify every OS keyboard or real-device layout. Android smoke testing informed the fixes; iOS and desktop keyboard behavior still needs platform-specific use. Report problems with a minimal invented Markdown example, plugin/Obsidian versions, mode, device and input method.

## License

[MIT](LICENSE). See [NOTICE.md](NOTICE.md) for the original projects and the fork's attribution.
