import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const INDEX_JSON = "plugins/plugins.bin.gz.index.json";

const STATE = { ready: false, entries: [], stringTable: "", fileCount: 0 };
let _init;
const textDecoder = new TextDecoder();

async function loadConcatenatedGzData(indexJsonPath) {
    const pluginsDir = indexJsonPath.substring(0, indexJsonPath.lastIndexOf("/"));
    
    const indexData = JSON.parse(readFileSync(indexJsonPath, "utf-8"));
    const sortedChunks = indexData.splits.sort((a, b) => a.index - b.index);
    
    let totalSize = 0;
    const chunkBuffers = [];
    
    for (const chunk of sortedChunks) {
        const chunkPath = chunk.file.startsWith("plugins/") 
            ? join(pluginsDir, chunk.file.substring("plugins/".length))
            : join(pluginsDir, chunk.file);
        
        if (existsSync(chunkPath)) {
            const buf = readFileSync(chunkPath);
            chunkBuffers.push(buf);
            totalSize += buf.length;
        } else {
            console.warn(`Chunk file not found: ${chunkPath}`);
        }
    }
    
    return Buffer.concat(chunkBuffers, totalSize);
}

async function parseGzData(gzData) {
    const zlib = await import("node:zlib");
    const buffer = zlib.gunzipSync(gzData);
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

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

    const strTableOffset = view.getUint32(buffer.byteLength - 4, true);
    const stringTable = textDecoder.decode(bytes.slice(strTableOffset));

    STATE.fileCount = entries.length;
    STATE.entries = entries;
    STATE.stringTable = stringTable;
    STATE.stringTableBytes = bytes.slice(strTableOffset);
    STATE.stringTableLength = bytes.byteLength - strTableOffset;
    STATE.ready = true;
}

async function _initOnce(gzFilePath, manifestUrl = null) {
    if (STATE.ready && STATE.entries.length > 0) return;
    if (_init) return;
    
    _init = (async () => {
        let indexJsonPath = gzFilePath.replace(/\.bin\.gz(\.\d+)?$/, "/plugins.bin.gz.index.json");
        
        // Try to load from split chunks via index JSON
        if (existsSync(indexJsonPath)) {
            try {
                const combinedData = await loadConcatenatedGzData(indexJsonPath);
                await parseGzData(combinedData);
            } catch (e) {
                console.error("Failed to load split index:", e.message, "at", indexJsonPath);
                throw e;
            }
        } else if (existsSync(gzFilePath)) {
            // Fall back to single file
            const gzData = readFileSync(gzFilePath);
            parseGzData(gzData);
        } else {
            throw new Error(`Index file not found: ${gzFilePath}`);
        }
    })();
    
    await _init;
}

async function queryIndex(gzFilePath, query, manifestUrl = null, options = {}) {
    // Reset STATE if it was left in a partially loaded state from a previous failed attempt
    if (STATE.ready && (!STATE.entries || STATE.entries.length === 0)) {
        STATE.ready = false;
        STATE.entries = [];
        STATE.stringTable = "";
        _init = null;
    }
    
    await _initOnce(gzFilePath, manifestUrl);

    const results = {};
    const tableBytes = STATE.stringTableBytes;
    const isRegex = options.isRegex !== false;
    const caseSensitive = options.caseSensitive !== false;
    console.log(caseSensitive)
    let re;
    if (isRegex) {
        re = new RegExp(query, caseSensitive ? undefined : 'i');
    } else {
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        re = new RegExp(escapedQuery, caseSensitive ? undefined : 'i');
    }
    
    // Prevent memory exhaustion from overly broad regex patterns
    const MAX_TOTAL_MATCHES = 500;
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
                // if (totalMatches > MAX_TOTAL_MATCHES) {
                //     throw new Error(`Search results exceed maximum of ${MAX_TOTAL_MATCHES} matches. Please use a more specific search term.`);
                // }
            }
        }
        if (matching.length > 0) results[e.fileName] = { matches: matching, pluginName: e.pluginName };
    }
    return results;
}

function parseIndex() {
    return { fileCount: STATE.fileCount, entries: STATE.entries, stringTable: STATE.stringTable };
}

export { queryIndex, parseIndex, buildTestIndex };

async function buildTestIndex() {}

globalThis.buildTestIndex = buildTestIndex;
