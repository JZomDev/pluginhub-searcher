#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'search-index.json.gz');

function ensureOutDir() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function decodeJson(buf) {
    const bytes = new Uint8Array(buf);
    let text;
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Response(buf).body.pipeThrough(new DecompressionStream("gzip"));
        text = new Response(stream).text();
    }
    return JSON.parse(text);
}


function buildIndex() {
    if (!fs.existsSync(PLUGINS_DIR)) {
        console.error(`Plugins directory not found: ${PLUGINS_DIR}`);
        process.exitCode = 1;
        return;
    }

    const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.gz'));

    let unzipped = 0;
    const parts = Promise.all(files.map(async (buf) => {
        try {
            if (!buf) return null;
            const part = decodeJson(buf);
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

    ensureOutDir();
    const out = {
        generatedAt: new Date().toISOString(),
        files: filesMeta,            // existing metadata
        index,                       // object mapping token -> [filenames] (backwards-compatible)
        entries,                     // array of [token, [filenames]] — matches your buildIndex() result shape
        symbolLocations              // mapping token -> [{plugin, file, line}]
    };

    // 2. Convert JSON object to a string
    const jsonString = JSON.stringify(out)

    // 3. Create a write stream and pipe the compressed data into it
    const gzip = zlib.createGzip();
    const outputStream = fs.createWriteStream(OUT_FILE);

    // Pass the string to the gzip stream and output to the file
    gzip.pipe(outputStream);
    gzip.write(jsonString);
    gzip.end();

    outputStream.on('finish', () => {
        console.log('Successfully wrote JSON content to data.json.gz');
    });

}

buildIndex();
