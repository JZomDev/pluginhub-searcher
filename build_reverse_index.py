#!/usr/bin/env python3
"""Build a static trigram reverse index over PluginHub source files.

Output layout (all files are gzip-compressed; served as opaque .bin files):

  manifest.bin        JSON: build id, plugin table, chunk table, shard count
  shards/NNNN.bin     trigram -> sorted file-id posting lists (FNV-1a sharded)
  chunks/NNNN.bin     JSON array of [pluginIndex, path, content] source files

The browser loads only the manifest at startup. A search fetches the posting
shards for its query trigrams in one parallel round, intersects them to find
candidate files, then fetches just the text chunks holding those files.
"""

import gzip
import hashlib
import json
import os
import shutil
import struct
import sys
from array import array
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

FORMAT_VERSION = 2
SHARD_COUNT = 1024
CHUNK_TARGET_BYTES = 512 * 1024
MAX_SOURCE_BYTES = 8 * 1024 * 1024
GRAM_ENTRY = struct.Struct("<3sII")


def shard_of(gram):
    """FNV-1a over the trigram bytes; mirrored in reverse-search-browser.js."""
    value = 0x811C9DC5
    for byte in gram:
        value = ((value ^ byte) * 0x01000193) & 0xFFFFFFFF
    return value % SHARD_COUNT


def _write_varint(output, value):
    while value >= 0x80:
        output.append((value & 0x7F) | 0x80)
        value >>= 7
    output.append(value)


def _gzip(data):
    return gzip.compress(data, compresslevel=9, mtime=0)


def _load_plugin(json_path):
    """Return (plugin record, [(path, content)], [sorted trigram bytes per file])."""
    json_path = Path(json_path)
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not parse {json_path}: {error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("files", []), list):
        raise ValueError(f"Invalid plugin JSON structure: {json_path}")

    plugin = [json_path.stem, data.get("repository") or "", data.get("commit") or ""]
    sources = []
    grams = []
    for source in data.get("files", []):
        if not isinstance(source, dict) or not isinstance(source.get("content"), str):
            continue
        content = source["content"]
        if len(content.encode("utf-8")) > MAX_SOURCE_BYTES:
            raise ValueError(
                f"Source block exceeds {MAX_SOURCE_BYTES} bytes: {json_path} / {source.get('filePath', '')}"
            )
        normalized = content.lower().encode("utf-8")
        file_grams = {normalized[index:index + 3] for index in range(len(normalized) - 2)}
        sources.append((source.get("filePath") or source.get("fileName") or "", content))
        grams.append(b"".join(sorted(file_grams)))
    return plugin, sources, grams


def build_index(source_dir, output_dir, workers=None):
    source_dir = Path(source_dir).resolve()
    output_dir = Path(output_dir).resolve()
    plugin_files = sorted(path for path in source_dir.rglob("*.json") if path.is_file())
    if not plugin_files:
        raise ValueError(f"No plugin JSON files found under {source_dir}")
    worker_count = min(os.cpu_count() or 1, 8) if workers is None else workers
    if worker_count < 1:
        raise ValueError("Worker count must be at least one")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    (output_dir / "chunks").mkdir(parents=True)
    (output_dir / "shards").mkdir()

    postings = {}
    plugins = []
    chunk_first_files = []
    chunk = []
    chunk_bytes = 0
    file_count = 0
    digest = hashlib.sha256()

    def flush_chunk():
        nonlocal chunk, chunk_bytes
        if not chunk:
            return
        payload = _gzip(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        (output_dir / "chunks" / f"{len(chunk_first_files) - 1:04d}.bin").write_bytes(payload)
        digest.update(payload)
        chunk = []
        chunk_bytes = 0

    with ProcessPoolExecutor(max_workers=min(worker_count, len(plugin_files))) as executor:
        results = executor.map(_load_plugin, map(str, plugin_files), chunksize=8)
        for processed, (plugin, sources, grams) in enumerate(results, start=1):
            plugin_index = len(plugins)
            plugins.append(plugin)
            for (path, content), file_grams in zip(sources, grams):
                if not chunk:
                    chunk_first_files.append(file_count)
                chunk.append([plugin_index, path, content])
                chunk_bytes += len(content)
                for offset in range(0, len(file_grams), 3):
                    gram = file_grams[offset:offset + 3]
                    posting = postings.get(gram)
                    if posting is None:
                        posting = postings[gram] = array("I")
                    posting.append(file_count)
                file_count += 1
                if chunk_bytes >= CHUNK_TARGET_BYTES:
                    flush_chunk()
            if processed % 250 == 0 or processed == len(plugin_files):
                print(f"Processed {processed:,}/{len(plugin_files):,} plugins", flush=True)
    flush_chunk()

    if file_count == 0:
        raise ValueError("No source files found; verify plugin JSON files contain files[].content values")

    shards = [[] for _ in range(SHARD_COUNT)]
    for gram in sorted(postings):
        shards[shard_of(gram)].append(gram)
    shard_bytes = 0
    for shard_index, grams in enumerate(shards):
        table = bytearray(struct.pack("<I", len(grams)))
        body = bytearray()
        for gram in grams:
            start = len(body)
            previous = -1
            posting = postings[gram]
            for file_id in posting:
                _write_varint(body, file_id - previous)
                previous = file_id
            table += GRAM_ENTRY.pack(gram, len(posting), len(body) - start)
        payload = _gzip(bytes(table + body))
        (output_dir / "shards" / f"{shard_index:04d}.bin").write_bytes(payload)
        digest.update(payload)
        shard_bytes += len(payload)

    manifest = {
        "version": FORMAT_VERSION,
        "build": digest.hexdigest()[:16],
        "fileCount": file_count,
        "shardCount": SHARD_COUNT,
        "chunks": chunk_first_files,
        "plugins": plugins,
    }
    manifest_payload = _gzip(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    (output_dir / "manifest.bin").write_bytes(manifest_payload)

    chunk_size = sum(path.stat().st_size for path in (output_dir / "chunks").iterdir())
    return {
        "output": output_dir,
        "plugins": len(plugins),
        "files": file_count,
        "grams": len(postings),
        "chunks": len(chunk_first_files),
        "manifestBytes": len(manifest_payload),
        "shardBytes": shard_bytes,
        "chunkBytes": chunk_size,
        "workers": worker_count,
    }


def main():
    if len(sys.argv) not in (3, 4):
        print("Usage: python3 build_reverse_index.py <plugins-data-dir> <output-dir> [workers]", file=sys.stderr)
        return 2
    try:
        worker_count = int(sys.argv[3]) if len(sys.argv) == 4 else None
        stats = build_index(sys.argv[1], sys.argv[2], worker_count)
    except (OSError, ValueError) as error:
        print(f"Index build failed: {error}", file=sys.stderr)
        return 1
    mib = 1024 * 1024
    print(f"Wrote {stats['output']}")
    print(f"  Plugins: {stats['plugins']:,}  Source files: {stats['files']:,}  Trigrams: {stats['grams']:,}")
    print(f"  Manifest: {stats['manifestBytes'] / 1024:.1f} KiB")
    print(f"  Posting shards: {SHARD_COUNT} files, {stats['shardBytes'] / mib:.1f} MiB")
    print(f"  Text chunks: {stats['chunks']} files, {stats['chunkBytes'] / mib:.1f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
