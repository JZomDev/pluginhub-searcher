# PluginHub Searcher

Search the source code of every plugin on the [RuneLite Plugin Hub](https://github.com/runelite/plugin-hub), straight from your browser.

**Live site: https://jzomdev.github.io/pluginhub-searcher/**

There is no backend. The site is static files on GitHub Pages, and all searching happens client-side.

## How it works

The project has two stages: a fetcher that keeps a local copy of plugin sources up to date, and a builder that turns those sources into a static search index.

### 1. Fetch plugin sources (`builders/fetch_plugin_sources.py`)

1. Checks the latest commit of `runelite/plugin-hub`. If it hasn't changed since the last run, it prints `No updates found` and stops.
2. Compares RuneLite's published plugin list with the previous one to find new or changed plugins, and plugins that are no longer on the hub.
3. For each changed plugin whose pinned commit differs from its `commit.txt`, downloads the repository archive at that commit and saves its `.java` files to `plugins/data/<plugin>/<plugin>.json`.
4. Deletes the folders of plugins that were removed from the hub.

If a plugin's repository has been deleted, a placeholder is stored so it isn't re-fetched on every run. If a download fails, the existing data is kept.

### 2. Build the search index (`builders/build_reverse_index.py`)

The builder creates a static trigram reverse index over all fetched source files:

| File | Contents |
| --- | --- |
| `manifest.bin` | Build id, plugin table, chunk table, shard count |
| `shards/NNNN.bin` | Trigram to sorted file-id posting lists, sharded by FNV-1a hash |
| `chunks/NNNN.bin` | JSON arrays of source files, grouped into roughly 512 KB chunks |

All files are gzip-compressed and served as opaque `.bin` files.

### 3. Search in the browser (`index.html`, `scripts/`)

The browser loads only the manifest at startup. A search then:

1. Splits the query into trigrams and fetches the posting shards for them in one parallel round.
2. Intersects the posting lists to find candidate files.
3. Fetches only the text chunks that hold those files and matches the query against them.

This keeps page loads small while still searching the full text of every plugin.

## Automation

Two GitHub Actions workflows keep the site current:

- **`updater.yml`** runs the fetcher, rebuilds the index if anything changed, commits the new plugin data, and deploys to GitHub Pages. It can be started manually from the Actions tab.
- **`deploy.yml`** redeploys the site when code changes are pushed to `main`. The index isn't committed, so it is rebuilt from `plugins/data` on each deploy.

## Running locally

Requires Python 3.11+.

```sh
# Download plugin sources into plugins/data
npm run fetch-plugins

# Build the search index into plugins/index
npm run build-index

# Serve the site, e.g.
python3 -m http.server
```

## License

[BSD 2-Clause](LICENSE)
