#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'search-index.json.gz');

function ensureOutDir() {
    if (!fs.existsSync(OUT_DIR)) {
        fs.mkdirSync(OUT_DIR, { recursive: true });
    }
}

function decodeJson(filePath) {
    const compressed = fs.readFileSync(filePath);
    const decompressed = zlib.gunzipSync(compressed);

    return JSON.parse(decompressed.toString('utf8'));
}

function buildIndex() {
    if (!fs.existsSync(PLUGINS_DIR)) {
        console.error(`Plugins directory not found: ${PLUGINS_DIR}`);
        process.exitCode = 1;
        return;
    }

    const files = fs
        .readdirSync(PLUGINS_DIR)
        .filter(f => f.endsWith('.gz'))
        .sort();

    const map = Object.create(null);
    const filesMeta = [];

    let unzipped = 0;

    for (const file of files) {
        if ('${file}' !== 'plugins_0.json.gz')
        {
            continue;
        }
        const filePath = path.join(PLUGINS_DIR, file);

        try {
            const part = decodeJson(filePath);

            if (!Array.isArray(part)) {
                console.warn(`Skipping ${file}: expected an array`);
                continue;
            }

            filesMeta.push({
                file,
                size: fs.statSync(filePath).size
            });

            for (const p of part) {
                if (!p || !p.internalName) {
                    continue;
                }

                const contents = [];

                if (p.content) {
                    contents.push({
                        filePath: null,
                        content: p.content
                    });
                }

                if (Array.isArray(p.files)) {
                    for (const f of p.files) {
                        if (!f) {
                            continue;
                        }

                        if (typeof f === 'string') {
                            contents.push({
                                filePath: f,
                                content: null
                            });
                        } else {
                            contents.push({
                                filePath: f.filePath || f.fileName || null,
                                content: f.content || null
                            });
                        }
                    }
                }

                map[p.internalName] = contents;
            }

            unzipped++;
            console.log(`Processed ${file}`);
        } catch (error) {
            console.warn(
                `Failed to process ${file}: ${error.message}`
            );
        }
    }

    /*
     * Build the token index.
     *
     * This part assumes the searchable text comes from the
     * plugin internalName, file paths, and file contents.
     */
    const index = Object.create(null);

    function addToIndex(token, internalName, line = null) {
        if (!token) return;

        if (!index[token]) {
            index[token] = [];
        }

        const entry = {
            internalName,
            line
        };

        const exists = index[token].some(
            item =>
                item.internalName === internalName &&
                item.line === line
        );

        if (!exists) {
            index[token].push(entry);
        }
    }

    for (const [internalName, contents] of Object.entries(map)) {
        // Index the plugin name itself.
        addToIndex(internalName.toLowerCase(), internalName, null);

        for (const item of contents) {
            if (item.filePath) {
                // File paths don't correspond to a content line.
                addToIndex(item.filePath.toLowerCase(), internalName, null);
            }

            if (item.content) {
                const lines = String(item.content).split(/\r?\n/);

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    const normalizedLine = line.trim().toLowerCase();

                    if (normalizedLine && normalizedLine !== '}' && normalizedLine !== '{') {
                        addToIndex(
                            line.trim(),
                            internalName,
                            i + 1
                        );
                    }
                }
            }
        }
    }
    
    console.log(index;)

    const entries = Object.entries(index);

    console.log(entries;)


    // Placeholder until symbol-location extraction is implemented.

    ensureOutDir();

    const out = {
        files: filesMeta,
        index,
        entries};

    const jsonString = JSON.stringify(out);

    const gzip = zlib.createGzip();
    const outputStream = fs.createWriteStream(OUT_FILE);

    gzip.pipe(outputStream);
    gzip.end(jsonString);

    outputStream.on('finish', () => {
        console.log(
            `Successfully wrote ${OUT_FILE} (${jsonString.length} bytes JSON)`
        );
        console.log(`Processed ${unzipped}/${files.length} plugin files.`);
        console.log(`Indexed ${entries.length} tokens.`);
    });

    outputStream.on('error', error => {
        console.error(`Failed to write ${OUT_FILE}:`, error);
        process.exitCode = 1;
    });
}

buildIndex();