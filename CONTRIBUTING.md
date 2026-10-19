# Contributing

Use Node 22.12+ (CI uses Node 24), `npm ci`, and `npm run check`. Packaging also needs Python 3. Keep Obsidian and CodeMirror imports external to the plugin bundle. Rendering must preserve note text.

Use a disposable vault for app integration checks. For IME changes, verify that pending DOM edits survive, composing text nodes stay intact, delimiter characters remain visible, and repeated source/preview activation does not duplicate content. Synthetic events do not certify real OS keyboards.

Optional private fixtures and extracted app bundles belong in ignored `.local-fixtures/`; do not commit them. Tests must pass without those files, reporting optional checks as skipped or omitted. The source archive must remain usable from a clean checkout.

Report bugs with an invented minimal Markdown example, preserving delimiters, indentation and line breaks, and include plugin/Obsidian versions, mode, device, theme and input method. Use the issue template.

See [RELEASING.md](RELEASING.md) for packaging and publication. Keep runtime files from the same version together. Preserve upstream attribution and avoid replacing published release assets.
