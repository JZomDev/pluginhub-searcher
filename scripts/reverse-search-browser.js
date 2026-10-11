(function (root) {
    'use strict';

    // Must match build_reverse_index.py.
    const FORMAT_VERSION = 2;
    const FETCH_CONCURRENCY = 12;
    const PREFETCH_CONCURRENCY = 4;
    // Dropped connections (simple servers such as `python3 -m http.server`
    // refuse them under parallel load) and 5xx responses are retried for ~7s,
    // so a search only fails for a real error, never for a slow file.
    const FETCH_RETRY_DELAYS_MS = [100, 400, 1000, 2000, 3500];
    // Decoded chunks are re-created from the compressed copies kept in memory.
    const CHUNK_CACHE_CHARS = 64 * 1024 * 1024;
    const SHARD_CACHE_ENTRIES = 256;
    const textEncoder = new TextEncoder();
    const textDecoder = new TextDecoder();

    function shardOf(gram, shardCount) {
        let value = 0x811c9dc5;
        for (const byte of gram) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
        return value % shardCount;
    }

    function gramKey(bytes, offset) {
        return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
    }

    // Trigrams of the lowercased literals. Only all-ASCII trigrams are used so
    // that JS and Python case folding can never disagree.
    function literalGrams(literals) {
        const grams = new Map();
        for (const literal of literals) {
            const bytes = textEncoder.encode(literal.toLowerCase());
            for (let offset = 0; offset + 3 <= bytes.length; offset++) {
                if ((bytes[offset] | bytes[offset + 1] | bytes[offset + 2]) & 0x80) continue;
                grams.set(gramKey(bytes, offset), bytes.slice(offset, offset + 3));
            }
        }
        return grams;
    }

    // Index of the `]` closing the character class opened at `index`.
    function skipClass(source, index) {
        index++;
        if (source[index] === '^') index++;
        if (source[index] === ']') index++;
        for (; index < source.length; index++) {
            if (source[index] === '\\') index++;
            else if (source[index] === ']') return index;
        }
        return -1;
    }

    // Index of the `)` closing the group opened at `index`.
    function skipGroup(source, index) {
        let depth = 0;
        for (; index < source.length; index++) {
            const char = source[index];
            if (char === '\\') index++;
            else if (char === '[') {
                index = skipClass(source, index);
                if (index < 0) return -1;
            } else if (char === '(') depth++;
            else if (char === ')' && --depth === 0) return index;
        }
        return -1;
    }

    // Literal substrings every match of `source` must contain, or null when
    // none can be derived (e.g. top-level alternation). Conservative: groups
    // and classes are skipped rather than analysed.
    function requiredRegexLiterals(source) {
        const literals = [];
        let current = '';
        const flush = () => {
            if (current.length >= 3) literals.push(current);
            current = '';
        };
        for (let index = 0; index < source.length; index++) {
            const char = source[index];
            if (char === '\\') {
                const next = source[++index];
                if (next === undefined) return null;
                if (/[A-Za-z0-9]/.test(next)) {
                    flush();
                    if (next === 'x') index += 2;
                    else if (next === 'c') index += 1;
                    else if (next === 'u') index = source[index + 1] === '{' ? source.indexOf('}', index) : index + 4;
                    else if ((next === 'p' || next === 'P') && source[index + 1] === '{') index = source.indexOf('}', index);
                    else if (next === 'k' && source[index + 1] === '<') index = source.indexOf('>', index);
                    else if (/[0-9]/.test(next)) while (/[0-9]/.test(source[index + 1] || '')) index++;
                    if (index < 0) return null;
                } else {
                    current += next;
                }
            } else if (char === '[' || char === '(') {
                flush();
                index = char === '[' ? skipClass(source, index) : skipGroup(source, index);
                if (index < 0) return null;
            } else if (char === '|') {
                return null;
            } else if (char === '*' || char === '?') {
                current = current.slice(0, -1);
                flush();
            } else if (char === '{' && /^\{\d+(,\d*)?\}/.test(source.slice(index))) {
                if (/^\{0[,}]/.test(source.slice(index))) current = current.slice(0, -1);
                flush();
                index = source.indexOf('}', index);
            } else if (char === '+' || char === '.' || char === '^' || char === '$' || char === ')') {
                flush();
            } else {
                current += char;
            }
        }
        flush();
        return literals;
    }

    function decodePosting(bytes, offset, length, count) {
        const ids = new Int32Array(count);
        const end = offset + length;
        let previous = -1;
        for (let index = 0; index < count; index++) {
            let delta = 0;
            let shift = 0;
            let byte;
            do {
                if (offset >= end) throw new Error('Malformed posting list');
                byte = bytes[offset++];
                delta += (byte & 0x7f) * 2 ** shift;
                shift += 7;
            } while (byte & 0x80);
            previous += delta;
            ids[index] = previous;
        }
        return ids;
    }

    function intersect(left, right) {
        const output = new Int32Array(Math.min(left.length, right.length));
        let size = 0;
        for (let i = 0, j = 0; i < left.length && j < right.length;) {
            if (left[i] < right[j]) i++;
            else if (left[i] > right[j]) j++;
            else { output[size++] = left[i]; i++; j++; }
        }
        return output.subarray(0, size);
    }

    function splitLines(source) {
        if (!source.length) return [];
        const lines = source.split(/\r\n|\n|\r/);
        if (/(?:\r\n|\n|\r)$/.test(source)) lines.pop();
        return lines;
    }

    async function gunzip(bytes) {
        if (typeof DecompressionStream !== 'function') throw new Error('This browser does not support gzip decompression');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function mapConcurrent(items, limit, worker, shouldStop = () => false) {
        let next = 0;
        const run = async () => {
            while (next < items.length && !shouldStop()) {
                const item = items[next++];
                await worker(item);
            }
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    }

    function indexFileName(directory, index) {
        return `${directory}/${String(index).padStart(4, '0')}.bin`;
    }

    class BrowserReverseSearcher {
        constructor(indexUrl, fetchFunction = root.fetch.bind(root)) {
            this.baseUrl = String(indexUrl).replace(/\/?$/, '/');
            this.fetch = fetchFunction;
            this.manifest = null;
            this.compressed = new Map();
            this.shardCache = new Map();
            this.chunkCache = new Map();
            this.chunkCacheChars = 0;
            this.activeSearches = 0;
            this.idle = Promise.resolve();
            this.prefetching = null;
        }

        async _fetchBytes(path, init) {
            const url = new URL(path, this.baseUrl).href;
            for (let attempt = 0; ; attempt++) {
                let failure;
                let retryable = true;
                try {
                    const response = await this.fetch(url, init);
                    if (response.ok) return new Uint8Array(await response.arrayBuffer());
                    failure = new Error(`Could not fetch ${path}: HTTP ${response.status}`);
                    retryable = response.status >= 500;
                } catch (error) {
                    failure = error;
                }
                if (!retryable || attempt >= FETCH_RETRY_DELAYS_MS.length) throw failure;
                await new Promise(resolve => setTimeout(resolve, FETCH_RETRY_DELAYS_MS[attempt]));
            }
        }

        // Compressed index files are kept for the whole session (~95 MB when
        // fully prefetched), so repeat lookups never touch the network.
        _compressed(name) {
            if (!this.compressed.has(name)) {
                const promise = this._fetchBytes(`${name}?v=${this.manifest.build}`);
                promise.catch(() => this.compressed.delete(name));
                this.compressed.set(name, promise);
            }
            return this.compressed.get(name);
        }

        async load() {
            const bytes = await gunzip(await this._fetchBytes('manifest.bin', { cache: 'no-cache' }));
            const manifest = JSON.parse(textDecoder.decode(bytes));
            if (manifest.version !== FORMAT_VERSION) throw new Error('Unsupported search index version');
            this.manifest = manifest;
            this.chunkEnds = [...manifest.chunks.slice(1), manifest.fileCount];
            return manifest.fileCount;
        }

        _shard(index) {
            const cached = this.shardCache.get(index);
            if (cached) {
                this.shardCache.delete(index);
                this.shardCache.set(index, cached);
                return cached;
            }
            {
                const promise = this._compressed(indexFileName('shards', index)).then(gunzip).then(bytes => {
                    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                    const gramCount = view.getUint32(0, true);
                    const entries = new Map();
                    let offset = 4 + gramCount * 11;
                    for (let entry = 0; entry < gramCount; entry++) {
                        const position = 4 + entry * 11;
                        const length = view.getUint32(position + 7, true);
                        entries.set(gramKey(bytes, position), { count: view.getUint32(position + 3, true), offset, length });
                        offset += length;
                    }
                    return { bytes, entries };
                });
                promise.catch(() => this.shardCache.delete(index));
                this.shardCache.set(index, promise);
                if (this.shardCache.size > SHARD_CACHE_ENTRIES) this.shardCache.delete(this.shardCache.keys().next().value);
                return promise;
            }
        }

        _chunk(index) {
            const cached = this.chunkCache.get(index);
            if (cached) {
                this.chunkCache.delete(index);
                this.chunkCache.set(index, cached);
                return cached.promise;
            }
            const entry = { size: 0, promise: null };
            entry.promise = this._compressed(indexFileName('chunks', index)).then(gunzip).then(bytes => {
                entry.size = bytes.length;
                this.chunkCacheChars += bytes.length;
                for (const [key, old] of this.chunkCache) {
                    if (this.chunkCacheChars <= CHUNK_CACHE_CHARS || old === entry) break;
                    this.chunkCache.delete(key);
                    this.chunkCacheChars -= old.size;
                }
                return JSON.parse(textDecoder.decode(bytes));
            });
            entry.promise.catch(() => {
                this.chunkCache.delete(index);
                this.chunkCacheChars -= entry.size;
            });
            this.chunkCache.set(index, entry);
            return entry.promise;
        }

        // Downloads every shard, then every chunk, in the background. Pauses
        // while a search is running so it never competes for bandwidth.
        prefetch(onProgress = () => {}) {
            if (!this.prefetching) {
                const { shardCount, chunks } = this.manifest;
                const names = [
                    ...Array.from({ length: shardCount }, (_, index) => indexFileName('shards', index)),
                    ...chunks.map((_, index) => indexFileName('chunks', index))
                ];
                let done = 0;
                let failed = 0;
                this.prefetching = mapConcurrent(names, PREFETCH_CONCURRENCY, async name => {
                    while (this.activeSearches) await this.idle;
                    try {
                        await this._compressed(name);
                    } catch (error) {
                        failed++;
                        console.warn(`Prefetch of ${name} failed:`, error);
                    }
                    onProgress(++done, names.length, failed);
                });
            }
            return this.prefetching;
        }

        // Sorted candidate file ids, or null when every file must be scanned.
        async _candidates(literals) {
            const grams = literalGrams(literals);
            if (!grams.size) return null;
            const { shardCount } = this.manifest;
            const lookups = await Promise.all([...grams].map(async ([key, bytes]) => {
                const shard = await this._shard(shardOf(bytes, shardCount));
                return { shard, descriptor: shard.entries.get(key) };
            }));
            if (lookups.some(lookup => !lookup.descriptor)) return new Int32Array(0);
            lookups.sort((left, right) => left.descriptor.count - right.descriptor.count);
            let candidates = null;
            for (const { shard, descriptor } of lookups) {
                const ids = decodePosting(shard.bytes, descriptor.offset, descriptor.length, descriptor.count);
                candidates = candidates ? intersect(candidates, ids) : ids;
                if (!candidates.length) break;
            }
            return candidates;
        }

        // Returns { results, lineCount, plugins }. Every match is counted, but
        // only options.limit lines are kept (highest options.priority(plugin)
        // first), so huge result sets never exhaust memory. plugins lists every
        // matching plugin with its line count. options.signal cancels the search.
        async search(query, options = {}) {
            if (!this.manifest) throw new Error('Search index is not loaded');
            if (this.activeSearches++ === 0) this.idle = new Promise(resolve => { this.resolveIdle = resolve; });
            try {
                return await this._search(query, options);
            } finally {
                if (--this.activeSearches === 0) this.resolveIdle();
            }
        }

        async _search(query, options) {
            const signal = options.signal;
            const onProgress = options.onProgress || (() => {});
            const caseSensitive = options.caseSensitive === true;
            const isRegex = options.isRegex === true;
            const pattern = isRegex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
            const needle = caseSensitive ? query : query.toLowerCase();
            const literals = isRegex ? requiredRegexLiterals(query) : [query];
            const candidates = literals ? await this._candidates(literals) : null;
            signal?.throwIfAborted();

            // Group candidate files by text chunk.
            const { chunks, plugins } = this.manifest;
            const wanted = new Map();
            if (candidates) {
                let chunk = 0;
                for (const fileId of candidates) {
                    while (this.chunkEnds[chunk] <= fileId) chunk++;
                    if (!wanted.has(chunk)) wanted.set(chunk, []);
                    wanted.get(chunk).push(fileId);
                }
            } else {
                for (let chunk = 0; chunk < chunks.length; chunk++) wanted.set(chunk, null);
            }

            const limit = options.limit ?? Infinity;
            const priority = options.priority || (() => 0);
            const compare = (left, right) => right.priority - left.priority || left.fileId - right.fileId || left.line - right.line;
            let kept = [];
            let lineCount = 0;
            const pluginLines = new Map();
            const snapshot = () => {
                kept.sort(compare);
                if (kept.length > limit) kept.length = limit;
                const matched = [...pluginLines].map(([pluginIndex, lines]) => {
                    const [plugin, repository, commit] = plugins[pluginIndex];
                    return { plugin, repository, commit, lines };
                });
                return { results: kept.map(({ fileId, priority, ...result }) => result), lineCount, plugins: matched };
            };

            await mapConcurrent([...wanted], FETCH_CONCURRENCY, async ([chunk, fileIds]) => {
                const files = await this._chunk(chunk);
                if (signal?.aborted) return;
                const first = chunks[chunk];
                const ids = fileIds || files.map((_, index) => first + index);
                for (const fileId of ids) {
                    const [pluginIndex, filePath, content] = files[fileId - first];
                    const searchable = caseSensitive ? content : content.toLowerCase();
                    if (!pattern && !searchable.includes(needle)) continue;
                    const lines = splitLines(content);
                    const [plugin, repository, commit] = plugins[pluginIndex];
                    const rank = Number(priority(plugin)) || 0;
                    let fileMatches = 0;
                    for (let index = 0; index < lines.length; index++) {
                        const line = lines[index];
                        const matches = pattern
                            ? pattern.test(line)
                            : (caseSensitive ? line : line.toLowerCase()).includes(needle);
                        if (!matches) continue;
                        fileMatches++;
                        kept.push({ fileId, priority: rank, plugin, repository, commit, filePath, line: index + 1, content: line });
                        if (kept.length >= 2 * limit + 1024) {
                            kept.sort(compare);
                            kept.length = limit;
                        }
                    }
                    if (fileMatches) {
                        lineCount += fileMatches;
                        pluginLines.set(pluginIndex, (pluginLines.get(pluginIndex) || 0) + fileMatches);
                    }
                }
            }, () => signal?.aborted);
            signal?.throwIfAborted();
            return snapshot();
        }
    }

    const api = { BrowserReverseSearcher, requiredRegexLiterals };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ReverseSearchBrowser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
