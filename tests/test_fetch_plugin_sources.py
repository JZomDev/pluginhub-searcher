import contextlib
import importlib.util
import io
import json
import os
import pathlib
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("fetch_plugin_sources", ROOT / "builders" / "fetch_plugin_sources.py")
fetcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetcher)

OLD_COMMIT = "a" * 40
NEW_COMMIT = "b" * 40
BETA_COMMIT = "c" * 40
GONE_COMMIT = "d" * 40


def archive(repo, commit, files):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zip_file:
        zip_file.writestr(f"{repo}-{commit}/", b"")
        for path, content in files.items():
            zip_file.writestr(f"{repo}-{commit}/{path}", content)
    return buffer.getvalue()


def listing(name, **fields):
    return {"internalName": name, "version": "1.0", "displayName": name.title(), "createdAt": 1700000000,
            "lastUpdatedAt": 1700000000, "author": "someone", "description": "x", **fields}


class FakeHub:
    """Serves the URLs fetch_plugin_sources requests from in-memory data."""

    def __init__(self, sha, plugins, descriptors, archives):
        prefix = b"\x00\x01binary signature\n"
        self.responses = {
            fetcher.PLUGIN_HUB_COMMITS: json.dumps({"sha": sha}).encode(),
            fetcher.PLUGIN_HUB_RAW + "runelite.version": b"1.13.1\n",
            fetcher.PLUGIN_LIST_ROOT + "1.13.1_full.js": prefix + json.dumps({"display": plugins, "jars": {}}, separators=(",", ":")).encode(),
        }
        for name, (commit, repository) in descriptors.items():
            self.responses[fetcher.PLUGIN_HUB_RAW + "plugins/" + name] = \
                f"repository={repository}\ncommit={commit}\n".encode()
        self.responses.update(archives)
        self.requested = []

    def get(self, url):
        self.requested.append(url)
        return (200, self.responses[url]) if url in self.responses else (404, b"")

    def download(self, url, file):
        status, body = self.get(url)
        file.write(body)
        return status


class FetchPluginSourcesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, self.cwd)
        self.data = pathlib.Path("plugins/data")
        self.state = pathlib.Path("plugins")

    def use(self, hub):
        original = fetcher.http_get, fetcher.http_download
        fetcher.http_get, fetcher.http_download = hub.get, hub.download
        self.addCleanup(lambda: setattr(fetcher, "http_get", original[0]) or setattr(fetcher, "http_download", original[1]))

    def run_fetcher(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            fetcher.run("./plugins/data", "./plugins")
        return stdout.getvalue(), stderr.getvalue()

    def save_plugin(self, name, commit, content):
        folder = self.data / name
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "commit.txt").write_text(commit)
        (folder / f"{name}.json").write_text(content)

    def test_updates_changed_plugins_and_removes_missing_ones(self):
        self.save_plugin("alpha", OLD_COMMIT, "old alpha")
        self.save_plugin("beta", BETA_COMMIT, "beta, untouched")
        self.save_plugin("retired", OLD_COMMIT, "gone from the hub")
        # Unchanged plugins, so removing one stays under the 10% safety limit.
        steady = [f"steady-{index}" for index in range(10)]
        for name in steady:
            self.save_plugin(name, OLD_COMMIT, name)
        (self.state / "previous.json").write_text(json.dumps([
            fetcher.list_entry(listing(name)) for name in ["alpha", "beta", "retired"] + steady]))
        (self.state / "previoushash.txt").write_text("old-sha")
        hub = FakeHub("new-sha",
                      [listing("alpha", version="2.0", iconHash="abc", warning="dropped"),
                       listing("beta", lastUpdatedAt=1800000000),  # listing changed, commit didn't
                       listing("gone")] + [listing(name) for name in steady],
                      {"alpha": (NEW_COMMIT, "https://github.com/me/alpha.git"),
                       "beta": (BETA_COMMIT, "https://github.com/me/beta.git"),
                       "gone": (GONE_COMMIT, "https://github.com/me/gone.git")},
                      {"https://github.com/me/alpha/archive/" + NEW_COMMIT + ".zip": archive("alpha", NEW_COMMIT, {
                          "src/main/java/Alpha.java": "class Alpha { List<String> s = \"it's\"; }\r\n",
                          "README.md": "not java",
                          "src/test/java/AlphaTest.java": "class AlphaTest {}",
                          "src/main/java/Bad.java": b"\xff\xfe not utf-8",
                      })})
        self.use(hub)

        stdout, stderr = self.run_fetcher()

        self.assertEqual(stdout, "Updated plugins: alpha\nRemoved plugins: retired\n")
        self.assertEqual(stderr, "")
        alpha = (self.data / "alpha" / "alpha.json").read_text()
        self.assertEqual(alpha, fetcher.gson_json({
            "commit": NEW_COMMIT, "repository": "https://github.com/me/alpha.git", "internalName": "alpha",
            "files": [
                {"fileName": "Alpha.java", "content": "class Alpha { List<String> s = \"it's\"; }\r\n",
                 "filePath": "src/main/java/Alpha.java", "pluginName": "alpha"},
                {"fileName": "AlphaTest.java", "content": "class AlphaTest {}",
                 "filePath": "src/test/java/AlphaTest.java", "pluginName": "alpha"},
            ]}))
        self.assertIn("List\\u003cString\\u003e", alpha)
        self.assertEqual((self.data / "alpha" / "commit.txt").read_text(), NEW_COMMIT)
        self.assertEqual(sorted(os.listdir(self.data / "alpha")), ["alpha.json", "commit.txt"])

        self.assertEqual((self.data / "beta" / "beta.json").read_text(), "beta, untouched")

        gone = json.loads((self.data / "gone" / "gone.json").read_text())
        placeholder_path = fetcher.java_absolute_path("./plugins/data") + "/gone/test.java"
        self.assertEqual(gone["files"], [{"fileName": "test.java", "content": fetcher.PLACEHOLDER_CONTENT,
                                          "filePath": placeholder_path[len(GONE_COMMIT):], "pluginName": "gone"}])
        self.assertTrue(placeholder_path.endswith("/./plugins/data/gone/test.java"))

        self.assertFalse((self.data / "retired").exists())
        previous = json.loads((self.state / "previous.json").read_text())
        self.assertEqual([entry["internalName"] for entry in previous], ["alpha", "beta", "gone"] + steady)
        self.assertEqual(list(previous[0]), ["internalName", "version", "displayName", "iconHash", "createdAt",
                                             "lastUpdatedAt", "author", "description"])
        self.assertEqual(previous[0]["createdAt"], "1700000000")
        self.assertEqual((self.state / "previoushash.txt").read_text(), "new-sha")

    def test_no_updates_when_hub_commit_unchanged(self):
        (self.state).mkdir(parents=True)
        (self.state / "previoushash.txt").write_text("same-sha")
        hub = FakeHub("same-sha", [], {}, {})
        self.use(hub)

        self.assertEqual(self.run_fetcher(), ("No updates found\n", ""))
        self.assertEqual(hub.requested, [fetcher.PLUGIN_HUB_COMMITS])

    def test_no_updates_when_plugin_list_unchanged(self):
        self.save_plugin("alpha", OLD_COMMIT, "alpha")
        (self.state / "previous.json").write_text(json.dumps([fetcher.list_entry(listing("alpha"))]))
        (self.state / "previoushash.txt").write_text("old-sha")
        self.use(FakeHub("new-sha", [listing("alpha")], {}, {}))

        self.assertEqual(self.run_fetcher(), ("No updates found\n", ""))
        # The hub commit isn't saved, since RuneLite's plugin list can lag behind it.
        self.assertEqual((self.state / "previoushash.txt").read_text(), "old-sha")

    def test_failed_download_keeps_existing_sources(self):
        self.save_plugin("alpha", OLD_COMMIT, "old alpha")
        self.use(FakeHub("new-sha", [listing("alpha", version="2.0")],
                         {"alpha": (NEW_COMMIT, "https://github.com/me/alpha.git")},
                         {"https://github.com/me/alpha/archive/" + NEW_COMMIT + ".zip": b"not a zip"}))

        stdout, stderr = self.run_fetcher()

        self.assertEqual(stdout, "Updated plugins: \n")
        self.assertIn("Could not update alpha", stderr)
        self.assertEqual((self.data / "alpha" / "alpha.json").read_text(), "old alpha")
        self.assertEqual((self.data / "alpha" / "commit.txt").read_text(), OLD_COMMIT)

    def test_skips_removal_when_too_many_plugins_would_go(self):
        for index in range(20):
            self.save_plugin(f"plugin-{index}", OLD_COMMIT, "kept")
        self.use(FakeHub("new-sha", [listing("plugin-0", version="2.0")], {}, {}))

        stdout, _ = self.run_fetcher()

        self.assertTrue(stdout.startswith("Skipped removing 19 plugins no longer on the hub (more than 10% at once)\n"))
        self.assertEqual(len(os.listdir(self.data)), 20)

    def test_gson_json_escaping(self):
        self.assertEqual(fetcher.gson_json({"a": "<b>&=' é\n\t\"\\"}),
                         '{"a":"\\u003cb\\u003e\\u0026\\u003d\\u0027\\u2028é\\n\\t\\"\\\\"}')


if __name__ == "__main__":
    unittest.main()
