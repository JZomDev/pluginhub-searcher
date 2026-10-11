(function () {
    'use strict';

    const INDEX_URL = new URL('plugins/index/', document.baseURI);
    const MAX_RESULTS = 5000;
    const entriesElement = document.getElementById('entries');
    const regexElement = document.getElementById('regex');
    const caseSensitiveElement = document.getElementById('case-sensitive');
    const indexStatusElement = document.getElementById('index-status');
    const pluginCountElement = document.getElementById('plugin-count');
    const searcher = new window.ReverseSearchBrowser.BrowserReverseSearcher(INDEX_URL.href);
    const indexReady = searcher.load();
    let prefetchStarted = false;
    let installCounts = {};
    let isRegex = regexElement.checked;
    let caseSensitive = caseSensitiveElement.checked;
    let nextEntryId = 1;

    function repositoryUrl(repository, suffix = '') {
        if (!repository) return null;
        try {
            const url = new URL(repository.replace(/\.git$/i, ''));
            if (url.protocol !== 'https:') return null;
            url.search = '';
            url.hash = '';
            url.pathname = `${url.pathname.replace(/\/+$/, '')}${suffix}`;
            return url.href;
        } catch {
            return null;
        }
    }

    function sourceUrl(result) {
        if (!result.commit || !result.filePath) return null;
        const safePath = result.filePath.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
        const url = repositoryUrl(result.repository, `/tree/${encodeURIComponent(result.commit)}/${safePath}`);
        if (!url) return null;
        const permalink = new URL(url);
        permalink.hash = `L${result.line}`;
        return permalink.href;
    }

    async function loadInstallCounts() {
        const versionResponse = await fetch('https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version');
        if (!versionResponse.ok) throw new Error(`Could not load RuneLite version: HTTP ${versionResponse.status}`);
        const version = (await versionResponse.text()).trim();
        if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error('Invalid RuneLite version');
        const response = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
        if (!response.ok) throw new Error(`Could not load plugin install counts: HTTP ${response.status}`);
        const counts = await response.json();
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid plugin install-count data');
        return counts;
    }

    function saveQueries() {
        const values = [...entriesElement.querySelectorAll('.search-input')].map(input => input.value);
        history.replaceState(undefined, '', `#${btoa(unescape(encodeURIComponent(JSON.stringify(values))))}`);
    }

    function createEntry(initialQuery = '') {
        const id = nextEntryId++;
        const container = document.createElement('section');
        container.className = 'search';
        container.dataset.entryId = id;

        const input = document.createElement('input');
        input.className = 'search-input';
        input.type = 'text';
        input.placeholder = 'Toa Keris Cam';
        input.value = initialQuery;
        input.setAttribute('aria-label', 'Search source code');

        const error = document.createElement('div');
        error.className = 'error';
        error.hidden = true;

        const summary = document.createElement('div');
        summary.className = 'result-summary';
        summary.hidden = true;

        const pluginCount = document.createElement('div');
        pluginCount.className = 'plugin-count noselect';
        pluginCount.tabIndex = 0;
        pluginCount.setAttribute('role', 'button');
        pluginCount.setAttribute('aria-expanded', 'true');

        const pluginList = document.createElement('div');
        pluginList.className = 'symbol-list';

        const lineCount = document.createElement('div');
        lineCount.className = 'line-count noselect';
        lineCount.tabIndex = 0;
        lineCount.setAttribute('role', 'button');
        lineCount.setAttribute('aria-expanded', 'false');

        const lineList = document.createElement('div');
        lineList.className = 'symbol-list';
        lineList.hidden = true;

        summary.append(pluginCount, pluginList, lineCount, lineList);
        container.append(input, error, summary);
        entriesElement.append(container);

        const entry = {
            id,
            container,
            input,
            error,
            summary,
            pluginCount,
            pluginList,
            lineCount,
            lineList,
            timer: null,
            request: 0,
            abort: null,
            searching: false,
            results: [],
            lineTotal: 0,
            plugins: []
        };
        container._searchEntry = entry;

        const search = () => {
            clearTimeout(entry.timer);
            entry.timer = null;
            if (input.value.trim()) performSearch(entry);
            saveQueries();
        };

        input.addEventListener('input', () => {
            clearTimeout(entry.timer);
            if (!input.value.trim()) {
                if (entry.container !== entriesElement.lastElementChild) {
                    entry.container.remove();
                } else {
                    entry.abort?.abort();
                    entry.request++;
                    entry.searching = false;
                    applyResults(entry, { results: [], lineCount: 0, plugins: [] });
                    renderEntry(entry);
                }
                saveQueries();
                return;
            }
            if (entry.container === entriesElement.lastElementChild) createEntry('');
            entry.timer = setTimeout(search, 500);
        });
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') search();
        });
        input.addEventListener('blur', saveQueries);
        pluginCount.addEventListener('click', () => toggleDisclosure(entry, 'plugins'));
        pluginCount.addEventListener('keydown', event => disclosureKeydown(event, entry, 'plugins'));
        lineCount.addEventListener('click', () => toggleDisclosure(entry, 'lines'));
        lineCount.addEventListener('keydown', event => disclosureKeydown(event, entry, 'lines'));

        entry.initialSearch = initialQuery ? performSearch(entry) : Promise.resolve();
        return entry;
    }

    function disclosureKeydown(event, entry, type) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleDisclosure(entry, type);
        }
    }

    function toggleDisclosure(entry, type) {
        const header = type === 'plugins' ? entry.pluginCount : entry.lineCount;
        const expanded = header.getAttribute('aria-expanded') === 'true';
        header.setAttribute('aria-expanded', String(!expanded));
        (type === 'plugins' ? entry.pluginList : entry.lineList).hidden = expanded;
        if (type === 'lines' && !expanded) renderLines(entry);
        renderCounts(entry);
    }

    function renderCounts(entry) {
        const pluginsExpanded = entry.pluginCount.getAttribute('aria-expanded') === 'true';
        const linesExpanded = entry.lineCount.getAttribute('aria-expanded') === 'true';
        const searching = entry.searching ? ' (searching…)' : '';
        entry.pluginCount.textContent = `${pluginsExpanded ? '−' : '+'} ${entry.plugins.length.toLocaleString()} plugins${searching}`;
        entry.lineCount.textContent = `${linesExpanded ? '−' : '+'} ${entry.lineTotal.toLocaleString()} lines of text${searching}`;
    }

    function installs(plugin) {
        return Number(installCounts[plugin]) || 0;
    }

    function renderEntry(entry) {
        const results = entry.results;
        const plugins = [...entry.plugins].sort((left, right) =>
            installs(right.plugin) - installs(left.plugin) || left.plugin.localeCompare(right.plugin));
        const pluginsExpanded = entry.pluginCount.getAttribute('aria-expanded') !== 'false';
        const linesExpanded = entry.lineCount.getAttribute('aria-expanded') === 'true';
        entry.summary.hidden = entry.lineTotal === 0 && !entry.searching;
        entry.pluginCount.setAttribute('aria-expanded', String(pluginsExpanded));
        entry.pluginList.hidden = !pluginsExpanded;
        entry.lineCount.setAttribute('aria-expanded', String(linesExpanded));
        entry.lineList.hidden = !linesExpanded;
        renderCounts(entry);

        entry.pluginList.replaceChildren();
        for (const [pluginIndex, { plugin, repository, commit }] of plugins.entries()) {
            const item = document.createElement('div');
            item.className = 'plugin-entry';
            if (pluginIndex % 2 === 1) item.style.backgroundColor = '#f0f0f0';
            const link = document.createElement('a');
            link.textContent = plugin;
            const url = repositoryUrl(repository, commit ? `/tree/${encodeURIComponent(commit)}` : '');
            if (url) {
                link.href = url;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            }
            const count = document.createElement('span');
            count.textContent = ` (${installs(plugin).toLocaleString()})`;
            item.append(link, count);
            entry.pluginList.append(item);
        }

        renderLines(entry);
    }

    // Line rows are only built while the (initially collapsed) list is open.
    function renderLines(entry) {
        const results = entry.results;
        entry.lineList.replaceChildren();
        if (entry.lineList.hidden) return;
        const fragment = document.createDocumentFragment();
        const sortedResults = [...results].sort((left, right) => installs(right.plugin) - installs(left.plugin));
        for (const [index, result] of sortedResults.entries()) {
            const item = document.createElement('div');
            item.className = 'line-item';
            if (index % 2 === 1) item.style.backgroundColor = '#f0f0f0';
            const link = document.createElement('a');
            const url = sourceUrl(result);
            link.href = url || '#';
            link.textContent = `${result.content} --- ${result.plugin}`;
            if (url) {
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
            } else {
                link.addEventListener('click', event => event.preventDefault());
            }
            item.append(link);
            fragment.append(item);
        }
        entry.lineList.append(fragment);
        if (entry.lineTotal > results.length) {
            const overflow = document.createElement('div');
            overflow.className = 'summary-footer';
            overflow.textContent = `${entry.lineTotal.toLocaleString()} total results (showing ${results.length.toLocaleString()})`;
            entry.lineList.append(overflow);
        }
    }

    function applyResults(entry, { results, lineCount, plugins }) {
        entry.results = results;
        entry.lineTotal = lineCount;
        entry.plugins = plugins;
    }

    async function performSearch(entry) {
        const value = entry.input.value.trim();
        if (!value) return;
        const request = ++entry.request;
        entry.abort?.abort();
        const controller = entry.abort = new AbortController();
        entry.error.hidden = true;
        try {
            await indexReady;
            if (request !== entry.request) return;
            entry.searching = true;
            applyResults(entry, { results: [], lineCount: 0, plugins: [] });
            renderEntry(entry);
            const found = await searcher.search(value, {
                caseSensitive,
                isRegex,
                limit: MAX_RESULTS,
                priority: installs,
                signal: controller.signal
            });
            if (request !== entry.request) return;
            entry.searching = false;
            applyResults(entry, found);
            renderEntry(entry);
            saveQueries();
        } catch (error) {
            if (request !== entry.request) return;
            entry.searching = false;
            applyResults(entry, { results: [], lineCount: 0, plugins: [] });
            entry.error.textContent = error.message;
            entry.error.hidden = false;
            renderEntry(entry);
        }
    }

    function startPrefetch() {
        if (prefetchStarted) return;
        prefetchStarted = true;
        searcher.prefetch((done, total, failed) => {
            if (done < total) indexStatusElement.textContent = `Loading index: ${Math.floor(done / total * 100)}%`;
            else if (failed) indexStatusElement.textContent = `Index loaded except ${failed} files (they load when a search needs them)`;
            else indexStatusElement.textContent = 'Index loaded';
        });
    }

    async function loadInstallCounts() {
        const versionResponse = await fetch('https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version');
        if (!versionResponse.ok) throw new Error(`Could not load RuneLite version: HTTP ${versionResponse.status}`);
        const version = (await versionResponse.text()).trim();
        if (!/^\d+(?:\.\d+)+$/.test(version)) throw new Error('Invalid RuneLite version');
        const response = await fetch(`https://api.runelite.net/runelite-${version}/pluginhub`);
        if (!response.ok) throw new Error(`Could not load install counts: HTTP ${response.status}`);
        const counts = await response.json();
        if (!counts || typeof counts !== 'object' || Array.isArray(counts)) throw new Error('Invalid install-count data');
        return counts;
    }

    function decodeHashText(text) {
        try {
            return decodeURIComponent(text);
        } catch {
            return text;
        }
    }

    function restoreQueries() {
        if (location.hash.startsWith('#search?str=')) {
            return [decodeHashText(location.hash.slice('#search?str='.length))];
        }
        try {
            if (location.hash.length > 1) {
                const decoded = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
                if (Array.isArray(decoded) && decoded.every(value => typeof value === 'string')) return decoded;
            }
        } catch {
            return [];
        }
        return [];
    }

    function showQueries(queries) {
        for (const entry of entriesElement.children) entry._searchEntry.abort?.abort();
        entriesElement.replaceChildren();
        for (const value of queries) createEntry(value);
        if (!queries.length || queries[queries.length - 1].trim()) createEntry('');
        saveQueries();
    }

    // Search boxes appear (and their searches start) right away; searches
    // wait for the index manifest internally.
    function start() {
        loadInstallCounts().then(counts => {
            installCounts = counts;
            for (const entry of entriesElement.children) renderEntry(entry._searchEntry);
        }).catch(error => console.warn('Install counts unavailable:', error));
        const restored = restoreQueries();
        showQueries(restored.length ? restored : ['Toa Keris Cam']);
        const initialSearches = [...entriesElement.children].map(element => element._searchEntry.initialSearch);
        // The rest of the index downloads only after the page's own queries finish.
        indexReady.then(() => {
            pluginCountElement.textContent = ` Currently ${searcher.manifest.plugins.length.toLocaleString()} plugins active.`;
            return Promise.allSettled(initialSearches).then(startPrefetch);
        }).catch(error => {
            const entry = entriesElement.firstElementChild._searchEntry;
            indexStatusElement.textContent = 'Index failed to load';
            entry.error.textContent = `Unable to load search index: ${error.message}`;
            entry.error.hidden = false;
        });
    }

    window.addEventListener('hashchange', () => {
        const restored = restoreQueries();
        if (restored.length) showQueries(restored);
    });
    regexElement.addEventListener('change', () => {
        isRegex = regexElement.checked;
        for (const entry of entriesElement.children) performSearch(entry._searchEntry);
    });
    caseSensitiveElement.addEventListener('change', () => {
        caseSensitive = caseSensitiveElement.checked;
        for (const entry of entriesElement.children) performSearch(entry._searchEntry);
    });
    start();

})();
