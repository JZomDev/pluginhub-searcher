#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'search-index.json.gz');

const root = "https://repo.runelite.net/plugins/";

async function fetchJson(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching ${url}`);
    }

    return response.json();
}

async function getVersion() {
    const response = await fetch(
        "https://raw.githubusercontent.com/runelite/plugin-hub/master/runelite.version"
    );

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} while fetching RuneLite version`);
    }

    return (await response.text()).trim();
}

async function getManifest(version) {
    const response = await fetch(`${root}manifest/${version}_full.js`);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status} while fetching manifest for version ${version}`
        );
    }

    const buf = await response.arrayBuffer();
    const data = Buffer.from(buf);

    // RuneLite manifest has a header before the JSON data.
    const skip = 4 + data.readUInt32BE(0);

    const text = data.subarray(skip).toString('utf8');

    return JSON.parse(text);
}

// Decode an ArrayBuffer that may be gzip-compressed.
async function decodeJson(buf) {
        try {

            const buffer = fs.readFileSync(path.join(PLUGINS_DIR, buf));
            const bytes = new Uint8Array(buffer);
            const isGzip = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
            if (isGzip) {
                const decompressed = zlib.gunzipSync(buffer);
                const text = decompressed.toString('utf8');
                return JSON.parse(text);
            }

        } catch (error) {
            throw new Error(
                `Failed to gunzip ${buf}: ${error.message}`
            );
        }

}

async function loadPluginBundle() {
    const buffers = fs
        .readdirSync(PLUGINS_DIR)
        .filter(f => f.endsWith('.gz'))
        .sort();

    console.log("Decompressing plugin data...");

    // Decompress and parse all files.
    const parts = await Promise.all(
        buffers.map(async buf => {
            try {
                if (!buf) {
                    return null;
                }

                console.log(buf);
                const part = await decodeJson(buf);

                return Array.isArray(part) ? part : null;
            } catch (error) {
                console.error("Failed to decode plugin data:", error);
                return null;
            }
        })
    );
    
    const map = Object.create(null);

    for (const part of parts) {
        if (!part) {
            continue;
        }

        for (const plugin of part) {
            if (!plugin || !plugin.internalName) {
                continue;
            }

            const contents = [];

            if (plugin.content) {
                contents.push({
                    filePath: null,
                    content: plugin.content
                });
            }

            if (Array.isArray(plugin.files)) {
                for (const file of plugin.files) {
                    if (!file) {
                        continue;
                    }

                    if (typeof file === "string") {
                        contents.push({
                            filePath: file,
                            content: null
                        });
                    } else {
                        contents.push({
                            filePath:
                                file.filePath ||
                                file.fileName ||
                                null,
                            content: file.content || null
                        });
                    }
                }
            }

            map[plugin.internalName] = contents;
        }
    }

    return map;
}

async function readPluginApi(bundle, plugin) {
    const files = bundle[plugin.internalName] || [];

    const lines = [];

    for (const file of files) {
        if (!file) {
            continue;
        }

        let filePath = null;
        let content = "";

        if (typeof file === "string") {
            filePath = file;
        } else {
            filePath =
                file.filePath ||
                file.fileName ||
                null;

            content = file.content || "";
        }

        const parts = content.split("\n");

        for (let i = 0; i < parts.length; i++) {
            lines.push({
                text: parts[i],
                file: filePath,
                line: i + 1
            });
        }
    }

    return lines;
}

async function amap(limit, array, asyncMapper) {
    const out = new Array(array.length);

    const todo = new Array(array.length)
        .fill(0)
        .map((_, i) => i);

    await Promise.all(
        new Array(limit)
            .fill(0)
            .map(async () => {
                while (todo.length > 0) {
                    const i = todo.pop();

                    out[i] = await asyncMapper(array[i]);
                }
            })
    );

    return out;
}

async function buildIndex(manifest, bundle) {
    const symbolLocations = new Map();

    let out = new Map();

    let indexedCount = 0;

    console.log(`Indexing ${manifest.jars.length} plugins...`);

    await amap(64, manifest.jars, async plugin => {
        const api = await readPluginApi(bundle, plugin);

        for (const lineObj of api) {
            const k = lineObj.text;

            if (k === "") {
                continue;
            }

            // Keep the original symbol -> plugins index.
            let plugins = out.get(k);

            if (!plugins) {
                plugins = [];
                out.set(k, plugins);
            }

            plugins.push(plugin.internalName);

            // Build symbol -> source locations.
            let locations = symbolLocations.get(k);

            if (!locations) {
                locations = [];
                symbolLocations.set(k, locations);
            }

            locations.push({
                plugin: plugin.internalName,
                file: lineObj.file,
                line: lineObj.line
            });
        }

        indexedCount++;

        if (
            indexedCount % 10 === 0 ||
            indexedCount === manifest.jars.length
        ) {
            console.log(
                `Indexed ${indexedCount}/${manifest.jars.length} plugins`
            );
        }
    });

    // Sort symbols alphabetically.
    const entries = [...out.entries()];

    entries.sort(([a], [b]) =>
        a.localeCompare(b)
    );

    // Preserve the same structure as the browser version.
    entries.symbolLocations = symbolLocations;

    return entries;
}

async function writeSymbolsLocation(symbolLocations) {
    const output = fs.createWriteStream(OUT_FILE);
    const gzip = zlib.createGzip();

    gzip.pipe(output);

    // Wrap the writing logic in a Promise so we can await its actual disk completion
    await new Promise((resolve, reject) => {
        // Track stream errors so the script doesn't silently hang or crash
        gzip.on('error', reject);
        output.on('error', reject);

        // This fires ONLY when the OS completely flushes all bytes to disk
        output.on('finish', resolve);

        gzip.write('{');

        let first = true;
        for (const [key, value] of symbolLocations) {
            if (!first) {
                gzip.write(',');
            }
            first = false;

            gzip.write(JSON.stringify(key));
            gzip.write(':');
            gzip.write(JSON.stringify(value));
        }

        gzip.write('}');

        // Signal that we are done generating input; this triggers zlib to clear its buffer
        gzip.end();
    });

    // Now it is completely safe to log or terminate the script
    console.log(`Wrote to file ${OUT_FILE}`);

    console.log("gzip end")
    return true;
}

(async () => {
    try {
        console.log("Getting RuneLite version...");

        const version = await getVersion();

        console.log(`RuneLite version: ${version}`);

        console.log("Getting manifest...");

        const manifest = await getManifest(version);

        console.log(
            `Manifest contains ${manifest.jars.length} plugins`
        );

        console.log("Loading plugin bundle...");

        const bundle = await loadPluginBundle();

        console.log("Building symbol index...");

        const startTime = Date.now();

        const indexedUsages = await buildIndex(
            manifest,
            bundle
        );

        const symbolLocations =
            indexedUsages.symbolLocations ||
            new Map();

        console.log(
            `Indexed ${indexedUsages.length} symbols`
        );

        console.log(
            `Found ${symbolLocations.size} unique symbols`
        );

        console.log(
            `Indexing completed in ${Date.now() - startTime}ms`
        );

        // Write the requested JSON file.
        var b = await writeSymbolsLocation(symbolLocations);

        if (b)
        {
            console.log("Done!");
            process.exit(0);
        }
        else
        {
            console.log("error")
        }
        //
        // console.log("Done!");
        // process.exit(0);
    } catch (error) {
        console.error("Script failed:");
        console.error(error);

        process.exit(1);
    }
})();
