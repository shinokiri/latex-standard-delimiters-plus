import importlib.util
import io
from pathlib import Path
import stat
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("overlay", Path(__file__).with_name("prepare-overlay.py"))
overlay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(overlay)


class GuardTests(unittest.TestCase):
    def archive(self, extra=None):
        data = io.BytesIO()
        with zipfile.ZipFile(data, "w") as archive:
            for name in ("index.html", "app.js", "worker.js"):
                archive.writestr("assets/public/" + name, "fixture")
            if extra:
                archive.writestr(*extra)
        data.seek(0)
        return zipfile.ZipFile(data)

    def test_path_and_symlink_rejection(self):
        for name in ["../outside.js", "/absolute.js", "a\\b.js", "a/./b.js", "app.js"]:
            with self.subTest(name=name), self.archive(("assets/public/" + name, "x")) as archive:
                with self.assertRaises(ValueError):
                    overlay.asset_entries(archive)
        link = zipfile.ZipInfo("assets/public/link")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        with self.archive((link, "/outside")) as archive:
            with self.assertRaises(ValueError):
                overlay.asset_entries(archive)

    def test_unknown_host_never_produces_output(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / "fixture.apk"
            with self.archive() as archive:
                apk.write_bytes(archive.fp.getvalue())
            output = overlay.FIXTURES / "should-not-be-created"
            with self.assertRaisesRegex(ValueError, "Unsupported host checksum"):
                overlay.prepare(apk, output)
            self.assertFalse(output.exists())

    def test_destination_must_be_an_unused_ignored_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "ignored"):
                overlay.prepare(Path("not-an-apk"), Path(directory) / "out")
        with self.assertRaisesRegex(ValueError, "ignored"):
            overlay.prepare(Path("not-an-apk"), overlay.FIXTURES)


if __name__ == "__main__":
    unittest.main()
