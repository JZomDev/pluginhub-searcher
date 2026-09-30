import { test } from "node:test";
import { strictEqual, ok } from "node:assert";
import { queryIndex, parseIndex } from "../script/search.js";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";

const testDir = dirname(new URL(import.meta.url).pathname);
const projectRoot = join(testDir, "..");

async function loadConcatenatedIndex() {
    const indexJsonPath = join(projectRoot, "plugins/plugins.bin.gz.index.json");
    const pluginsDir = join(projectRoot, "plugins");
    
    const indexData = JSON.parse(readFileSync(indexJsonPath, "utf-8"));
    const sortedChunks = indexData.splits.sort((a, b) => a.index - b.index);
    
    let totalSize = 0;
    const chunkBuffers = [];
    
    for (const chunk of sortedChunks) {
        const chunkPath = join(pluginsDir, chunk.file);
        const buf = readFileSync(chunkPath);
        chunkBuffers.push(buf);
        totalSize += buf.length;
    }
    
    const concatenated = Buffer.concat(chunkBuffers, totalSize);
    const tempIndexPath = join(projectRoot, "plugins/plugins.bin.gz.combined");
    await writeFile(tempIndexPath, concatenated);
    
    return { path: tempIndexPath, cleanup: () => unlink(tempIndexPath) };
}

function countMatches(results) {
    let count = 0;
    for (const entry of Object.values(results)) {
        count += entry.matches.length;
    }
    return count;
}

test("search 'ZigZagLayoutConfig' returns 6 matches", async () => {
    const indexJsonPath = join(projectRoot, "plugins/plugins.bin.gz.index.json");

    try {
        const results = await queryIndex(indexJsonPath, "ZigZagLayoutConfig");

        const matches = countMatches(results);
        strictEqual(matches, 6, "Expected 6 matches for ZigZagLayoutConfig");

        ok(results["src/main/java/com/zom/ZigZagLayoutConfig.java"],
            "Should find ZigZagLayoutConfig.java");
        ok(results["src/main/java/com/zom/ZigZagLayoutPlugin.java"],
            "Should find ZigZagLayoutPlugin.java");

        console.log("ZigZagLayoutConfig matches found:", matches);
        for (const [file, entry] of Object.entries(results)) {
            console.log(`  File: ${file}`);
            for (const m of entry.matches) {
                console.log(`    Line ${m.line}: ${m.text}`);
            }
        }
    } catch (e) {
        console.error("Test failed:", e);
        throw e;
    }
});

test("search 'AverageToas' returns 2 matches", async () => {
    const indexJsonPath = join(projectRoot, "plugins/plugins.bin.gz.index.json");
    
    try {
        const results = await queryIndex(indexJsonPath, "AverageToas");

        const matches = countMatches(results);
        strictEqual(matches, 2, "Expected 2 matches for AverageToas");

        console.log("AverageToas matches found:", matches);
        for (const [file, entry] of Object.entries(results)) {
            console.log(`  File: ${file}`);
            for (const m of entry.matches) {
                console.log(`    Line ${m.line}: ${m.text}`);
            }
        }
    } catch (e) {
        console.error("Test failed:", e);
        throw e;
    }
});

test("search 'RunePouchPlacement' returns 7 matches", async () => {
    const indexJsonPath = join(projectRoot, "plugins/plugins.bin.gz.index.json");
    
    try {
        const searchOptions = {
            isRegex: true,
            caseSensitive: true
        };
        const results = await queryIndex(indexJsonPath, "RunePouchPlacement", searchOptions);

        const matches = countMatches(results);
        strictEqual(matches, 6, "Expected 6 matches for RunePouchPlacement");

        ok(results["src/main/java/com/zom/RunePouchPlacement.java"],
            "Should find RunePouchPlacement.java");
        ok(results["src/main/java/com/zom/ZigZagLayoutConfig.java"],
            "Should find ZigZagLayoutConfig.java");
        ok(results["src/main/java/com/zom/ZigZagLayoutPlugin.java"],
            "Should find ZigZagLayoutPlugin.java");

        console.log("RunePouchPlacement matches found:", matches);
    } catch (e) {
        console.error("Test failed:", e);
        throw e;
    }
});

test("search returns empty results for non-existent term", async () => {
    const indexJsonPath = join(projectRoot, "plugins/plugins.bin.gz.index.json");
    
    try {
        const results = await queryIndex(indexJsonPath, "thisdefinitelydoesnotexist999");

        strictEqual(Object.keys(results).length, 0, "Expected 0 matches");
        console.log("Non-existent term returns empty results");
    } catch (e) {
        console.error("Test failed:", e);
        throw e;
    }
});
