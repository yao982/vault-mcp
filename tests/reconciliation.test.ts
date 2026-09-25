import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { VaultIndexer, type EmbeddingProvider } from "../src/indexer.js";
import { VaultDatabase } from "../src/storage/db.js";

const PREFIX = "vault-mcp-reconciliation-";
const disabled: EmbeddingProvider = {
  getStatus: () => ({ state: "disabled" }),
  getEmbedding: async () => { throw new Error("Disabled provider must not be called"); },
};

function fixture(t: TestContext, inside: boolean) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const root = path.join(base, "vault");
  const target = path.join(inside ? root : base, "target");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const source = path.join(root, "old");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "a.md"), "original indexed record");
  fs.writeFileSync(path.join(target, "a.md"), "target must survive link cleanup");
  fs.writeFileSync(path.join(root, "good.md"), "healthy searchable record");
  const db = new VaultDatabase(root);
  t.after(() => {
    db.close();
    // Remove the junction itself before any recursive cleanup. Never traverse it.
    if (fs.existsSync(source) && fs.lstatSync(source).isSymbolicLink()) fs.unlinkSync(source);
    assert.equal(fs.readFileSync(path.join(target, "a.md"), "utf8"), "target must survive link cleanup");
    const absolute = path.resolve(base);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith(PREFIX));
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const replaceWithLink = () => {
    fs.renameSync(source, path.join(base, "previous-source"));
    fs.symlinkSync(target, source, process.platform === "win32" ? "junction" : "dir");
  };
  return { root, source, target, db, replaceWithLink };
}

for (const inside of [false, true]) {
  const location = inside ? "inside" : "outside";
  test(`startup removes old records through a directory link ${location} the vault and indexes healthy files`, async (t) => {
    const { root, db, replaceWithLink } = fixture(t, inside);
    await new VaultIndexer(root, db, disabled).indexSingleFile("old/a.md");
    assert.ok(db.getDocumentState("old/a.md"));
    replaceWithLink();

    const status = await new VaultIndexer(root, db, disabled).indexAll();

    assert.equal(status.state, "ready");
    assert.equal(db.getDocumentState("old/a.md"), null);
    assert.equal(db.searchBM25("healthy")[0]?.relativePath, "good.md");
    assert.ok(!db.listDocumentPaths().some(name => name.startsWith("old/")));
  });

  test(`a directory replaced with a link ${location} the vault during embedding cannot commit stale content`, async (t) => {
    const { root, source, db, replaceWithLink } = fixture(t, inside);
    await new VaultIndexer(root, db, disabled).indexSingleFile("old/a.md");
    fs.writeFileSync(path.join(source, "a.md"), "new content awaiting embedding");
    let calls = 0;
    const provider: EmbeddingProvider = {
      getStatus: () => ({ state: "ready" }),
      getEmbedding: async () => {
        calls++;
        replaceWithLink();
        return new Float32Array([1, 0]);
      },
    };

    const result = await new VaultIndexer(root, db, provider).indexSingleFile("old/a.md");

    assert.equal(calls, 1);
    assert.equal(result, "deleted");
    assert.equal(db.getDocumentState("old/a.md"), null);
    const status = await new VaultIndexer(root, db, disabled).indexAll();
    assert.equal(status.state, "ready");
    assert.equal(db.searchBM25("healthy")[0]?.relativePath, "good.md");
  });
}

test("one failed known-path cleanup does not prevent healthy files from being indexed", async (t) => {
  const { root, source, db } = fixture(t, false);
  await new VaultIndexer(root, db, disabled).indexSingleFile("old/a.md");
  fs.unlinkSync(path.join(source, "a.md"));
  const originalDelete = db.deleteDocument.bind(db);
  t.mock.method(db, "deleteDocument", (relativePath: string) => {
    if (relativePath === "old/a.md") throw new Error("simulated cleanup failure");
    originalDelete(relativePath);
  });

  const status = await new VaultIndexer(root, db, disabled).indexAll();

  assert.equal(status.state, "degraded");
  assert.equal(status.failedFiles, 1);
  assert.match(status.lastError ?? "", /simulated cleanup failure/);
  assert.equal(db.searchBM25("healthy")[0]?.relativePath, "good.md");
});
