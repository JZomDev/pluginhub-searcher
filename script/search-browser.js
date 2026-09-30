const INDEX_JSON = "plugins/plugins.bin.gz.index.json";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0, lastModified: null };
let _init = null;
let _indexReadyResolver = null;
const textDecoder = new TextDecoder();

async function _initOnce() {
    if (STATE.ready) return;
    if (_init) return;
    _init = (async () => {
        // Fetch index JSON to get split chunks and lastModified
        const indexResp = await fetch(INDEX_JSON);
        const indexData = await indexResp.json();
        STATE.lastModified = indexData.lastModified;
        
        // Fetch all chunk files in parallel using Promise.all
        const sortedChunks = indexData.splits.sort((a, b) => a.index - b.index);
        const fetchPromises = sortedChunks.map(async (chunk) => {
            const chunkUrl = `plugins/${chunk.file}`;
            const chunkResp = await fetch(chunkUrl);
            const buf = await chunkResp.arrayBuffer();
            return { index: chunk.index, buffer: buf };
        });
        
        const results = await Promise.all(fetchPromises);
        const buffers = results.sort((a, b) => a.index - b.index).map(r => r.buffer);
        
        // Concatenate all chunks into single buffer
        const totalSize = buffers.reduce((sum, b) => sum + b.byteLength, 0);
        const concatenated = new Uint8Array(totalSize);
        let offset = 0;
        for (const buf of buffers) {
            concatenated.set(new Uint8Array(buf), offset);
            offset += buf.byteLength;
        }
        
        // Decompress and parse
        const stream = new Response(concatenated.buffer).body.pipeThrough(new DecompressionStream("gzip"));
        const decompressed = await new Response(stream).arrayBuffer();
        _parseBuffer(decompressed);

        STATE.ready = true;
        if (_indexReadyResolver) {
            _indexReadyResolver();
            _indexReadyResolver = null;
        }
    })();
    await _init;
}

function waitForIndex() {
    _initOnce();
    if (STATE.ready) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        if (_indexReadyResolver) {
            _indexReadyResolver();
        } else {
            _indexReadyResolver = resolve;
        }
    });
}

function _parseBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    let p = 0;
    const fileCount = view.getUint32(p, true);
    p += 4;

    const entries = [];
    for (let i = 0; i < fileCount; i++) {
        const fileNameLen = view.getUint16(p, true);
        p += 2;
        const fileName = textDecoder.decode(bytes.slice(p, p + fileNameLen));
        p += fileNameLen;

        const pluginNameLen = view.getUint16(p, true);
        p += 2;
        const pluginName = textDecoder.decode(bytes.slice(p, p + pluginNameLen));
        p += pluginNameLen;

        const strOff = view.getUint32(p, true);
        p += 4;
        const len = view.getUint32(p, true);
        p += 4;
        const lineCnt = view.getUint16(p, true);
        p += 2;
        const lineOff = [];
        for (let j = 0; j < lineCnt; j++) {
            lineOff.push(view.getUint32(p, true));
            p += 4;
        }
        entries.push({ fileName, pluginName, stringOffset: strOff, contentLength: len, lineOffsets: lineOff });
    }

    const strTableOffset = view.getUint32(bytes.byteLength - 4, true);
    const stringTable = textDecoder.decode(bytes.slice(strTableOffset));

    STATE.fileCount = fileCount;
    STATE.entries = entries;
    STATE.stringTable = stringTable;
    STATE.stringTableBytes = bytes.slice(strTableOffset);
    STATE.stringTableLength = bytes.byteLength - strTableOffset;
    STATE.ready = true;
    if (_indexReadyResolver) {
        _indexReadyResolver();
        _indexReadyResolver = null;
    }
}

async function queryIndex(query, options = {}) {
    await _initOnce();

    const results = {};
    const tableBytes = STATE.stringTableBytes;
    const isRegex = options.isRegex !== false;
    const caseSensitive = !!options.caseSensitive;
    
    let re;
    if (isRegex) {
        re = new RegExp(query, caseSensitive ? undefined : 'i');
    } else {
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(escapedQuery, caseSensitive ? undefined : 'i');
    }
    
    const MAX_TOTAL_MATCHES = 5000;
    let totalMatches = 0;
    
    for (let i = 0; i < STATE.entries.length; i++) {
        const e = STATE.entries[i];
        const contentBytes = tableBytes.slice(e.stringOffset, e.stringOffset + e.contentLength);
        const content = textDecoder.decode(contentBytes);
        const lines = content.split("\n");
        const matching = [];
        for (let j = 0; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed === '' || trimmed === '{' || trimmed === '}') {
                continue;
            }
            if (re.test(lines[j])) {
                matching.push({ line: j + 1, text: lines[j] });
                totalMatches++;
            }
        }
        if (matching.length > 0) results[e.fileName] = { matches: matching, pluginName: e.pluginName };
    }
    let uniqueCounts = [...new Set(Object.values(results).map(x => x.pluginName))].length 

    if (totalMatches > MAX_TOTAL_MATCHES) {
        throw new Error(`Found ${totalMatches} line matches across ${uniqueCounts} plugins and it exceeds maximum of ${MAX_TOTAL_MATCHES} line matches. Please use a more specific search term.`);
    }
    return results;
}

function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable, lastModified: STATE.lastModified };
}

export { queryIndex, parseIndex, waitForIndex };
