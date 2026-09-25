import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { INDEX_VERSION } from "../src/config.js";
import { VaultIndexer, type EmbeddingProvider } from "../src/indexer.js";
import { parseAndChunkMarkdown } from "../src/parser/markdown.js";
import { VaultDatabase } from "../src/storage/db.js";

const TEMP_PREFIX = "vault-mcp-indexer-test-";

function createTestVault(t: TestContext): { root: string; db: VaultDatabase; reopen: () => VaultDatabase } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let db = new VaultDatabase(root);
  let databaseOpen = true;
  t.after(() => {
    if (databaseOpen) db.close();
    removeTempRoot(root);
  });
  return {
    root,
    get db() { return db; },
    reopen() {
      if (databaseOpen) db.close();
      databaseOpen = false;
      db = new VaultDatabase(root);
      databaseOpen = true;
      return db;
    },
  };
}

function removeTempRoot(root: string): void {
  const absolute = path.resolve(root);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Refusing to remove a path outside this test's generated temp directory: ${absolute}`);
  }
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function embeddingProvider(
  getEmbedding: (text: string) => Promise<Float32Array> = async () => new Float32Array([1, 0]),
  state = "ready",
): EmbeddingProvider {
  return {
    getEmbedding,
    getStatus: () => ({ state }),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test("retains searchable text and reports the precise chunk when embedding fails", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  const source = "# First\nalpha unique\n\n# Second\nbeta unique";
  fs.writeFileSync(path.join(root, "broken.md"), source, "utf8");
  const provider = embeddingProvider(async (text) => {
    if (text.includes("beta unique")) throw new Error("simulated embedding failure");
    return new Float32Array([1, 0]);
  });

  const status = await new VaultIndexer(root, db, provider).indexAll();

  assert.equal(status.state, "degraded");
  assert.equal(status.failedFiles, 1);
  assert.match(status.lastError ?? "", /broken\.md L4: simulated embedding failure/);
  assert.equal(db.searchBM25("beta")[0]?.content, "# Second\nbeta unique");
  assert.equal(db.getDocumentState("broken.md")?.vectorsComplete, false);
  assert.equal(db.getStats().totalVectors, 1);
});

test("offline indexing skips model calls, then an active provider fills incomplete vectors", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  fs.writeFileSync(path.join(root, "offline.md"), "offline searchable content", "utf8");
  let disabledCalls = 0;
  const disabled = embeddingProvider(async () => {
    disabledCalls++;
    throw new Error("disabled embedding provider must not be called");
  }, "disabled");

  const offlineStatus = await new VaultIndexer(root, db, disabled).indexAll();
  assert.equal(offlineStatus.state, "ready");
  assert.equal(offlineStatus.updatedFiles, 1);
  assert.equal(disabledCalls, 0);
  assert.equal(db.getDocumentState("offline.md")?.vectorsComplete, false);
  assert.equal(db.searchBM25("searchable")[0]?.relativePath, "offline.md");

  let activeCalls = 0;
  const active = embeddingProvider(async () => {
    activeCalls++;
    return new Float32Array([0, 1]);
  });
  const refreshed = await new VaultIndexer(root, db, active).indexSingleFile("offline.md");
  assert.equal(refreshed, "updated");
  assert.equal(activeCalls, 1);
  assert.equal(db.getDocumentState("offline.md")?.vectorsComplete, true);
  assert.equal(db.getStats().totalVectors, 1);
});

test("skips an unchanged complete document without calling the embedding provider", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  fs.writeFileSync(path.join(root, "stable.md"), "stable content for indexing", "utf8");
  let initialCalls = 0;
  await new VaultIndexer(root, db, embeddingProvider(async () => {
    initialCalls++;
    return new Float32Array([1, 0]);
  })).indexAll();
  assert.equal(initialCalls, 1);

  let retryCalls = 0;
  const status = await new VaultIndexer(root, db, embeddingProvider(async () => {
    retryCalls++;
    return new Float32Array([0, 1]);
  })).indexAll();

  assert.equal(status.state, "ready");
  assert.equal(status.skippedFiles, 1);
  assert.equal(retryCalls, 0);
});

test("recomputes embeddings when the stored index version is stale", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  const source = "old index metadata must be recomputed";
  fs.writeFileSync(path.join(root, "stale.md"), source, "utf8");
  const stat = fs.statSync(path.join(root, "stale.md"));
  const chunks = parseAndChunkMarkdown(source);
  db.saveDocument(
    "stale.md",
    "markdown",
    null,
    stat.mtimeMs,
    chunks,
    chunks.map(() => new Float32Array([1, 0])),
    { contentHash: hash(source), indexVersion: `${INDEX_VERSION}-old` },
  );
  let calls = 0;

  const status = await new VaultIndexer(root, db, embeddingProvider(async () => {
    calls++;
    return new Float32Array([0, 1]);
  })).indexAll();

  assert.equal(status.updatedFiles, 1);
  assert.equal(calls, 1);
  assert.equal(db.getDocumentState("stale.md")?.indexVersion, INDEX_VERSION);
  assert.equal(db.getDocumentState("stale.md")?.vectorsComplete, true);
});

