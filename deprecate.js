// Memoized fetch cache — prevents redundant network requests when this module
// is re-imported or reloaded in the same session.
let _cachedVersion = null;
async function setVersion(){
    let req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
    _cachedVersion = (await req.text()).trim();
}

const root = "https://repo.runelite.net/plugins/"

let _cachedManifest = null;
async function setManifest(){
    let req = await fetch(`${root}manifest/${_cachedVersion}_full.js`);
    let buf = new DataView(await req.arrayBuffer());
    let skip = 4 + buf.getUint32(0);
    let text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
    _cachedManifest = JSON.parse(text);
}

let _cachedInstalls = null;
async function setInstalls(){

    let req = await fetch(`https://api.runelite.net/runelite-${_cachedVersion}/pluginhub`);
    _cachedInstalls = await req.json();
}
let fileContent = new Map();

// Decode an ArrayBuffer that may be gzip-compressed into a parsed JSON value.
// Detects the gzip magic number (0x1f 0x8b) and decompresses in-browser via
// DecompressionStream only when needed — so this also works transparently if the
// host already applied Content-Encoding: gzip, or if the file is plain JSON.
// Split out from fetchJson so downloading (network) and unzipping (CPU) can be
// tracked as separate loading phases.
async function decodeJson(buf) {
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        text = await new Response(stream).text();
    } else {
        text = new TextDecoder("utf-8").decode(bytes);
    }
    return JSON.parse(text);
}

// Normalize both supported split-manifest formats:
//   ["plugins_0.json.gz", ...]
//   [{zipname: "plugins_0.json.gz", content: [...]}, ...]
function getSplitFileNames(splits) {
    if (!Array.isArray(splits)) return [];
    return splits
        .map((split) => typeof split === "string" ? split : split?.zipname)
        .filter((name) => typeof name === "string" && name.trim().length > 0);
}

// Process a single .gz file: fetch → uncompress → process JSON → return part.
// This encapsulates the complete lifecycle of one file so it can move through
// the pipeline independently without waiting for other files.
// OPTIMIZATION: Captures Last-Modified header during fetch to avoid redundant HEAD requests.
async function processFile(fileNames, index, captureHeaders) {
    const name = fileNames[index];
    try {
        const res = await fetch(`plugins/${name}`);
        if (!res.ok) return { data: null, headers: null };
        
        // Capture Last-Modified header while we have the response
        // This avoids needing separate HEAD requests later
        let lastModified = null;
        if (captureHeaders) {
            lastModified = res.headers.get("Last-Modified");
        }
        
        const buf = await res.arrayBuffer();
        const part = await decodeJson(buf);
        return {
            data: Array.isArray(part) ? part : null,
            headers: lastModified ? { lastModified } : null
        };
    } catch (e) {
        return { data: null, headers: null };
    }
}

// Load the full plugin data bundle with per-file pipelining:
// Each .gz file moves through fetch → uncompress → process independently,
// rather than waiting for all files to complete each stage.
// The optional progress callbacks let the UI show how far along it is.
// Returns a map of internalName -> [{filePath, content}, ...].
// When `onIndexed` is provided, it's called for each plugin as its file's
// data is merged into the map, enabling incremental indexing.
async function loadPluginBundle({onFetchStart, onFetch, onUnzipStart, onUnzip, onIndexed} = {}) {


    // Phase 1 fetch the names of the .gz files
    let fileNames = null;
    const splitsRes = await fetch("plugins/plugins_splits.json");
    if (splitsRes.ok) {
        const splits = await splitsRes.json();
        fileNames = getSplitFileNames(splits);
    }

    if (fileNames == null)
    {
        return
    }

    loadPluginBundle._splitFileNames = fileNames;

    // Per-file pipeline: each file is processed independently through fetch →
    // uncompress → process. Promise.all preserves input order regardless of
    // which file finishes first. Progress is reported as each file completes
    // its full pipeline.
    if (onFetchStart) onFetchStart(fileNames.length);
    if (onUnzipStart) onUnzipStart(fileNames.length);

    const parts = await Promise.all(
        fileNames.map(async (name, index) => {
            const result = await processFile(fileNames, index, true);
            // Report progress for both fetch and unzip phases as each file finishes.
            if (onFetch) onFetch(index + 1);
            if (onUnzip) onUnzip(index + 1);
            return result;
        })
    );

    // Merge parts in order and index by internalName (same shape as before).
    const map = Object.create(null);
    // Track which internalName came from which filename for incremental indexing.
    const splitLookup = Object.create(null); // filename → internalNames[]
    // Collect file headers for use by getPluginsLastUpdated
    const fileHeaders = Object.create(null); // filename → { lastModified }
    
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i].data;
        const headers = parts[i].headers;
        const fn = fileNames[i];
        const thisPluginNames = [];
        
        if (headers) {
            fileHeaders[fn] = headers;
        }
        
        if (!part) continue;
        for (const p of part) {
            if (!p || !p.internalName) continue;
            const contents = [];
            if (p.content) {
                contents.push({filePath: null, content: p.content});
            }
            if (Array.isArray(p.files)) {
                for (const f of p.files) {
                    if (!f) continue;
                    contents.push({filePath: f.filePath || null, content: f.content || null});
                }
            }
            map[p.internalName] = contents;
            thisPluginNames.push(p.internalName);
            if (onIndexed) onIndexed(p.internalName, contents, p);
        }
        if (thisPluginNames.length > 0) {
            splitLookup[fn] = thisPluginNames;
        }
    }
    loadPluginBundle._splitLookup = splitLookup;
    loadPluginBundle._fileHeaders = fileHeaders;
    return map;
}

