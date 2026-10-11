#!/usr/bin/env python3
"""Fetch the source code of every plugin on the RuneLite Plugin Hub.

Python port of HubSearcher-all.jar (pluginhub-searcher-builder, hubupdater).

Usage: python3 fetch_plugin_sources.py <plugins-data-dir> <state-dir>

Each run:
  1. Stops with "No updates found" when the plugin-hub repository's latest
     commit matches <state-dir>/previoushash.txt.
  2. Compares RuneLite's plugin list with <state-dir>/previous.json to find
     new or changed plugins, and plugin folders no longer on the hub.
  3. For each changed plugin whose pinned commit differs from its commit.txt,
     downloads the repository archive at that commit and saves its .java files
     to <plugins-data-dir>/<name>/<name>.json.
  4. Deletes folders of plugins no longer on the hub.

Prints "No updates found" when there is nothing to do; the updater workflow
relies on that exact output. Otherwise prints which plugins were updated and
removed, which the workflow uses as its commit message.
"""

import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

PLUGIN_HUB_COMMITS = "https://api.github.com/repos/runelite/plugin-hub/commits/master"
PLUGIN_HUB_RAW = "https://raw.githubusercontent.com/runelite/plugin-hub/master/"
PLUGIN_LIST_ROOT = "https://repo.runelite.net/plugins/manifest/"
PREVIOUS_LIST = "previous.json"
PREVIOUS_HASH = "previoushash.txt"
COMMIT_FILE = "commit.txt"
NO_UPDATES = "No updates found"
PLACEHOLDER_CONTENT = "this file does not actually exist, because the repo does not exist"

DOWNLOAD_WORKERS = 16
TIMEOUT_SECONDS = 120
# Removal is skipped as a safety check when more than this share would go at once.
MAX_REMOVED_SHARE = 0.10

# Plugin list fields kept in previous.json, in order.
LIST_FIELDS = ("internalName", "version", "displayName", "iconHash", "createdAt",
               "lastUpdatedAt", "author", "description", "tags")
# Fields compared to decide whether a plugin's listing changed.
COMPARED_FIELDS = ("internalName", "version", "iconHash", "lastUpdatedAt", "author", "description")

# Gson's default escaping, so plugin JSON matches what HubSearcher-all.jar wrote.
_GSON_ESCAPES = str.maketrans({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026", "=": "\\u003d", "'": "\\u0027",
    " ": "\\u2028", " ": "\\u2029",
})


def say(message):
    print(message, flush=True)


def warn(message):
    print(message, file=sys.stderr, flush=True)


def gson_json(value):
    """Compact JSON with raw UTF-8 and HTML characters escaped, like Gson."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).translate(_GSON_ESCAPES)


def write_text(path, text):
    with open(path, "w", encoding="utf-8", newline="") as file:
        file.write(text)


def read_text(path):
    with open(path, encoding="utf-8", newline="") as file:
        return file.read()


def http_get(url):
    """Return (status, body). Error statuses are returned rather than raised."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, b""


def http_download(url, file):
    """Stream url into file and return the status; nothing is written on errors."""
    try:
        with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
            shutil.copyfileobj(response, file)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def java_absolute_path(path):
    """The path java.io.File.getAbsolutePath() gives (relative paths aren't normalized)."""
    path = re.sub("/+", "/", path)
    if len(path) > 1:
        path = path.rstrip("/")
    return path if os.path.isabs(path) else os.getcwd() + os.sep + path


def path_after_commit(path, commit):
    """Source path relative to the archive's "<repo>-<commit>/" folder, as the jar computed it."""
    return path[path.find(commit) + len(commit) + 1:]


def list_entry(raw):
    """A plugin list entry reduced to the fields kept, with values as strings like Gson."""
    def text(value):
        return ("true" if value else "false") if isinstance(value, bool) else value

    entry = {}
    for field in LIST_FIELDS:
        value = raw.get(field)
        if value is None:
            continue
        entry[field] = [text(tag) for tag in value] if isinstance(value, list) else text(value)
    return entry


def listing_key(entry):
    return tuple(entry.get(field) for field in COMPARED_FIELDS)


def latest_hub_commit():
    status, body = http_get(PLUGIN_HUB_COMMITS)
    if status != 200:
        return ""
    return json.loads(body)["sha"]


def hub_commit_changed(state_dir, sha):
    try:
        lines = read_text(os.path.join(state_dir, PREVIOUS_HASH)).splitlines()
    except (OSError, UnicodeDecodeError):
        return True
    return (lines[0] if lines else "") != sha


def runelite_version():
    status, body = http_get(PLUGIN_HUB_RAW + "runelite.version")
    if status != 200:
        raise RuntimeError(f"Could not read runelite.version: HTTP {status}")
    return body.decode("utf-8").strip()


def read_previous_list(state_dir):
    try:
        entries = json.loads(read_text(os.path.join(state_dir, PREVIOUS_LIST)), parse_int=str, parse_float=str)
    except (OSError, ValueError):
        return []
    return [list_entry(entry) for entry in entries] if isinstance(entries, list) else []


