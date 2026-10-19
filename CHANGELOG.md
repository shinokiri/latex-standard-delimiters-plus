# Changelog

The Plus fork starts from upstream 0.4.7. Earlier upstream changes remain in Git history and the [upstream repository](https://github.com/DicksonKam/latex-standard-delimiters).

## 0.4.13

First GitHub release of Plus, incorporating local versions 0.4.8–0.4.12.

- Keep source punctuation visible across IME start/end, fixing opening delimiter backslashes disappearing before any text was entered.
- Preserve CodeMirror's composing text node while typing Markdown-like TeX punctuation.
- Cover idle IME activation, composition, replacement across literal markers and intentional delimiter deletion with DOM regressions.
- Publish source, tests, installable assets, verification reports and checksums; consolidate development and release instructions.

## 0.4.12 — local development

- Navigate from rendered MathJax symbols and editing previews to unambiguous source tokens.
- Remember per-equation caret positions through document edits.
- Highlight the source caret's expression in the preview and retain stable preview containers.
- Retain a marked last-valid preview for temporarily invalid TeX, scoped to the same equation.

## 0.4.11 — local development

- Defer activation and composition-state changes until pending native DOM input is processed.
- Isolate rendered MathJax selection/input events from editable Markdown.
- Reuse unchanged formula widgets after preceding edits and resolve their current positions when activated.
- Add repeated interaction and installed-core regression checks.

## 0.4.10 — local development

- Initialize missing editing previews when entering or switching equations during an already active composition.

## 0.4.9 — local development

- Center standalone displays inside their list, quote or indentation content area.
- Preserve previews through in-equation selections and IME composition.

## 0.4.8 — local development

- Add mobile loading, list-fragment source mapping and touch/mouse event deduplication.
- Use the separate `latex-standard-delimiters-plus` plugin ID.
- Add reading-view regressions while preserving original note text.
