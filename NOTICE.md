LaTeX Standard Delimiters Plus is a fork of LaTeX Standard Delimiters
by DicksonKam, based on commit 758615a (version 0.4.7):
https://github.com/DicksonKam/latex-standard-delimiters

That project is based on LaTeX Delimiter Renderer by Andreas Burger:
https://github.com/BurgerAndreas/latex-delimiter-renderer

The original MIT license is retained in LICENSE. Version 0.4.8 adds mobile
loading, list-fragment mapping, touch/mouse event deduplication, separate plugin
identity, and regression tests. Version 0.4.9 adds container display centering
and preserves editing previews through in-equation selections and IME composition.
Version 0.4.10 initializes missing previews when entering or switching equations
during an already active composition.
Version 0.4.11 defers composition and click-driven changes until pending native
input is processed, isolates rendered widget events, reuses widgets after position
changes, and adds actual DOM-input and installed-core regression checks.
Version 0.4.12 adds scoped MathJax-to-source navigation, per-equation caret
bookmarks, clickable/highlighted editing previews, stable preview DOM updates,
and fallback for temporarily invalid TeX. Synthetic MathJax output fixtures use
original test expressions; the locally extracted host runtimes are not shipped.
Version 0.4.13 preserves source marker visibility across IME lifecycle changes,
retains CodeMirror's protection of composing text, and adds regressions for
Markdown escape hiding, punctuation composition, replacement and deletion.
Historical upstream device-verification reports
do not certify this fork. Local validation scope is recorded in README.md and
the generated verification.json shipped with each release package.
