const version = (async() => {
	let req = await fetch("https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version");
	let version = await req.text();
	return version.trim();
})();

const root = "https://repo.runelite.net/plugins/"

const manifest = (async() => {
	let req = await fetch(`${root}manifest/${await version}_full.js`);
	let buf = new DataView(await req.arrayBuffer());
	let skip = 4 + buf.getUint32(0);
	let text = new TextDecoder("utf-8").decode(new Uint8Array(buf.buffer.slice(skip)));
	return JSON.parse(text);
})();

const installs = (async() => {
	let req = await fetch(`https://api.runelite.net/runelite-${await version}/pluginhub`);
	return await req.json();
})();
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

// Fetch a JSON resource that may be gzip-compressed (.gz).
async function fetchJson(url) {
	const res = await fetch(url);
	if (!res.ok) return null;
	const buf = await res.arrayBuffer();
	return decodeJson(buf);
}

async function readPluginApi(manifest) {
	let text = [];

	await getContent('JZomDev', 'pluginhub-searcher', manifest.internalName);
	const files = fileContent.get(manifest.internalName) || [];
	const lines = [];
	for (let f of files) {
		let filePath = null;
		let content = "";
		if (!f) continue;
		if (typeof f === "string") {
			filePath = f;
			content = "";
		} else {
			filePath = f.filePath || f.fileName || null;
			content = f.content || "";
		}
		const parts = content.split("\n");
		for (let i = 0; i < parts.length; i++) {
			lines.push({text: parts[i], file: filePath, line: i + 1});
		}
	}
	return lines;
}

// Load the full plugin data bundle in two observable phases:
//   1. fetch  — download each (possibly split) data file over the network
//   2. unzip  — decompress + JSON-parse each downloaded file
// The optional progress callbacks let the UI show which phase is running and how
// far along it is. Returns a map of internalName -> [{filePath, content}, ...].
async function loadPluginBundle({onFetchStart, onFetch, onUnzipStart, onUnzip} = {}) {
	// Resolve the list of data files. Split lists (plugins/plugins_splits.json)
	// name an array of parts (e.g. ["plugins_0.json.gz", ...]); otherwise fall
	// back to a single plugins.json.
	let fileNames = null;
	try {
		const splitsRes = await fetch("plugins/plugins_splits.json");
		if (splitsRes.ok) {
			const splits = await splitsRes.json();
			if (Array.isArray(splits)) fileNames = splits.filter(Boolean);
		}
	} catch (e) {
		// fall through to single-file fallback
	}
	if (!fileNames || fileNames.length === 0) {
		fileNames = ["plugins.json"];
	}

	// Phase 1 (fetch): download raw bytes for every file, reporting progress as
	// each one lands. .map preserves order so the merge below is deterministic.
	if (onFetchStart) onFetchStart(fileNames.length);
	let fetched = 0;
	const buffers = await Promise.all(fileNames.map(async (name) => {
		try {
			const res = await fetch(`plugins/${name}`);
			if (!res.ok) return null;
			return await res.arrayBuffer();
		} catch (e) {
			// ignore individual part failures
			return null;
		} finally {
			if (onFetch) onFetch(++fetched);
		}
	}));

	// Phase 2 (unzip): decompress + parse every downloaded file, reporting progress.
	if (onUnzipStart) onUnzipStart(buffers.length);
	let unzipped = 0;
	const parts = await Promise.all(buffers.map(async (buf) => {
		try {
			if (!buf) return null;
			const part = await decodeJson(buf);
			return Array.isArray(part) ? part : null;
		} catch (e) {
			return null;
		} finally {
			if (onUnzip) onUnzip(++unzipped);
		}
	}));

	// Merge parts in order and index by internalName (same shape as before).
	const map = Object.create(null);
	for (const part of parts) {
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
					if (typeof f === "string") {
						contents.push({filePath: f, content: null});
					} else {
						contents.push({filePath: f.filePath || f.fileName || null, content: f.content || null});
					}
				}
			}
			map[p.internalName] = contents;
		}
	}
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

async function amap(limit, array, asyncMapper) {
	let out = new Array(array.length);
	let todo = new Array(array.length).fill(0).map((_, i) => i);
	await Promise.all(new Array(limit).fill(0).map(async () => {
		for (; todo.length > 0; ) {
			let i = todo.pop();
			out[i] = await asyncMapper(array[i]);
		}
	}));
	return out;
}

