const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pluginsDir = path.join(root, 'plugins');
const splitsPath = path.join(pluginsDir, 'plugins_splits.json');
const outPath = path.join(pluginsDir, 'search-index.json');

function readJSON(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function addLine(symbol, pluginName, filePath, lineNumber, usageMap, locationMap) {
  if (!symbol) return;
  let plugins = usageMap.get(symbol);
  if (!plugins) {
    plugins = new Set();
    usageMap.set(symbol, plugins);
  }
  plugins.add(pluginName);

  if (filePath != null && lineNumber != null) {
    let locations = locationMap.get(symbol);
    if (!locations) {
      locations = [];
      locationMap.set(symbol, locations);
    }
    locations.push({ plugin: pluginName, file: filePath, line: lineNumber });
  }
}

function collectLines(plugin) {
  const internalName = plugin.internalName;
  if (!internalName) return [];
  const lines = [];

  if (typeof plugin.content === 'string') {
    const parts = plugin.content.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue;
      lines.push({ text: parts[i], file: null, line: i + 1 });
    }
  }

  if (Array.isArray(plugin.files)) {
    for (const f of plugin.files) {
      if (!f) continue;
      let filePath = null;
      let content = null;
      if (typeof f === 'string') {
        filePath = f;
      } else {
        filePath = f.filePath || f.fileName || null;
        content = f.content || null;
      }
      if (typeof content !== 'string') continue;
      const parts = content.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '') continue;
        lines.push({ text: parts[i], file: filePath, line: i + 1 });
      }
    }
  }

  return lines;
}

function buildIndex() {
  const splits = readJSON(splitsPath);
  if (!Array.isArray(splits)) {
    throw new Error('plugins_splits.json must contain an array of file names');
  }

  const usageMap = new Map();
  const locationMap = new Map();
  let pluginCount = 0;
  let lineCount = 0;

  for (const fileName of splits) {
    if (!fileName) continue;
    const filePath = path.join(pluginsDir, fileName);
    if (!fs.existsSync(filePath)) continue;
    const plugins = readJSON(filePath);
    if (!Array.isArray(plugins)) continue;
    for (const plugin of plugins) {
      if (!plugin || !plugin.internalName) continue;
      pluginCount += 1;
      for (const line of collectLines(plugin)) {
        addLine(line.text, plugin.internalName, line.file, line.line, usageMap, locationMap);
        lineCount += 1;
      }
    }
  }

  const usages = [...usageMap.entries()]
    .map(([symbol, plugins]) => [symbol, [...plugins].sort()])
    .sort((a, b) => a[0].localeCompare(b[0]));

  const symbolLocations = [...locationMap.entries()]
    .map(([symbol, locations]) => [symbol, locations]);

  const output = {
    usages,
    symbolLocations,
  };

  fs.writeFileSync(outPath, JSON.stringify(output));
  console.log(`Built search index for ${pluginCount} plugins, ${lineCount} indexed lines, ${usages.length} symbols.`);
  const stats = fs.statSync(outPath);
  console.log(`Wrote ${outPath} (${stats.size.toLocaleString()} bytes)`);
}

buildIndex();
