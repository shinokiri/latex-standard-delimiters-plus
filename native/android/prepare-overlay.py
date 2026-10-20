"""Build an offline resource directory from the user's own matching APK.

Does not call Shizuku, change an APK, install anything, or activate the result.
Host resources and their derivatives must remain local and untracked.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / ".local-fixtures"
KNOWN = {
    "app.js": "7591ddf1df0414b26af79b9ae7fcaffc0f210332686520523fc3a391d675800e",
    "worker.js": "a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae",
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def asset_entries(archive):
    result = []
    names = set()
    for entry in archive.infolist():
        if not entry.filename.startswith("assets/public/") or entry.is_dir():
            continue
        name = entry.filename[len("assets/public/"):]
        path = PurePosixPath(name)
        if (not name or path.is_absolute() or ".." in path.parts or "\\" in name
                or str(path) != name or name in names
                or stat.S_ISLNK(entry.external_attr >> 16)):
            raise ValueError("Unsafe or duplicated asset path")
        if entry.file_size > 16 * 1024 * 1024:
            raise ValueError("Unexpectedly large asset")
        names.add(name)
        result.append((name, entry))
    if sum(entry.file_size for _, entry in result) > 64 * 1024 * 1024:
        raise ValueError("Unexpectedly large asset bundle")
    if not {"index.html", "app.js", "worker.js"} <= names:
        raise ValueError("Required public assets missing")
    return sorted(result)


def prepare(apk, output):
    output = output.resolve()
    fixture_root = FIXTURES.resolve()
    if not output.is_relative_to(fixture_root) or output == fixture_root:
        raise ValueError("Evaluation output must be inside this repository's ignored .local-fixtures/")
    if output.exists():
        raise FileExistsError("Refusing to overwrite an existing output")
    with zipfile.ZipFile(apk) as archive:
        entries = asset_entries(archive)
        for name, expected in KNOWN.items():
            if sha(archive.read("assets/public/" + name)) != expected:
                raise ValueError("Unsupported host checksum: expected evaluated Obsidian 1.14.4 Android")
        config = json.loads(archive.read("assets/capacitor.config.json"))
        if config.get("appId") != "md.obsidian" or config.get("appendUserAgent") != "obsidian/1.14.4":
            raise ValueError("Unexpected Android container configuration")
        output.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=".android-overlay-", dir=output.parent))
        try:
            public = staging / "public"
            public.mkdir()
            original = {}
            for name, entry in entries:
                data = archive.read(entry)
                original[name] = sha(data)
                target = public / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            patch_reports = {}
            for name in KNOWN:
                patched = staging / "patches" / name
                subprocess.run([
                    "node", str(ROOT / "native/patch-core.mjs"), name[:-3],
                    str(public / name), str(patched),
                ], check=True, capture_output=True, text=True)
                patch_reports[name] = json.loads(Path(str(patched) + ".verification.json").read_text())
                os.replace(patched, public / name)
            shutil.rmtree(staging / "patches")
            inventory = []
            changed = []
            for name, _ in entries:
                data = (public / name).read_bytes()
                digest = sha(data)
                if digest != original[name]:
                    changed.append(name)
                inventory.append({"path": name, "bytes": len(data), "sha256": digest})
            if set(changed) != set(KNOWN):
                raise ValueError("Unexpected changed resources")
            summary = {
                "schema": 1,
                "host": {"platform": "Android", "version": "1.14.4", "build": "389"},
                "stage": "offline-resource-directory-only",
                "assetCount": len(entries),
                "originalBytes": sum(entry.file_size for _, entry in entries),
                "stagedBytes": sum(item["bytes"] for item in inventory),
                "changedAssets": changed,
                "unchangedAssets": len(entries) - len(changed),
                "patches": patch_reports,
                "apkChanged": False,
                "activationAttempted": False,
                "fullApplicationBootTested": False,
            }
            (staging / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
            (staging / "verification.json").write_text(json.dumps(summary, indent=2) + "\n")
            # The directory becomes visible under its final name only after all checks.
            if output.exists():
                raise FileExistsError("Output appeared while staging")
            os.rename(staging, output)
            return summary
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--out", type=Path, default=FIXTURES / "android-overlay-1.14.4")
    args = parser.parse_args()
    print(json.dumps(prepare(args.apk, args.out), indent=2))
