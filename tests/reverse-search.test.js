const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { BrowserReverseSearcher, requiredRegexLiterals } = require('../scripts/reverse-search-browser.js');

const python = process.env.PYTHON || 'python3';

function buildIndex(dataDirectory, indexDirectory, workers) {
    execFileSync(python, [
        path.join(__dirname, '..', 'build_reverse_index.py'),
        dataDirectory,
        indexDirectory,
        String(workers)
    ], { stdio: 'pipe' });
}

function fileFetch(indexDirectory, log = []) {
    return async url => {
        const relative = new URL(url).pathname.replace(/^\/index\//, '');
        log.push(relative);
        const filePath = path.join(indexDirectory, relative);
        if (!fs.existsSync(filePath)) return { ok: false, status: 404 };
        const bytes = fs.readFileSync(filePath);
        return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    };
}

const find = (searcher, ...args) => searcher.search(...args).then(found => found.results);

function listFiles(directory) {
    return fs.readdirSync(directory, { recursive: true }).sort()
        .filter(name => fs.statSync(path.join(directory, name)).isFile())
        .map(name => [name, fs.readFileSync(path.join(directory, name))]);
}

test('reverse index searches source lines and preserves exact result metadata', async t => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'reverse-index-'));
    t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

    const dataDirectory = path.join(temporaryDirectory, 'data');
    fs.mkdirSync(dataDirectory);
    fs.writeFileSync(path.join(dataDirectory, 'zom-keris-cam.json'), JSON.stringify({
        internalName: 'wrong-plugin',
        repository: 'https://github.com/example/zom-keris-cam.git',
        commit: 'abc123',
        description: 'metadata-only-needle',
        files: [{
            pluginName: 'also-wrong',
            filePath: 'src/main/java/com/zom/TOAKerisCamPlugin.java',
            content: [
                'package com.zom;',
                '',
                '\tname = "Toa Keris Cam"',
                'RunePouchPlacement enum',
                'Visible phrase appears here',
                'Toa happens on another line',
                'Keris appears on this different line',
                'client.getLocalPlayer().getName()'
            ].join('\r\n')
        }]
    }));
    fs.writeFileSync(path.join(dataDirectory, 'second-plugin.json'), JSON.stringify({
        files: [{ filePath: 'src/Other.java', content: 'Toa unrelated\nclientXgetLocalPlayer\n' }]
    }));

    const indexDirectory = path.join(temporaryDirectory, 'index');
    buildIndex(dataDirectory, indexDirectory, 2);
    const serialDirectory = path.join(temporaryDirectory, 'serial');
    buildIndex(dataDirectory, serialDirectory, 1);
    assert.deepEqual(listFiles(indexDirectory), listFiles(serialDirectory));

    const requests = [];
    const searcher = new BrowserReverseSearcher('https://pages.example/index/', fileFetch(indexDirectory, requests));
    await searcher.load();

    const phrase = await find(searcher, 'Toa Keris Cam', { caseSensitive: true });
    assert.deepEqual(phrase, [{
        plugin: 'zom-keris-cam',
        repository: 'https://github.com/example/zom-keris-cam.git',
        commit: 'abc123',
        filePath: 'src/main/java/com/zom/TOAKerisCamPlugin.java',
        line: 3,
        content: '\tname = "Toa Keris Cam"'
    }]);

    assert.equal((await find(searcher, 'PouchPlacement')).length, 1);
    assert.equal((await find(searcher, 'visible phrase')).length, 1);
    assert.equal((await find(searcher, 'VISIBLE PHRASE', { caseSensitive: true })).length, 0);
    assert.equal((await find(searcher, 'metadata-only-needle')).length, 0);
    assert.equal((await find(searcher, 'Toa Keris')).length, 1);
    assert.equal((await find(searcher, 'Keris Toa')).length, 0);
    assert.equal((await find(searcher, 'Toa')).length, 3);

    // Regex queries use the index through their required literals.
    requests.length = 0;
    const regex = await find(searcher, 'client.getLocalPlayer', { isRegex: true, caseSensitive: true });
    assert.deepEqual(regex.map(result => result.plugin), ['second-plugin', 'zom-keris-cam']);
    assert.ok(requests.every(name => !name.startsWith('manifest')));
    assert.equal((await find(searcher, 'client\\.getLocal', { isRegex: true })).length, 1);
    assert.equal((await find(searcher, '^Toa (happens|unrelated)', { isRegex: true, caseSensitive: true })).length, 2);

    // Queries with no usable trigram fall back to scanning every chunk.
    assert.equal((await find(searcher, '^.{0,2}$', { isRegex: true })).length, 1);
    assert.equal((await find(searcher, 'zz')).length, 0);

    // Dropped connections and server errors are retried; missing files are not.
    const realFetch = fileFetch(indexDirectory);
    const attempts = new Map();
    const flakyFetch = async url => {
        const count = (attempts.get(url) || 0) + 1;
        attempts.set(url, count);
        if (count === 1) throw new TypeError('Failed to fetch');
        if (count === 2) return { ok: false, status: 503 };
        return realFetch(url);
    };
    const flakySearcher = new BrowserReverseSearcher('https://pages.example/index/', flakyFetch);
    await flakySearcher.load();
    assert.deepEqual(await find(flakySearcher, 'Toa Keris Cam', { caseSensitive: true }), phrase);
    const missing = new BrowserReverseSearcher('https://pages.example/missing/', async () => ({ ok: false, status: 404 }));
    await assert.rejects(missing.load(), /HTTP 404/);

    // Aborted searches reject.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(find(searcher, 'Toa', { signal: controller.signal }), { name: 'AbortError' });

    // Every match is counted, but only `limit` lines are kept, highest priority first.
    const limited = await searcher.search('Toa', { limit: 1, priority: plugin => plugin === 'second-plugin' ? 10 : 0 });
    assert.equal(limited.lineCount, 3);
    assert.deepEqual(limited.results.map(result => result.content), ['Toa unrelated']);
    assert.deepEqual(limited.plugins.map(({ plugin, lines }) => [plugin, lines]).sort(), [['second-plugin', 1], ['zom-keris-cam', 2]]);

    // After prefetching, searches need no network at all.
    const prefetchRequests = [];
    const prefetcher = new BrowserReverseSearcher('https://pages.example/index/', fileFetch(indexDirectory, prefetchRequests));
    await prefetcher.load();
    const reports = [];
    await prefetcher.prefetch((done, total) => reports.push([done, total]));
    assert.deepEqual(reports.at(-1), [reports.length, reports.length]);
    prefetchRequests.length = 0;
    assert.deepEqual(await find(prefetcher, 'Toa Keris Cam', { caseSensitive: true }), phrase);
    assert.equal((await find(prefetcher, '^.{0,2}$', { isRegex: true })).length, 1);
    assert.deepEqual(prefetchRequests, []);
});

test('required regex literals are conservative', () => {
    assert.deepEqual(requiredRegexLiterals('client.getLocalPlayer'), ['client', 'getLocalPlayer']);
    assert.deepEqual(requiredRegexLiterals('ItemID\\.ABYSSAL_WHIP'), ['ItemID.ABYSSAL_WHIP']);
    assert.deepEqual(requiredRegexLiterals('colou?r'), ['colo']);
    assert.deepEqual(requiredRegexLiterals('abcd*e'), ['abc']);
    assert.deepEqual(requiredRegexLiterals('(a|b)getItem[A-Z]+Container'), ['getItem', 'Container']);
    assert.deepEqual(requiredRegexLiterals('\\x41bcdef'), ['bcdef']);
    assert.deepEqual(requiredRegexLiterals('[]abc]def'), ['def']);
    assert.equal(requiredRegexLiterals('foo|bar'), null);
});
