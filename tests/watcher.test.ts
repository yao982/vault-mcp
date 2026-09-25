import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { VaultFileWatcher } from "../src/watcher/fileWatcher.js";
import type { VaultIndexer } from "../src/indexer.js";

const hasShortPathComponent = (value: string) => value.split(/[\\/]/).some(part => /~\d+(?:\.|$)/i.test(part));
const shortTempAliasAvailable = process.platform === "win32" && hasShortPathComponent(path.resolve(os.tmpdir()));

test("watcher expands an available Windows 8.3 root before registering with chokidar", {
  skip: !shortTempAliasAvailable && "Requires a Windows temp path with an 8.3 alias.",
  timeout: 10_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-watcher-short-"));
  const shortRoot = fs.realpathSync(root);
  assert.ok(hasShortPathComponent(shortRoot), `expected an 8.3 path, got ${shortRoot}`);
  const nativeRoot = fs.realpathSync.native(root);
  assert.equal(hasShortPathComponent(nativeRoot), false, `native realpath should expand the 8.3 alias: ${nativeRoot}`);

  const indexed: string[] = [];
  const errors: unknown[] = [];
  const indexer = {
    indexSingleFile: async (relativePath: string) => { indexed.push(relativePath); },
    indexAll: async () => undefined,
    recordError: (error: unknown) => { errors.push(error); },
    drain: async () => undefined,
  } as unknown as VaultIndexer;
  const watcher = new VaultFileWatcher(shortRoot, indexer);

  try {
    await watcher.start();
    fs.writeFileSync(path.join(root, "watcher-event.md"), "short path watcher regression");
    const deadline = Date.now() + 5_000;
    while (indexed.length === 0 && Date.now() < deadline) await delay(25);
    assert.ok(indexed.includes("watcher-event.md"), `expected watcher event, got ${indexed.join(", ")}`);
    assert.deepEqual(errors, []);
  } finally {
    await watcher.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
