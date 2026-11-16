import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

from python_release import TARGETS, ReleaseTargetError, check_version_policy, overlay_file, release_targets, resolve, verify_artifacts


class PythonReleaseTests(unittest.TestCase):

    def test_namespaces_and_exact_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / TARGETS["apifn"]
            directory.mkdir(parents=True)
            (directory / "pyproject.toml").write_text('[project]\nname="apifn"\nversion="1.2.3"\n')
            for tag in ["authfn-v1.2.3", "v1.2.3", "python-unknown-v1.2.3", "python-apifn-v1.2.4"]:
                with self.assertRaises(ValueError):
                    resolve(tag, root)

    def test_core_distribution_cutover(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / TARGETS["superfunctions-core"]
            directory.mkdir(parents=True)
            (directory / "pyproject.toml").write_text('[project]\nname="superfunctions-core"\nversion="0.1.1"\n')
            result = resolve("python-superfunctions-core-v0.1.1", root)
            self.assertEqual(result["name"], "superfunctions-core")
            self.assertEqual(result["path"], "packages/python-core")
            with self.assertRaises(ValueError):
                resolve("python-superfunctions-v0.1.1", root)

    def test_canonical_prerelease_version_policy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            directory = root / TARGETS["apifn"]
            directory.mkdir(parents=True)
            for version, prerelease in [("1.0.0", False), ("1.1.0a1", True), ("1.1.0b2", True), ("1.1.0rc3", True)]:
                (directory / "pyproject.toml").write_text(f'[project]\nname="apifn"\nversion="{version}"\n')
                result = resolve(f"python-apifn-v{version}", root)
                self.assertEqual(result["prerelease"], prerelease)
            for version in ["01.0.0", "1.0.0RC1", "1.0.0+local", "1.0.0.dev1", "1.0.0.post1", "1!1.0.0"]:
                with self.assertRaises(ValueError):
                    resolve(f"python-apifn-v{version}", root)

    def test_next_overlay_adds_projects_and_never_repeats_a_base_project(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name, path in [("apifn", TARGETS["apifn"]), ("nextfn", "nextfn/python")]:
                (root / path).mkdir(parents=True)
                (root / path / "pyproject.toml").write_text(f'[project]\nname="{name}"\nversion="1.0.0"\n')
            overlay = root / overlay_file("next")
            self.assertEqual(overlay.name, "python-release-packages.next.json")

            # Without an overlay the targets are exactly TARGETS.
            self.assertEqual(release_targets(root), TARGETS)
            with self.assertRaises(ValueError):
                resolve("python-nextfn-v1.0.0", root)

            overlay.write_text(json.dumps([{"name": "nextfn", "path": "nextfn/python"}]))
            self.assertEqual(resolve("python-nextfn-v1.0.0", root)["path"], "nextfn/python")
            self.assertEqual(resolve("python-apifn-v1.0.0", root)["path"], TARGETS["apifn"])

            cases = [
                ([{"name": "apifn", "path": "nextfn/python"}], "duplicate-slug", "in both TARGETS"),
                ([{"name": "nextfn", "path": "nextfn/python"}, {"name": "nextfn", "path": "other"}], "duplicate-slug", "more than once"),
                ([{"name": "nextfn", "path": "../outside"}], "invalid-target-path", "nextfn"),
                ([{"name": "nextfn", "path": "/abs"}], "invalid-target-path", "nextfn"),
                ([{"name": "NextFn", "path": "nextfn/python"}], "invalid-target", "canonical"),
                ([{"name": "nextfn"}], "invalid-target", "canonical"),
                ([{"name": "nextfn", "path": "nextfn/python", "slug": "x"}], "invalid-target", "canonical"),
                ({"nextfn": "nextfn/python"}, "malformed-release-file", "array"),
            ]
            for entries, code, message in cases:
                overlay.write_text(json.dumps(entries))
                with self.subTest(entries=entries):
                    with self.assertRaises(ReleaseTargetError) as raised:
                        resolve("python-apifn-v1.0.0", root)
                    self.assertEqual(raised.exception.code, code)
                    self.assertIn(message, str(raised.exception))
            overlay.write_text("[")
            with self.assertRaises(ReleaseTargetError) as raised:
                resolve("python-apifn-v1.0.0", root)
            self.assertEqual(raised.exception.code, "malformed-release-file")

    def test_pypi_occupied_and_regressive_versions_fail(self):
        for version in ["0.1.0", "0.0.9", "0.1.0rc1"]:
            with self.assertRaises(ValueError):
                check_version_policy({"name": "apifn", "version": version}, {"0.1.0": []})
        check_version_policy({"name": "apifn", "version": "0.2.0rc1"}, {"0.1.0": [], "0.3.0rc1": []})
        check_version_policy({"name": "apifn", "version": "0.0.1"}, {})
        with self.assertRaises(ValueError):
            check_version_policy({"name": "apifn", "version": "1.0.0"}, {"1.0": []})

    def test_distribution_metadata_identity_and_payload(self):
        target = {"name": "apifn", "version": "1.0.0"}
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            metadata = b"Metadata-Version: 2.3\nName: apifn\nVersion: 1.0.0\n"
            wheel = directory / "apifn-1.0.0-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("apifn/__init__.py", "VALUE = 42\n")
                archive.writestr("apifn-1.0.0.dist-info/METADATA", metadata)
            sdist = directory / "apifn-1.0.0.tar.gz"
            with tarfile.open(sdist, "w:gz") as archive:
                member = tarfile.TarInfo("apifn-1.0.0/PKG-INFO")
                member.size = len(metadata)
                archive.addfile(member, io.BytesIO(metadata))
            self.assertEqual(verify_artifacts(directory, target), (wheel, sdist))
            with self.assertRaises(ValueError):
                verify_artifacts(directory, {"name": "other", "version": "1.0.0"})
            with self.assertRaises(ValueError):
                verify_artifacts(directory, {"name": "apifn", "version": "1.0.1"})
            with zipfile.ZipFile(wheel, "w") as archive:
                archive.writestr("apifn-1.0.0.dist-info/METADATA", metadata)
            with self.assertRaisesRegex(ValueError, "no Python library source"):
                verify_artifacts(directory, target)
            wheel.unlink()
            with self.assertRaisesRegex(ValueError, "exactly one wheel"):
                verify_artifacts(directory, target)


if __name__ == "__main__":
    unittest.main()