async function getContent(user, repo, internalName, files) {
    // Load the bundle once and share it across concurrent callers.
    if (!getContent._bundlePromise) {
        getContent._bundlePromise = (async () => {
            try {
                getContent._bundle = await loadPluginBundle();
            } catch (e) {
                getContent._bundle = {};
            }
        })();
    }

    await getContent._bundlePromise;

    const bundle = getContent._bundle || {};
    if (bundle[internalName]) {
        fileContent.set(internalName, bundle[internalName]);
        return true;
    }
    return false;
}

class AutoMap extends Map {
    constructor(factory) {
        super()
        this.factory = factory;
    }
    get(key) {
        let v = super.get(key);
        if (v === undefined) {
            this.set(key, v = this.factory(key));
        }
        return v;
    }
}

// Core indexing loop: parse file contents line-by-line, extract symbols, push to symbolLocations.
// OPTIMIZED: Uses indexOf('\n') with substring slicing for memory efficiency.
// Avoids creating intermediate array for 2M+ lines; only keeps current line in memory.
function _indexPlugin(pluginName, contents, symbolLocations) {
    for (let f of contents) {
        if (!f) continue;
        let filePath = null;
        let content = "";
        if (typeof f === "string") {
            filePath = f;
            content = "";
        } else {
            filePath = f.filePath || f.fileName || null;
            content = f.content || "";
        }
        
        // Skip empty content entirely
        if (!content) continue;
        
        let lineStart = 0;
        let lineNum = 1;
        let idx;
        
        // Single pass: scan for newlines, extract only current line as substring
        while ((idx = content.indexOf('\n', lineStart)) !== -1) {
            const k = content.substring(lineStart, idx);
            if (k) {
                symbolLocations.get(k).push({plugin: pluginName, file: filePath, line: lineNum});
            }
            lineStart = idx + 1;
            lineNum++;
        }
        
        // Handle final line (no trailing newline)
        const k = content.substring(lineStart);
        if (k) {
            symbolLocations.get(k).push({plugin: pluginName, file: filePath, line: lineNum});
        }
    }
}

