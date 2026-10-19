"""Build release assets and record the actual automated verification scope."""
from pathlib import Path
import datetime
import hashlib
import json
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
dist = root / 'dist'
dist.mkdir(exist_ok=True)
result = subprocess.run(['npm', 'run', 'check'], cwd=root, text=True,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
(dist / 'verification.log').write_text(result.stdout)
print(result.stdout, end='')
if result.returncode:
    raise SystemExit(result.returncode)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

manifest = json.loads((root / 'manifest.json').read_text())
plugin_id = manifest['id']
assert plugin_id == 'latex-standard-delimiters-plus'
assert manifest['isDesktopOnly'] is False
assets = ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE', 'NOTICE.md']
imports = set(re.findall(r'require\("([^"]+)"\)', (root / 'main.js').read_text()))
assert imports <= {'obsidian', '@codemirror/state', '@codemirror/view', '@codemirror/language'}, imports
source_paths = sorted({p for folder in ['src', 'tests', 'scripts', '.github', 'docs']
                       for p in (root / folder).rglob('*') if p.is_file()})
source_paths += [root / name for name in ['manifest.json', 'package.json', 'package-lock.json',
    'versions.json', 'tsconfig.json', 'eslint.config.mts', 'esbuild.config.mjs',
    '.gitignore', 'README.md', 'LICENSE', 'NOTICE.md', 'CHANGELOG.md', 'CONTRIBUTING.md',
    'RELEASING.md', 'Examples.md']]
plain_log = re.sub(r'\x1b\[[0-9;]*m', '', result.stdout)
counts = {}
for key in ['tests', 'pass', 'fail', 'skipped']:
    matches = re.findall(r'(?:ℹ |# )' + key + r' (\d+)', plain_log)
    if matches:
        counts[key] = int(matches[-1])
assert counts.get('fail') == 0 and counts.get('tests', 0) >= 96, counts
private_fixture = root / '.local-fixtures/probability-list.md'
local_core = root / '.local-fixtures/native-codemirror.js'
local_mathjax = root / '.local-fixtures/obsidian-mathjax.js'
report = {
    'id': plugin_id, 'version': manifest['version'],
    'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'upstream': 'DicksonKam/latex-standard-delimiters@758615a (0.4.7)',
    'checks': {'npmRunCheck': 'passed', 'tests': counts},
    'productionImports': sorted(imports),
    'realDeviceTested': False,
    'testEnvironment': 'Node + markdown-it + jsdom, real CodeMirror state/view, synthetic events and DOM mutations; geometry supplied to sizing tests; Obsidian APIs mocked; editor tests use mocked or captured MathJax CHTML, plus an optional actual local MathJax compatibility test',
    'localCompatibilityCoreSha256': digest(local_core) if local_core.exists() else None,
    'localCompatibilityScope': 'Fourteen DOM-input/touch/source-navigation tests additionally use an isolated core extracted from the locally installed Obsidian 1.14.4 APK, including a minimal Markdown escape-hiding fixture; this is not an Android UI or keyboard test' if local_core.exists() else None,
    'localMathJaxSha256': digest(local_mathjax) if local_mathjax.exists() else None,
    'localMathJaxScope': 'Optional tests run 20 original expressions through the installed MathJax 4.1.3, verify annotations and actual error output, and check source navigation in the private 33-formula note when available; no layout or UI testing' if local_mathjax.exists() else None,
    'privateFixtureAvailable': private_fixture.exists(),
    'files': {name: digest(root / name) for name in assets},
    'sources': {str(path.relative_to(root)): digest(path) for path in source_paths},
}
report_path = dist / 'verification.json'
report_path.write_text(json.dumps(report, indent=2) + '\n')
release_files = [root / name for name in ['main.js', 'manifest.json', 'styles.css', 'LICENSE', 'NOTICE.md']]
release_files.append(report_path)
for source_archive in [False, True]:
    suffix = '-source' if source_archive else ''
    target = dist / f"{plugin_id}-{manifest['version']}{suffix}.zip"
    files = source_paths + [root / 'main.js', root / 'styles.css'] if source_archive else [root / name for name in assets]
    with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, plugin_id + '/' + str(path.relative_to(root)))
        archive.write(report_path, plugin_id + '/verification.json')
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert not any('.local-fixtures' in name or 'node_modules' in name for name in archive.namelist())
        assert hashlib.sha256(archive.read(plugin_id + '/main.js')).hexdigest() == report['files']['main.js']
    print(json.dumps({'archive': str(target), 'sha256': digest(target)}))
    release_files.append(target)
(dist / 'SHA256SUMS.txt').write_text(''.join(f'{digest(path)}  {path.name}\n' for path in release_files))
