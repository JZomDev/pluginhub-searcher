#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const pipeline = require('node:stream/promises');

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
    const isGzip =
        buf.endsWith(".gz") ||
        (bytes.length >= 2 &&
            bytes[0] === 0x1f &&
            bytes[1] === 0x8b);

    if (isGzip) {
        try {
            const source = fs.createReadStream(buf);
            const unzip = zlib.createGunzip();

            // We accumulate the string chunks as they unzip
            let jsonString = '';

            unzip.on('data', (chunk) => {
                jsonString += chunk.toString('utf8');
            });

            try {
                // pipeline handles error forwarding and clean cleanup of streams
                await pipeline(readStream, unzip);

                const jsonObject = JSON.parse(jsonString);
                return jsonObject;
            } catch (error) {
                console.error('Failed to decompress or parse JSON:', error);
                throw error;
            }
        } catch (error) {
            throw new Error(
                `Failed to gunzip ${buf}: ${error.message}`
            );
        }
    }
}


// Normalize both supported split-manifest formats:
//
// ["plugins_0.json.gz", ...]
//
// or
//
// [{ zipname: "plugins_0.json.gz", content: [...] }, ...]
function getSplitFileNames(splits) {
    if (!Array.isArray(splits)) {
        return [];
    }

    return splits
        .map(split =>
            typeof split === "string"
                ? split
                : split?.zipname
        )
        .filter(
            name =>
                typeof name === "string" &&
                name.trim().length > 0
        );
}

async function loadPluginBundle() {
    let fileNames = null;

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

function writeSymbolsLocation(symbolLocations) {
    // const outputPath = path.join(
    //     __dirname,
    //     "symbolsLocation.json"
    // );

    // Map cannot be directly JSON.stringify'd.
    // Convert it to a normal object first.
    const output = Object.fromEntries(symbolLocations);

    const gzip = zlib.createGzip();
    const outputStream = fs.createWriteStream(OUT_FILE);

    gzip.pipe(outputStream);
    gzip.end(output);

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

    // console.log(
    //     `Wrote ${symbolLocations.size} symbols to ${outputPath}`
    // );
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
        writeSymbolsLocation(symbolLocations);

        console.log("Done!");
    } catch (error) {
        console.error("Script failed:");
        console.error(error);

        process.exit(1);
    }
})();
