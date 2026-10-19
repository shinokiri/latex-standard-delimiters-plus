"""Install the verified local build; preserve notes, original plugins and settings."""
from pathlib import Path
import argparse
import datetime
import hashlib
import json
import os
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--vault', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
vault = Path(args.vault)
config_dir = vault / '.obsidian'
if not config_dir.is_dir():
    raise SystemExit('Expected an existing Obsidian vault with .obsidian settings.')
manifest = json.loads((root / 'manifest.json').read_text())
verification = json.loads((root / 'dist/verification.json').read_text())
assert verification['id'] == manifest['id'] == 'latex-standard-delimiters-plus'
assert verification['version'] == manifest['version']
assert verification['checks']['npmRunCheck'] == 'passed'
assert verification['checks']['tests']['fail'] == 0
for name, expected in verification['files'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, f'Unverified asset: {name}'
for name, expected in verification['sources'].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, f'Source changed after tests: {name}'
config = config_dir / 'community-plugins.json'
snapshot = config.read_bytes() if config.exists() else None
enabled = json.loads(snapshot) if snapshot is not None else []
assert isinstance(enabled, list) and all(isinstance(item, str) for item in enabled)
replacement = [item for item in enabled if item not in {
    'latex-delimiter-renderer', 'latex-standard-delimiters', manifest['id']}]
replacement.append(manifest['id'])
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
backup = root / 'dist/install-backups' / stamp
backup.mkdir(parents=True)
if snapshot is not None:
    (backup / 'community-plugins.json').write_bytes(snapshot)
target = config_dir / 'plugins' / manifest['id']
assert not target.is_symlink(), 'Plugin destination must not be a symlink'
target.mkdir(parents=True, exist_ok=True)

def atomic_write(path, data):
    assert not path.is_symlink(), f'Refusing to replace symlink: {path}'
    fd, temp = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)

for name in verification['files']:
    destination = target / name
    if destination.exists():
        (backup / name).write_bytes(destination.read_bytes())
    atomic_write(destination, (root / name).read_bytes())
atomic_write(target / 'verification.json', (root / 'dist/verification.json').read_bytes())
if (config.read_bytes() if config.exists() else None) != snapshot:
    raise SystemExit('Plugin files installed, but enabled-plugin settings changed concurrently; leaving settings unchanged.')
atomic_write(config, (json.dumps(replacement, ensure_ascii=False, indent=2) + '\n').encode())
for name, expected in verification['files'].items():
    assert hashlib.sha256((target / name).read_bytes()).hexdigest() == expected
record = {'id': manifest['id'], 'version': manifest['version'], 'vault': str(vault),
          'installedTo': str(target), 'backup': str(backup),
          'previousEnabled': enabled, 'nextEnabled': replacement,
          'requiresRestart': True, 'originalPluginFilesRetained': True}
(backup / 'installation.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
(root / 'dist/installation.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(record, ensure_ascii=False, indent=2))