async function buildIndex(manifest, onProgress = () => {}) {
	const symbolLocations = new Map();
	let out = new Map();
	let indexedCount = 0;
	await amap(64, manifest.jars, async (plugin) => {
		let api = await readPluginApi(plugin);
		for (let lineObj of api) {
			let k = lineObj.text;
			if (k == "") {
				continue;
			}
			let ps = out.get(k);
			if (!ps) {
				out.set(k, ps = [])
			}
			ps.push(plugin.internalName);

			let locs = symbolLocations.get(k);
			if (!locs) {
				symbolLocations.set(k, locs = []);
			}
			locs.push({plugin: plugin.internalName, file: lineObj.file, line: lineObj.line});
		}
		indexedCount++;
		if (indexedCount % 10 === 0) {
			onProgress(indexedCount);
		}
	});
	let es = [...out.entries()];
	es.sort(([a], [b]) => a.localeCompare(b));
	// expose symbolLocations for later use in UI
	es.symbolLocations = symbolLocations;
	return es
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

(async () => {
	let mf = await manifest;
	let installMap = await installs;
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
		let files = [];
		try {
			const splitsRes = await fetch("plugins/plugins_splits.json");
			if (splitsRes.ok) {
				const splits = await splitsRes.json();
				if (Array.isArray(splits)) {
					files = splits.filter(Boolean);
				}
			}
		} catch (e) {
			// ignore and fall back
		}

		if (files.length === 0) {
			files = ["plugins.json"];
		}

		const dates = await Promise.all(files.map(async (name) => {
			try {
				const res = await fetch(`plugins/${name}`, { method: "HEAD" });
				if (!res.ok) return null;
				const lastModified = res.headers.get("Last-Modified");
				if (!lastModified) return null;
				const dt = new Date(lastModified);
				return isNaN(dt) ? null : dt;
			} catch (e) {
				return null;
			}
		}));

		const latest = dates.filter(Boolean).sort((a, b) => b - a)[0];
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
					// Handle case where app.usages might not be initialized yet
					let usagesToSearch = (typeof app !== 'undefined' && app.usages) ? app.usages : [];
					let symbolLocations = usagesToSearch.symbolLocations || new Map();
					for (let [sym, plugins] of usagesToSearch) {
						let match = re.exec(sym);
						if (match) {
							let locations = (symbolLocations && symbolLocations.get(sym)) || [];
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
							} else {
								for (let plugin of plugins) {
									symbols.push(Object.freeze({text: sym, plugin}));
									allMatches.add(plugin);
								}
							}
							if (match.groups) {
								for (let group in match.groups) {
									let groupMatches = groups.get(group).get(match.groups[group]);
									for (let plugin of plugins) {
										groupMatches.add(plugin)
									}
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
				hash = hash.substr(1);
				hash = atob(hash);
				hash = JSON.parse(hash);
				entries = hash.map(v => new Search(v));
			} catch (e) {
				console.log("loading hash:", e);
			}
			return {
				entries: entries || [new Search("Toa Keris Cam")],
				lastUpdated: "Loading...",
				usages: [],
				progress: {
					phase: "fetch",
					current: 0,
					total: 0,
					indexing: true
				}
			}
		},
		template: `
<div class="content">
	<div v-if="progress.indexing">
		{{ progressLabel }}: {{ progress.current }}/{{ progress.total }}
	</div>
	<Search v-for="entry of entries" :key="entry.id" :entry="entry"></Search>
</div>
<footer class="footer">Last updated: {{lastUpdated}}</footer>
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

	// Phase 1 (fetch) + Phase 2 (unzip): download and decompress the plugin data
	// bundle, driving the progress UI through each phase as files complete.
	const bundle = await loadPluginBundle({
		onFetchStart: (n) => { app.progress.phase = "fetch"; app.progress.current = 0; app.progress.total = n; },
		onFetch: (n) => { app.progress.current = n; },
		onUnzipStart: (n) => { app.progress.phase = "unzip"; app.progress.current = 0; app.progress.total = n; },
		onUnzip: (n) => { app.progress.current = n; },
	});
	// Share the already-loaded bundle with getContent so buildIndex won't refetch.
	getContent._bundle = bundle;
	getContent._bundlePromise = Promise.resolve();

	// Phase 3 (index): build the searchable regex map from the decompressed content.
	app.progress.phase = "index";
	app.progress.current = 0;
	app.progress.total = mf.jars.length;
	const sd2 = new Date();
	let indexedUsages = await buildIndex(mf, (count) => {
		app.progress.current = count;
	});
	app.usages = indexedUsages;
	let symbolLocations = indexedUsages.symbolLocations || new Map();
	const differenceInMs = new Date() - sd2;
	console.log(`Indexed ${indexedUsages.length} symbols from ${mf.jars.length} plugins in ${differenceInMs}ms`);
	app.progress.current = mf.jars.length;
	app.progress.phase = "done";
	app.progress.indexing = false;

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
