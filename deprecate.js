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
async function readPluginApi(manifest) {
	fileContent.set(manifest.internalName, [])

	let text = [];

	let result = await getConent('JZomDev', 'pluginhub-searcher', manifest.internalName);
		
	for (let i = 0; i < fileContent.get(manifest.internalName).length; i++)
	{
		text = text.concat(fileContent.get(manifest.internalName)[i].split("\n"));
	}
	return text;
}

async function getConent(user, repo, internalName, files) {
    const fetchCache = getConent._cache ||= new Map();

    // bucket where results for this plugin are stored
    if (!fileContent.has(internalName)) fileContent.set(internalName, []);
    const bucket = fileContent.get(internalName);

    // allow passing a list of file paths; fall back to single content.txt
    const urls = (Array.isArray(files) && files.length)
        ? files.map(p => p)
        : [`plugins/${internalName}/content.txt`];

    // limit concurrent network requests (uses existing amap)
    await amap(12, urls, async (url) => {
        const key = url;
        let promise = fetchCache.get(key);
        if (!promise) {
            promise = fetch(key, { cache: "force-cache" })
                .then(res => res.ok ? res.text() : "")
                .catch(() => "");
            fetchCache.set(key, promise);
        }
        const text = await promise;
        bucket.push(text);
        return true;
    });

    return true;
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

const byUsage = (async() => {
	let out = new Map();
	await amap(64, (await manifest).jars, async (plugin) => {
		let api = await readPluginApi(plugin);
		for (let k of api) {
			if (k == "") {
				continue
			}
			let ps = out.get(k);
			if (!ps) {
				out.set(k, ps = [])
			}
			ps.push(plugin.internalName);
		}
	});
	let es = [...out.entries()];
	es.sort(([a], [b]) => a.localeCompare(b));
	return es
})();

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
	const sd = new Date();
	let mf = await manifest;

	let usages = await byUsage;
	let installMap = await installs;
	const differenceInMs = new Date() - sd;

	console.log(`Loaded manifest v${mf.version} with ${mf.jars.length} plugins and ${usages.length} symbols in ${differenceInMs}ms`);
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
		<li v-for="item of list">
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
	
	class Search {
		static numEntries = 1;
		constructor(regex) {
			this.id = Search.numEntries++;
			this.regex = regex || "";
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
					for (let [sym, plugins] of usages) {
						let match = re.exec(sym);
						if (match) {
							symbols.push(sym + " --- " + plugins[0]);
							for (let plugin of plugins) {
								allMatches.add(plugin)
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
				}
			},
			template: `
<div class="search">
	<input v-model="entry.regex" placeholder="Toa Keris Cam" @focus="entry.focused=true" @blur="entry.focused=false">
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
			<code>{{item}}</code>
		</List>
	</div>
</div>
`,
		}
	}

	Vue.createApp({
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
			}
		},
		template: `
<Search v-for="entry of entries" :key="entry.id" :entry="entry"></Search>
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
		},
		methods: {
		},
	}).mount("#app");
})().catch(e => console.error(e));