def changed_listings(state_dir, version):
    """Return (new or changed entries, names on the hub); names is None if the list can't be read."""
    status, body = http_get(PLUGIN_LIST_ROOT + version + "_full.js")
    if status != 200:
        return [], None
    # The list follows a binary signature; numbers are kept as their literal text.
    text = body.decode("utf-8", errors="replace").replace("\r", "").replace("\n", "")
    plugin_list = json.loads(text[text.index('{"display":['):], parse_int=str, parse_float=str)
    current = [list_entry(entry) for entry in plugin_list["display"]]
    names = {entry.get("internalName") for entry in current}

    previous = read_previous_list(state_dir)
    seen = {listing_key(entry) for entry in previous}
    changed = [entry for entry in current if listing_key(entry) not in seen]
    # Also saved when plugins are removed, so one that returns unchanged is fetched again.
    removed = any(entry.get("internalName") not in names for entry in previous)
    if changed or removed:
        os.makedirs(state_dir, exist_ok=True)
        write_text(os.path.join(state_dir, PREVIOUS_LIST), gson_json(current))
    return changed, names


def plugins_not_on_hub(data_dir, names):
    """Plugin folders no longer on the hub; empty if the list is missing or too many would go."""
    if not names:
        return []
    folders = [entry.name for entry in os.scandir(data_dir) if entry.is_dir()]
    removed = sorted(name for name in folders if name not in names)
    if len(removed) > len(folders) * MAX_REMOVED_SHARE:
        say(f"Skipped removing {len(removed)} plugins no longer on the hub "
            f"(more than {round(MAX_REMOVED_SHARE * 100)}% at once)")
        return []
    return removed


def plugin_descriptor(name):
    """The (commit, repository) a plugin is pinned to in the plugin-hub repository."""
    status, body = http_get(PLUGIN_HUB_RAW + "plugins/" + name)
    if status != 200:
        raise RuntimeError(f"HTTP {status}")
    commit = repository = ""
    for line in body.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if line.startswith("commit="):
            commit = line.split("=", 1)[1].strip()
        elif line.startswith("repository="):
            repository = line.split("=", 1)[1].strip()
    return commit, repository


def archive_sources(archive, plugin_path, name, commit):
    """File entries for every .java file in a repository archive, in archive order."""
    files = []
    with zipfile.ZipFile(archive) as zip_file:
        for info in zip_file.infolist():
            file_name = info.filename.rsplit("/", 1)[-1]
            if info.is_dir() or not file_name.endswith(".java"):
                continue
            try:
                content = zip_file.read(info).decode("utf-8")
            except UnicodeDecodeError:
                continue
            files.append({
                "fileName": file_name,
                "content": content,
                "filePath": path_after_commit(plugin_path + "/" + info.filename, commit),
                "pluginName": name,
            })
    return files


def update_plugin(data_dir, name):
    """Fetch one plugin's sources if its pinned commit changed. Returns its name if it was updated."""
    plugin_dir = os.path.join(data_dir, name)
    try:
        commit, repository = plugin_descriptor(name)
        try:
            if read_text(os.path.join(plugin_dir, COMMIT_FILE)) == commit:
                return ""
        except FileNotFoundError:
            pass

        git = repository.rfind(".git")
        if git == -1:
            raise RuntimeError(f"repository is not a .git URL: {repository!r}")
        url = repository[:git] + "/archive/" + commit + ".zip"
        plugin_path = java_absolute_path(data_dir) + "/" + name
        with tempfile.TemporaryFile() as archive:
            status = http_download(url, archive)
            if status in (404, 410):
                # The repository is gone; save a placeholder so the plugin isn't fetched again.
                reported = ""
                files = [{
                    "fileName": "test.java",
                    "content": PLACEHOLDER_CONTENT,
                    "filePath": path_after_commit(plugin_path + "/test.java", commit),
                    "pluginName": name,
                }]
            elif status == 200:
                reported = name
                files = archive_sources(archive, plugin_path, name, commit)
            else:
                raise RuntimeError(f"HTTP {status} for {url}")
    except Exception as error:  # noqa: BLE001 - one plugin failing mustn't stop the rest
        # Existing data is kept, so a failed download never removes a plugin's sources.
        warn(f"Could not update {name}: {error}")
        return ""

    shutil.rmtree(plugin_dir, ignore_errors=True)
    os.makedirs(plugin_dir)
    write_text(os.path.join(plugin_dir, COMMIT_FILE), commit)
    record = {"commit": commit, "repository": repository, "internalName": name, "files": files}
    write_text(os.path.join(plugin_dir, name + ".json"), gson_json(record))
    return reported


def run(data_dir, state_dir):
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(state_dir, exist_ok=True)

    sha = latest_hub_commit()
    if not sha or not hub_commit_changed(state_dir, sha):
        say(NO_UPDATES)
        return

    changed, names = changed_listings(state_dir, runelite_version())
    removed = plugins_not_on_hub(data_dir, names)
    if not changed and not removed:
        # previoushash.txt isn't saved: the plugin list can lag behind a hub commit.
        say(NO_UPDATES)
        return

    to_check = [entry["internalName"] for entry in changed if entry.get("internalName")]
    with ThreadPoolExecutor(DOWNLOAD_WORKERS) as pool:
        updated = [name for name in pool.map(lambda name: update_plugin(data_dir, name), to_check) if name]

    if updated or not removed:
        say("Updated content" if len(updated) > 10 else "Updated plugins: " + ", ".join(updated))
    if len(removed) > 10:
        say(f"Removed {len(removed)} plugins")
    elif removed:
        say("Removed plugins: " + ", ".join(removed))
    for name in removed:
        shutil.rmtree(os.path.join(data_dir, name), ignore_errors=True)

    write_text(os.path.join(state_dir, PREVIOUS_HASH), sha)


def main(argv):
    if len(argv) != 3:
        warn("Usage: python3 fetch_plugin_sources.py <plugins-data-dir> <state-dir>")
        return 2
    run(argv[1], argv[2])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
