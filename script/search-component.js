const SearchComponent = {
    props: ["entry", "installCounts"],
    data() {
        return {
            showPlugins: true,
            showLines: false,
        };
    },
    computed: {
        pluginCount() {
            const plugins = new Set(this.entry.symbols.map(s => s.plugin));
            return plugins.size;
        },
        lineCount() {
            return this.entry.symbols.length;
        },
        groupedSymbols() {
            const groups = {};
            for (const symbol of this.entry.symbols) {
                if (!groups[symbol.file]) {
                    groups[symbol.file] = { pluginName: symbol.plugin, items: [] };
                }
                groups[symbol.file].items.push(symbol);
            }
            return groups;
        },
        allSymbols() {
            const list = [...this.entry.symbols];
            list.sort((a, b) => (this.installCounts[b.plugin] || 0) - (this.installCounts[a.plugin] || 0));
            return list;
        },
        groupedPlugins() {
            const groups = {};
            for (const symbol of this.entry.symbols) {
                const p = symbol.plugin;
                if (!groups[p]) {
                    groups[p] = { pluginName: p, count: 0 };
                }
                groups[p].count++;
            }
            return groups;
        },
        groupedPluginList() {
            const list = Object.values(this.groupedPlugins);
            list.sort((a, b) => (this.installCounts[b.pluginName] || 0) - (this.installCounts[a.pluginName] || 0));
            return list;
        },
    },
    methods: {
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
        },
        handleKeydown(event) {
            if (event.key === "Enter") {
                clearTimeout(this.entry._debounceTimer);
                this.entry._debounceTimer = null;
                this.entry.regex = this.entry.tempValue;
            }
        },
        handleInput(value) {
            this.entry.tempValue = value;
            if (this.entry._debounceTimer) {
                clearTimeout(this.entry._debounceTimer);
            }
            this.entry._debounceTimer = setTimeout(() => {
                this.entry.regex = value;
                this.entry._debounceTimer = null;
            }, 500);
        },
        getPluginName(filename) {
            return filename.split('/').pop().replace('.jar', '');
        },
        getInstalls(pluginName) {
            const count = this.installCounts[pluginName];
            return count != null ? + count : 0;
        },
        async openPlugin(pluginName) {
            let req = await fetch(`https://raw.githubusercontent.com/runelite/plugin-hub/master/plugins/${pluginName}`);
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
    },
    template: `
<div class="search">
    <input :value="entry.tempValue"
           @input="handleInput($event.target.value); entry.tempValue=$event.target.value"
           @keydown="handleKeydown"
           @blur="entry.focused=false;"
           placeholder="Toa Keris Cam"
           @focus="entry.focused=true">

    <div v-if="entry.error" class="error">{{entry.error}}</div>
    <div v-if="!entry.error && entry.symbols.length > 0">
        <div class="result-summary">
            <div class="plugin-count" style="cursor: pointer;" @click="showPlugins = !showPlugins">
                {{ showPlugins ? '−' : '+' }} {{pluginCount}} plugins
            </div>
            <div v-if="showPlugins" class="symbol-list">
                <div v-for="(plugin, index) in groupedPluginList" :key="plugin.pluginName" class="plugin-entry" :style="{ backgroundColor: index % 2 === 1 ? '#f0f0f0' : 'transparent' }">
                    <a href @click.prevent="openPlugin(plugin.pluginName)">{{plugin.pluginName}}</a> ({{ getInstalls(plugin.pluginName) }})
                </div>
            </div>
            <div class="line-count" style="cursor: pointer;" @click="showLines = !showLines">
                {{ showLines ? '−' : '+' }} {{lineCount}} lines of text
            </div>
            <div v-if="showLines" class="symbol-list">
                <div v-for="(symbol, index) in allSymbols.slice(0, 5000)" :key="'l' + index" class="line-item" :style="{ backgroundColor: index % 2 === 1 ? '#f0f0f0' : 'transparent' }">
                    <a href="#" @click.prevent="openLine(symbol)">
                        {{symbol.lineText}} --- {{symbol.plugin}}
                    </a>
                </div>
                <div v-if="allSymbols.length > 5000" class="summary-footer">
                    {{ allSymbols.length }} total results (showing 5000)
                </div>
            </div>
        </div>
    </div>
</div>
`,
};

export { SearchComponent };
