#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Configuration
const PLUGINS_DIR = path.join(process.cwd(), 'plugins');
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_FILE = path.join(OUT_DIR, 'search-index.json');

function tokenize(text) {
  return Array.from(new Set(
    text.toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter(Boolean)
  ));
}

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function buildIndex() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.error(`Plugins directory not found: ${PLUGINS_DIR}`);
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.gz'));
  const index = Object.create(null); // token -> array of filenames
  const filesMeta = Object.create(null);
  const symbolLocations = Object.create(null); // token -> array of {plugin, file, line}

  for (const filename of files) {
    const filePath = path.join(PLUGINS_DIR, filename);
    let gz;
    try {
      gz = fs.readFileSync(filePath);
    } catch (err) {
      console.warn(`Failed to read ${filePath}: ${err.message}`);
      continue;
    }

    let buf;
    try {
      buf = zlib.gunzipSync(gz);
    } catch (err) {
      console.warn(`Failed to gunzip ${filename}: ${err.message}`);
      continue;
    }

    const text = buf.toString('utf8');

    // Track file metadata
    filesMeta[filename] = {
      size: buf.length,
      url: `/plugins/${filename}`
    };

    // Tokenize whole content for the index (which maps token -> filenames)
    const tokens = tokenize(text);
    for (const t of tokens) {
      if (!index[t]) index[t] = [];
      index[t].push(filename);
    }

    // Build symbolLocations by scanning line-by-line so we can record line numbers
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (!lineText) continue;
      const lineTokens = tokenize(lineText);
      for (const t of lineTokens) {
        if (!symbolLocations[t]) symbolLocations[t] = [];
        // file is left null because we don't have internal path; change if available
        symbolLocations[t].push({ plugin: filename, file: null, line: i + 1 });
      }
    }
  }

  // Stable sorting for cleaner diffs and stable entries order
  for (const t of Object.keys(index)) index[t].sort();
  const entries = Object.keys(index)
    .sort((a, b) => a.localeCompare(b))
    .map(k => [k, index[k]]);

  // Convert symbolLocations sets to stable arrays (already arrays) — optionally sort by plugin/name/line
  for (const k of Object.keys(symbolLocations)) {
    symbolLocations[k].sort((a, b) => {
      if (a.plugin !== b.plugin) return a.plugin.localeCompare(b.plugin);
      return a.line - b.line;
    });
  }

  ensureOutDir();
  const out = {
    generatedAt: new Date().toISOString(),
    files: filesMeta,            // existing metadata
    index,                       // object mapping token -> [filenames] (backwards-compatible)
    entries,                     // array of [token, [filenames]] — matches your buildIndex() result shape
    symbolLocations              // mapping token -> [{plugin, file, line}]
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Wrote search index with ${entries.length} tokens for ${Object.keys(filesMeta).length} files to ${OUT_FILE}`);
}

buildIndex();
