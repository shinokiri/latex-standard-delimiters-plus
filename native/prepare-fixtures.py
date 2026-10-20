#!/usr/bin/env python3
"""Prepare ignored, local test fixtures from the user's own evaluated APK.

No network access, APK modification, installation, signing or redistribution.
Only the explicitly evaluated host checksums are accepted.
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / ".local-fixtures"
HASHES = {
    "app.js": "7591ddf1df0414b26af79b9ae7fcaffc0f210332686520523fc3a391d675800e",
    "native-worker.js": "a42f7927658132927e124131fdb7fc69fdb2853097c24158e0fdb245b87c34ae",
}


def between(source, start, end, include_end=False):
    begin = source.index(start)
    finish = source.index(end, begin) + (len(end) if include_end else 0)
    return source[begin:finish]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 native/prepare-fixtures.py /path/to/your/Obsidian-1.14.4-Android.apk")
    entries = {
        "app.js": "assets/public/app.js",
        "native-worker.js": "assets/public/worker.js",
        "codemirror.js": "assets/public/lib/codemirror/codemirror.js",
        "markdown.js": "assets/public/lib/codemirror/markdown.js",
        "modes.min.js": "assets/public/lib/codemirror/modes.min.js",
        "obsidian-mathjax.js": "assets/public/lib/mathjax/obsidian-mathjax.js",
    }
    with zipfile.ZipFile(sys.argv[1]) as apk:
        data = {name: apk.read(entry) for name, entry in entries.items()}
    for name, expected in HASHES.items():
        if hashlib.sha256(data[name]).hexdigest() != expected:
            raise SystemExit("Unsupported host checksum; no fixtures were written")
    app = data["app.js"].decode("utf-8")
    hypermd = "var " + between(
        app, "Qj=window.CodeMirror",
        'Qj.defineMIME("text/x-hypermd","hypermd");', True
    )
    rtl = between(app, "var GE=", 'return"auto"}', True)
    data["hypermd.js"] = (hypermd + "\n" + rtl).encode()
    helpers = between(app, "var f=function", "Object.create;var S,x,T=")
    core = between(app, "let fe=[],ve=[]", "function wp(e)")
    exports = """
Object.assign(globalThis.nativeModules,{
  "@codemirror/state":{EditorState:qt,Compartment:ft,EditorSelection:$e,Facet:et,Prec:dt,StateEffect:At,StateField:at,RangeSet:Yt,RangeSetBuilder:Qt,RangeValue:jt,Text:xe,Transaction:It},
  "@codemirror/view":{EditorView:za,Decoration:jn,WidgetType:qn,ViewPlugin:pr,keymap:Ya},
  "@codemirror/language":{StreamLanguage:op,language:Lh,syntaxTree:bh,ensureSyntaxTree:wh},
  test:{tokenProp:vp,lineProp:mp,highlight:yp}
});
"""
    data["native-codemirror.js"] = ("(function(){" + helpers + core + exports + "})();").encode()
    FIXTURES.mkdir(exist_ok=True)
    for name, content in data.items():
        (FIXTURES / name).write_bytes(content)
    report = {"hostVersion": "1.14.4", "hostPlatform": "Android", "files": {
        name: {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        for name, content in data.items()
    }}
    (FIXTURES / "host-fixtures.json").write_text(json.dumps(report, indent=2) + "\n")
    print("Prepared local host fixtures in ignored .local-fixtures/; do not redistribute them.")


if __name__ == "__main__":
    main()
