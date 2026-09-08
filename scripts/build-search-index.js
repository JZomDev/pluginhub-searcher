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
    const tokens = tokenize(text);

    filesMeta[filename] = {
      size: buf.length,
      url: `/plugins/${filename}`
    };

    for (const t of tokens) {
      if (!index[t]) index[t] = [];
      index[t].push(filename);
    }
  }

  // Stable sorting for cleaner diffs
  for (const t of Object.keys(index)) index[t].sort();

  ensureOutDir();
  const out = {
    generatedAt: new Date().toISOString(),
    files: filesMeta,
    index
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(`Wrote search index with ${Object.keys(index).length} tokens for ${Object.keys(filesMeta).length} files to ${OUT_FILE}`);
}

buildIndex();
