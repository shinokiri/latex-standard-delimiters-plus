# Releasing Plus

1. Update `manifest.json`, `package.json`, the root package entry in `package-lock.json`, `versions.json`, README and CHANGELOG. The tag must exactly match `manifest.version`, without a `v` prefix.
2. Run `npm ci`, then `npm run package:release`. Packaging runs the complete checks. Review `dist/verification.json`; optional private fixtures and host bundles are not included in releases.
3. Commit the final source, push `main`, and wait for GitHub Actions to pass. Do not change source after packaging; rebuild if needed.
4. Create and push the version tag. Stage a draft GitHub release containing `main.js`, `manifest.json`, `styles.css`, `LICENSE`, `NOTICE.md`, the installation ZIP, source ZIP, `verification.json` and `SHA256SUMS.txt` from the same build. Describe behavior and verification limits in the release notes.
5. Download the staged assets and verify all checksums and the tag's commit before publishing the draft. Preserve published tags/assets; use a new version for corrections.

Example, after setting `release_version` to the manifest version and writing the reviewed notes to a local file:

```sh
node scripts/check-versions.mjs "$release_version"
git tag -a "$release_version" -m "Release $release_version"
git push origin "$release_version"
gh release create "$release_version" --repo shinokiri/latex-standard-delimiters-plus \
  --verify-tag --draft --title "LaTeX Standard Delimiters Plus $release_version" \
  --notes-file /path/to/release-notes.md \
  main.js manifest.json styles.css LICENSE NOTICE.md \
  "dist/latex-standard-delimiters-plus-$release_version.zip" \
  "dist/latex-standard-delimiters-plus-$release_version-source.zip" \
  dist/verification.json dist/SHA256SUMS.txt
```

This workflow publishes to GitHub, not Obsidian's community directory. Real-device verification is separate from CI. Keep local vault paths, private notes, app extracts and install backups out of the release.