(async () => {
    await setVersion();
    await setManifest();
    await setInstalls();
    let mf = _cachedManifest;
    let installMap = _cachedInstalls;
    document.body.addEventListener("click", async ev => {
        if (ev?.target?.classList?.contains("plugin")) {
            ev.preventDefault();
            let name = ev.target.dataset.name;
            let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${name}`);
            let text = await req.text();
            let prop = {};
            for (let line of text.split("\n")) {
                let kv = line.split("=", 2);
                if (kv.length == 2) {
                    prop[kv[0]] = kv[1];
                }
            }
            window.open(`${prop.repository.replace(/\.git$/, "")}/tree/${prop.commit}`);
        }
    });

    const List = {
        props: {
            list: {},
            name: {},
            active: {
                type: Boolean,
                default: false,
            }
        },
        data() {
            return {
                active_: this.active,
            }
        },
        template: `
<div class="list">
	<div class="header" @click="active_=!active_">[ {{active_ ? "-" : "+"}} ] {{list.length}} {{name}}</div>
	<ul v-if="active_">
		<li v-for="(item, idx) of list" :key="idx">
			<slot :item="item"></slot>
		</li>
	</ul>
</div>
`,
    };

    function sortPlugins(plugins) {
        plugins.sort((a, b) => (installMap[b] || 0) - (installMap[a] || 0));
        return plugins;
    }

    async function getPluginsLastUpdated() {
        // OPTIMIZATION: Use headers captured during initial fetch instead of making N additional HEAD requests
        const fileHeaders = loadPluginBundle._fileHeaders || {};
        const dates = [];
        
        for (const name of (loadPluginBundle._splitFileNames || [])) {
            try {
                const header = fileHeaders[name];
                if (!header || !header.lastModified) continue;
                
                const dt = new Date(header.lastModified);
                if (!isNaN(dt)) {
                    dates.push(dt);
                }
            } catch (e) {
                // Skip on error
            }
        }

        const latest = dates.sort((a, b) => b - a)[0];
        if (!latest) return "Unknown";
        return latest.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        });
    }

    class Search {
        static numEntries = 1;
        constructor(regex) {
            this.id = Search.numEntries++;
            this._regex = regex || "";
            this._symbolLocations = new Map();
            this.error = "";
            this.allMatches = [];
            this.symbols = [];
            this.groups = undefined;
            this.debounceTimer = null;
            this.tempValue = regex || "";
        }

        set regex(value) {
            this._regex = value;
            let error = "";
            let allMatches = new Set();
            // Map<Group, Map<Value, Set<Plugin>>>
            let groups = new AutoMap(() => new AutoMap(() => new Set()));
            let symbols = [];
            if (value != "" && value != "^")
            {
                try {
                    let re = new RegExp(value);
                    let symbolLocations = app.symbolLocations || new Map();
                    for (let [sym, locations] of symbolLocations) {
                        let match = re.exec(sym);
                        if (match) {
                            if (locations.length > 0) {
                                for (let loc of locations) {
                                    symbols.push(Object.freeze({
                                        text: sym,
                                        plugin: loc.plugin,
                                        file: loc.file,
                                        line: loc.line,
                                    }));
                                    allMatches.add(loc.plugin);
                                }
                            }
                        }
                    }

                } catch (e) {
                    console.error(e);
                    error = e + "";
                }
            }

            this.error = error;
            this.allMatches = Object.freeze(sortPlugins([...allMatches]));
            this.symbols = Object.freeze(symbols);
            if (groups.size > 0) {
                groups = [...groups.entries()].map(([name, group]) => {
                    group = [...group.entries()].map(([name, plugins]) => {
                        plugins = sortPlugins([...plugins]);
                        return Object.freeze([name, Object.freeze(plugins)]);
                    })
                    group.sort(([, a], [, b]) => b.length - a.length)
                    return Object.freeze([name, Object.freeze(group)]);
                });
                groups.sort(([, a], [, b]) => b.length - a.length);
                this.groups = Object.freeze(groups);
            } else {
                this.groups = undefined;
            }
        }
        get regex() {
            return this._regex;
        }

        static component = {
            props: ["entry"],
            components: {List},
            methods: {
                getInstalls(name) {
                    return installMap[name] || "";
                },
                handleInput(value) {
                    this.entry.tempValue = value;
                    if (this.entry.debounceTimer) {
                        clearTimeout(this.entry.debounceTimer);
                    }
                    this.entry.debounceTimer = setTimeout(() => {
                        this.entry.regex = value;
                        this.entry.debounceTimer = null;
                    }, 500);
                },
                handleKeydown(event) {
                    if (event.key === "Enter") {
                        if (this.entry.debounceTimer) {
                            clearTimeout(this.entry.debounceTimer);
                            this.entry.debounceTimer = null;
                        }
                        this.entry.regex = this.entry.tempValue;
                    }
                },
                async openLine(item) {
                    try {
                        let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${item.plugin}`);
                        let text = await req.text();
                        let prop = {};
                        for (let line of text.split("\n")) {
                            let kv = line.split("=", 2);
                            if (kv.length == 2) prop[kv[0]] = kv[1];
                        }
                        const repo = (prop.repository || "").replace(/\.git$/, "");
                        const commit = prop.commit || "";
                        if (item && item.file) {
                            const safeFile = item.file.replace(/^\/+/, "");
                            const lineNumber = item.line || 1;
                            window.open(`${repo}/tree/${commit}/${safeFile}#L${lineNumber}`);
                        } else {
                            window.open(`${repo}/tree/${commit}`);
                        }
                    } catch (e) {
                        console.error(e);
                    }
                }
            },
            template: `
<div class="search">
	<input :value="entry.tempValue" @input="handleInput($event.target.value)" @keydown="handleKeydown" placeholder="Toa Keris Cam" @focus="entry.focused=true" @blur="entry.focused=false">
	<div v-if="entry.error" class="error">{{entry.error}}</div>
	<div v-if="!entry.error">
		<List v-if="entry.groups" v-for="grouping of entry.groups" :list="grouping[1]" :name="'groups by ' + grouping[0]" :active="true" v-slot="{item}">
			<List :list="item[1]" :name="item[0]" v-slot="{item}">
				<span class="plugin" :data-name="item">{{item}} <span class="noselect">({{getInstalls(item)}})</span></span>
			</List>
		</List>
		<List :list="entry.allMatches" :active="!entry.groups" name="plugins" v-slot="{item}">
			<span class="plugin" :data-name="item">{{item}} <span class="noselect">({{getInstalls(item)}})</span></span>
		</List>
			<List :list="entry.symbols" name="lines of text" v-slot="{item}">
				<a href="#" @click.prevent="openLine(item)"><code>{{item.text}}</code></a>
				--- <span class="plugin" :data-name="item.plugin">{{item.plugin}}</span>
			</List>
	</div>
</div>
`,
        }
    }

    const app = Vue.createApp({
        data() {
            let entries;
            try {
                let hash = window.location.hash;
                if (hash)
                {
                    if (hash.startsWith("#search?str="))
                    {
                        entries = [new Search(hash.substr("#search?str=".length))];
                    }
                    else if (hash.startsWith("#"))
                    {
                        hash = hash.substr(1);
                        hash = atob(hash);
                        hash = JSON.parse(hash);
                        entries = hash.map(v => new Search(v));
                    }
                }
            } catch (e) {
                console.log("loading hash:", e);
            }
            return {
                entries: entries || [new Search("Toa Keris Cam")],
                lastUpdated: "Loading...",
                progress: {
                    phase: "fetch",
                    current: 0,
                    total: 0,
                    loading: true
                }
            }
        },
        template: `
<div class="content">
	<div v-if="progress.loading">
		{{ progressLabel }}: {{ progress.current }}/{{ progress.total }}
	</div>
	<Search v-for="entry of entries" :key="entry.id" :entry="entry"></Search>
</div>
<footer class="footer">
<a href="https://github.com/JZomDev/pluginhub-searcher/commits/main">Last updated: {{lastUpdated}}</a>
</footer>
`,
        components: {
            Search: Search.component,
        },
        created() {
            this.$watch("entries", () => {
                history.replaceState(undefined, undefined, "#" + btoa(JSON.stringify(this.entries.map(s => s.regex))));

                if (this.entries.length == 0 || this.entries[this.entries.length - 1].regex != "") {
                    this.entries.push(new Search());
                }
                for (let i = this.entries.length - 2; i >= 0; i--) {
                    if (this.entries[i].regex == "" && !this.entries[i].focused) {
                        this.entries.splice(i, 1);
                    }
                }
            }, {deep: true});
        },
        watch: {
        },
        computed: {
            progressLabel() {
                switch (this.progress.phase) {
                    case "fetch": return "Downloading plugin data (files)";
                    case "unzip": return "Decompressing plugin data (files)";
                    case "index": return "Building search index (plugins)";
                    default: return "Loading";
                }
            },
        },
        methods: {
        },
    }).mount("#app");

    // Phase 1 (fetch) + Phase 2 (unzip) + Phase 3 (index): download, decompress, and
    // build the searchable regex map from the plugin data bundle. Indexing happens
    // incrementally inside loadPluginBundle via the onIndexed callback.
    // Using AutoMap to speed up symbol location lookups during indexing.
    const symbolLocations = new AutoMap(() => []);
    let indexedCount = 0;
    const bundle = await loadPluginBundle({
        onFetchStart: (n) => { app.progress.phase = "fetch"; app.progress.current = 0; app.progress.total = n; },
        onFetch: (n) => { app.progress.current = n; },
        onUnzipStart: (n) => { app.progress.phase = "unzip"; app.progress.current = 0; app.progress.total = n; },
        onUnzip: (n) => { app.progress.current = n; },
        onIndexed: (internalName, contents, plugin) => {
            if (app.progress.phase !== "index") {
                app.progress.phase = "index";
                app.progress.current = 0;
                app.progress.total = mf.jars.length;
            }
            app.progress.current = ++indexedCount;
            _indexPlugin(plugin.internalName, contents, symbolLocations);
        }
    });

    // Finish progress reporting
    app.progress.current = mf.jars.length;
    app.progress.phase = "done";
    app.progress.loading = false;
    app.symbolLocations = symbolLocations;
    app.indexedCount = symbolLocations.size;
    console.log(`Indexed ${symbolLocations.size} symbols from ${mf.jars.length} plugins`);

    // Trigger regex setter on all initial searches to populate results
    for (let entry of app.entries) {
        entry.regex = entry._regex;
    }

    try {
        app.lastUpdated = await getPluginsLastUpdated();
    } catch (e) {
        console.error(e);
        app.lastUpdated = "Unknown";
    }
})().catch(e => console.error(e));