test("a queued newer update wins over an older embedding task", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  const filename = path.join(root, "race.md");
  const oldContent = "old snapshot content";
  const newContent = "new snapshot content";
  fs.writeFileSync(filename, oldContent, "utf8");
  const firstEmbeddingEntered = deferred();
  const releaseFirstEmbedding = deferred();
  let calls = 0;
  const provider = embeddingProvider(async () => {
    calls++;
    if (calls === 1) {
      firstEmbeddingEntered.resolve();
      await releaseFirstEmbedding.promise;
      return new Float32Array([1, 0]);
    }
    return new Float32Array([0, 1]);
  });
  const indexer = new VaultIndexer(root, db, provider);

  const oldTask = indexer.indexSingleFile("race.md");
  await firstEmbeddingEntered.promise;
  fs.writeFileSync(filename, newContent, "utf8");
  const newTask = indexer.indexSingleFile("race.md");
  releaseFirstEmbedding.resolve();
  const [oldResult, newResult] = await Promise.all([oldTask, newTask]);

  assert.equal(oldResult, "superseded");
  assert.equal(newResult, "updated");
  assert.equal(db.getDocumentState("race.md")?.contentHash, hash(newContent));
  assert.equal(db.searchBM25("new")[0]?.content, newContent);
  assert.equal(db.searchBM25("old").length, 0);
});

test("a queued deletion prevents an older in-flight task from restoring a document", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  const filename = path.join(root, "removed.md");
  fs.writeFileSync(filename, "document before deletion", "utf8");
  await new VaultIndexer(root, db, embeddingProvider()).indexSingleFile("removed.md");
  fs.writeFileSync(filename, "changed while the old update is running", "utf8");
  const firstEmbeddingEntered = deferred();
  const releaseFirstEmbedding = deferred();
  const provider = embeddingProvider(async () => {
    firstEmbeddingEntered.resolve();
    await releaseFirstEmbedding.promise;
    return new Float32Array([0, 1]);
  });
  const indexer = new VaultIndexer(root, db, provider);

  const oldTask = indexer.indexSingleFile("removed.md");
  await firstEmbeddingEntered.promise;
  fs.rmSync(filename);
  const deletionTask = indexer.indexSingleFile("removed.md");
  releaseFirstEmbedding.resolve();
  const [oldResult, deletionResult] = await Promise.all([oldTask, deletionTask]);

  assert.equal(oldResult, "superseded");
  assert.equal(deletionResult, "deleted");
  assert.equal(db.getDocumentState("removed.md"), null);
  assert.equal(db.searchBM25("document before deletion").length, 0);
});

test("retries the snapshot when file contents change before the watcher event arrives", { timeout: 5_000 }, async (t) => {
  const { root, db } = createTestVault(t);
  const filename = path.join(root, "delayed-event.md");
  const oldContent = "content captured by the first snapshot";
  const newContent = "content changed before the watcher event";
  fs.writeFileSync(filename, oldContent, "utf8");
  const firstEmbeddingEntered = deferred();
  const releaseFirstEmbedding = deferred();
  const inputs: string[] = [];
  const provider = embeddingProvider(async (text) => {
    inputs.push(text);
    if (inputs.length === 1) {
      firstEmbeddingEntered.resolve();
      await releaseFirstEmbedding.promise;
    }
    return new Float32Array([1, 0]);
  });
  const indexer = new VaultIndexer(root, db, provider);

  const task = indexer.indexSingleFile("delayed-event.md");
  await firstEmbeddingEntered.promise;
  fs.writeFileSync(filename, newContent, "utf8");
  releaseFirstEmbedding.resolve();
  const result = await task;

  assert.equal(result, "updated");
  assert.equal(inputs.length, 2);
  assert.ok(inputs.some((text) => text.includes(oldContent)));
  assert.ok(inputs.some((text) => text.includes(newContent)));
  assert.equal(db.getDocumentState("delayed-event.md")?.contentHash, hash(newContent));
  assert.equal(db.searchBM25("changed")[0]?.content, newContent);
  assert.equal(db.searchBM25("captured").length, 0);
});

test("removes a missing known document during offline reconciliation and keeps it deleted after restart", { timeout: 5_000 }, async (t) => {
  const vault = createTestVault(t);
  const root = vault.root;
  let db = vault.db;
  const filename = path.join(root, "retired.md");
  fs.writeFileSync(filename, "known before offline restart", "utf8");
  let modelCalls = 0;
  const disabled = embeddingProvider(async () => {
    modelCalls++;
    throw new Error("offline mode must not request embeddings");
  }, "disabled");
  await new VaultIndexer(root, db, disabled).indexAll();
  assert.equal(db.getDocumentState("retired.md")?.vectorsComplete, false);
  fs.rmSync(filename);

  db = vault.reopen();
  const status = await new VaultIndexer(root, db, disabled).indexAll();

  assert.equal(status.state, "ready");
  assert.deepEqual(db.listDocumentPaths(), []);
  assert.equal(db.getDocumentState("retired.md"), null);
  assert.equal(modelCalls, 0);

  db = vault.reopen();
  assert.deepEqual(db.listDocumentPaths(), []);
  assert.equal(db.searchBM25("known before offline restart").length, 0);
});
