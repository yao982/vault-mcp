import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";
import { INDEX_VERSION } from "../src/config.js";
import { MarkdownChunk } from "../src/parser/markdown.js";
import { VaultDatabase } from "../src/storage/db.js";
import { getEmbeddingProfile } from "../src/storage/profiles.js";

function withVault(run: (root: string, createDb: () => VaultDatabase) => void) {
  const root = mkdtempSync(path.join(os.tmpdir(), "vault-mcp-db-test-"));
  const databases: VaultDatabase[] = [];
  const createDb = () => {
    const db = new VaultDatabase(root);
    databases.push(db);
    return db;
  };
  try {
    run(root, createDb);
  } finally {
    for (const db of databases) {
      try { db.close(); } catch { /* already closed by the test */ }
    }
    // Each test creates and removes only its own randomly named temp directory.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function chunk(content: string, startLine: number, headingPath = "Root"): MarkdownChunk {
  return { content, startLine, endLine: startLine, headingPath };
}

test("BM25 finds Chinese single and bigram terms and preserves English identifiers", () => {
  withVault((root, createDb) => {
    const db = createDb();
    db.saveDocument(
      "控制/notes.md",
      "markdown",
      null,
      1,
      [
        chunk("PID自适应控制器通过C中文API处理指针。", 3, "控制理论"),
        chunk("自适应PID控制器调用 searchHybrid。", 9, "混合检索")
      ],
      undefined,
      { contentHash: "hash-1", indexVersion: INDEX_VERSION }
    );

    assert.equal(db.searchBM25("指")[0]?.startLine, 3);
    assert.equal(db.searchBM25("指针")[0]?.content, "PID自适应控制器通过C中文API处理指针。");
    assert.equal(db.searchBM25("自适应控制")[0]?.headingPath, "控制理论");
    assert.deepEqual(db.searchBM25("自适应").map((result) => result.startLine).sort(), [3, 9]);
    assert.deepEqual(db.searchBM25("PID").map((result) => result.startLine).sort(), [3, 9]);
    assert.deepEqual(db.searchBM25("PID自适应控制").map((result) => result.startLine).sort(), [3, 9]);
    assert.equal(db.searchBM25("C")[0]?.startLine, 3);
    assert.equal(db.searchBM25("API")[0]?.startLine, 3);
    assert.equal(db.searchBM25("searchHybrid")[0]?.relativePath, "控制/notes.md");
    const ranked = db.searchBM25("PID");
    assert.equal(ranked[0].score, -(ranked[0].bm25Rank ?? 0));
    assert.notEqual(ranked[0].score, Math.round(ranked[0].score * 100) / 100);
    assert.deepEqual(db.searchBM25(" !!! "), []);
    db.close();
  });
});

test("long Chinese bigram AND gives candidates only when all terms exist", () => {
  withVault((root, createDb) => {
    const db = createDb();
    db.saveDocument(
      "phrases.md",
      "markdown",
      null,
      1,
      [
        chunk("自主适应控制", 1),
        chunk("自主适与适应控制", 2),
        chunk("自主适 与 控制", 3)
      ],
      []
    );

    // AND requires each bigram, but FTS does not enforce their order or adjacency.
    assert.deepEqual(db.searchBM25("自主适应控制").map((result) => result.startLine).sort(), [1, 2]);
    db.close();
  });
});

test("null embeddings keep chunk alignment and mark vectors incomplete across restart", () => {
  withVault((root, createDb) => {
    let db = createDb();
    db.saveDocument(
      "two.md",
      "markdown",
      "papers/two.pdf",
      2,
      [chunk("first chunk", 10), chunk("second chunk", 20)],
      [null, new Float32Array([0.25, 0.75])],
      { contentHash: "content-2", indexVersion: INDEX_VERSION }
    );

    const result = db.searchVector(new Float32Array([1, 0]));
    assert.equal(result.length, 1);
    assert.equal(result[0].content, "second chunk");
    assert.equal(result[0].startLine, 20);
    assert.equal(db.getStats().totalVectors, 1);
    assert.equal(db.getStats().incompleteDocuments, 1);
    assert.equal(db.getDocumentState("two.md")?.vectorsComplete, false);
    db.close();

    db = createDb();
    assert.deepEqual(db.getDocumentState("two.md"), {
      contentHash: "content-2",
      indexVersion: INDEX_VERSION,
      originalPdf: "papers/two.pdf",
      vectorsComplete: false
    });
    assert.deepEqual(db.listDocumentPaths(), ["two.md"]);
    assert.equal(db.searchBM25("second")[0]?.content, "second chunk");
    db.close();
  });
});

test("hybrid RRF preserves separate PDF pages when chunk line numbers repeat", () => {
  withVault((root, createDb) => {
    const db = createDb();
    db.saveDocument(
      "paper.pdf", "pdf", "paper.pdf", 2,
      [
        { ...chunk("alpha result one", 1, "PDF page 1"), pageStart: 1, pageEnd: 1 },
        { ...chunk("alpha result two", 1, "PDF page 2"), pageStart: 2, pageEnd: 2 },
      ],
      [new Float32Array([0.8, 0.2]), new Float32Array([0.2, 0.8])],
      { contentHash: "pdf-derived-hash", indexVersion: INDEX_VERSION, sourceType: "pdf", sourceVersion: "pdf-source-hash", sourceId: "paper.pdf" }
    );

    const lexical = db.searchBM25("alpha", 5);
    const hybrid = db.searchHybrid("alpha", new Float32Array([1, 0]), 5);

    assert.equal(lexical.length, 2);
    assert.equal(hybrid.length, 2);
    assert.deepEqual(new Set(hybrid.map((result) => result.pageStart)), new Set([1, 2]));
    assert.equal(new Set(hybrid.map((result) => result.citationId)).size, 2);
    db.close();
  });
});

test("reopening preserves current-version vectors and removes old-version vectors only", () => {
  withVault((root, createDb) => {
    let db = createDb();
    db.saveDocument(
      "current.md",
      "markdown",
      null,
      3,
      [chunk("current vector source", 1)],
      [new Float32Array([1, 0])],
      { contentHash: "hash-current", indexVersion: INDEX_VERSION }
    );
    db.close();

    db = createDb();
    assert.equal(db.getStats().totalVectors, 1);
    assert.equal(db.getStats().incompleteDocuments, 0);
    assert.equal(db.getDocumentState("current.md")?.vectorsComplete, true);
    db.close();

    const raw = new Database(path.join(root, ".vault_index.db"));
    raw.prepare("UPDATE documents SET index_version = ?, vectors_complete = 1 WHERE relative_path = ?")
      .run("stale-index", "current.md");
    raw.close();

    db = createDb();
    assert.equal(db.getStats().totalVectors, 0);
    assert.equal(db.getStats().incompleteDocuments, 1);
    assert.equal(db.getDocumentState("current.md")?.vectorsComplete, false);
    assert.equal(db.getDocumentState("current.md")?.contentHash, "hash-current");
    assert.equal(db.searchBM25("current vector")[0]?.content, "current vector source");
    db.close();
  });
});

test("embedding profile changes isolate vector spaces while preserving text", () => {
  withVault((root, createDb) => {
    let db = createDb();
    assert.equal(db.getEmbeddingProfile(), "multilingual-e5-small");
    db.saveDocument("profile.md", "markdown", null, 1, [chunk("profile isolation text", 1)], [new Float32Array([1, 0])], {
      contentHash: "profile-hash", indexVersion: INDEX_VERSION,
    });
    assert.equal(db.getStats().totalVectors, 1);

    db.setEmbeddingProfile("bge-small-zh");
    assert.equal(db.getStats().totalVectors, 0);
    assert.equal(db.getDocumentState("profile.md")?.vectorsComplete, false);
    assert.equal(db.searchBM25("isolation")[0]?.content, "profile isolation text");
    db.close();

    db = createDb();
    assert.equal(db.getEmbeddingProfile(), "bge-small-zh");
    assert.equal(db.getStats().totalVectors, 0);
    db.close();

    const raw = new Database(path.join(root, ".vault_index.db"), { readonly: true });
    const config = raw.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_config'").get() as { value: string };
    assert.deepEqual(JSON.parse(config.value), getEmbeddingProfile("bge-small-zh"));
    raw.close();
  });
});

test("read-only rejects missing or changed embedding config and writer clears incompatible vectors", () => {
  withVault((root, createDb) => {
    let db = createDb();
    db.saveDocument("fingerprint.md", "markdown", null, 1, [chunk("old fingerprint searchable text", 1)], [new Float32Array([1, 0])], {
      contentHash: "fingerprint-content", indexVersion: INDEX_VERSION,
    });
    db.close();

    let raw = new Database(path.join(root, ".vault_index.db"));
    const configRow = raw.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_config'").get() as { value: string };
    const oldConfig = JSON.parse(configRow.value);
    oldConfig.fingerprint = "old-implementation-fingerprint";
    raw.prepare("UPDATE vault_metadata SET value = ? WHERE key = 'embedding_config'").run(JSON.stringify(oldConfig));
    raw.close();
    assert.throws(() => new VaultDatabase(root, { readonly: true }), /embedding配置缺失或与当前程序不一致/);

    db = createDb();
    assert.equal(db.getStats().totalVectors, 0);
    assert.equal(db.getDocumentState("fingerprint.md")?.vectorsComplete, false);
    assert.equal(db.searchBM25("fingerprint")[0]?.content, "old fingerprint searchable text");
    db.saveDocument("fingerprint.md", "markdown", null, 1, [chunk("old fingerprint searchable text", 1)], [new Float32Array([1, 0])], {
      contentHash: "fingerprint-content", indexVersion: INDEX_VERSION,
    });
    db.close();

    raw = new Database(path.join(root, ".vault_index.db"));
    raw.prepare("DELETE FROM vault_metadata WHERE key = 'embedding_config'").run();
    raw.close();
    assert.throws(() => new VaultDatabase(root, { readonly: true }), /embedding配置缺失或与当前程序不一致/);

    db = createDb();
    assert.equal(db.getStats().totalVectors, 0);
    db.close();
    const readonlyDb = new VaultDatabase(root, { readonly: true });
    assert.equal(readonlyDb.getEmbeddingProfile(), "multilingual-e5-small");
    readonlyDb.close();

    raw = new Database(path.join(root, ".vault_index.db"), { readonly: true });
    const repairedRow = raw.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_config'").get() as { value: string };
    assert.deepEqual(JSON.parse(repairedRow.value), getEmbeddingProfile("multilingual-e5-small"));
    raw.close();
  });
});

test("legacy databases gain metadata and Chinese search text while stale vectors are discarded", () => {
  withVault((root, createDb) => {
    const old = new Database(path.join(root, ".vault_index.db"));
    old.exec(`
      CREATE TABLE documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relative_path TEXT UNIQUE NOT NULL,
        file_type TEXT NOT NULL,
        original_pdf TEXT,
        mtime INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        relative_path, original_pdf UNINDEXED, heading_path,
        start_line UNINDEXED, end_line UNINDEXED, content, tokenize = 'unicode61'
      );
      CREATE TABLE chunk_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relative_path TEXT NOT NULL,
        original_pdf TEXT,
        heading_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `);
    old.prepare(`INSERT INTO documents (relative_path, file_type, original_pdf, mtime, created_at)
      VALUES (?, ?, ?, ?, ?)`).run("old.md", "markdown", "old.pdf", 5, 6);
    old.prepare(`INSERT INTO chunks_fts
      (relative_path, original_pdf, heading_path, start_line, end_line, content)
      VALUES (?, ?, ?, ?, ?, ?)`).run("old.md", "old.pdf", "指针", 7, 7, "旧格式中的自适应控制正文");
    old.prepare(`INSERT INTO chunk_vectors
      (relative_path, original_pdf, heading_path, start_line, end_line, content, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        "old.md", "old.pdf", "指针", 7, 7, "旧格式中的自适应控制正文", Buffer.from(new Float32Array([1, 0]).buffer)
      );
    old.close();

    assert.throws(() => new VaultDatabase(root, { readonly: true }), /数据库需要升级/);

    const db = createDb();
    assert.deepEqual(db.getDocumentState("old.md"), {
      contentHash: "",
      indexVersion: "",
      originalPdf: "old.pdf",
      vectorsComplete: false
    });
    assert.equal(db.getStats().totalVectors, 0);
    assert.equal(db.getStats().incompleteDocuments, 1);
    assert.equal(db.searchBM25("自适应控制")[0]?.content, "旧格式中的自适应控制正文");
    assert.equal(db.searchBM25("指针")[0]?.startLine, 7);
    db.close();
  });
});

test("reopening preserves the explicit PDF-import source type and cached text", () => {
  withVault((root, createDb) => {
    let db = createDb();
    db.saveDocument("imported.pdf", "pdf-import", "imported.pdf", 9,
      [{ ...chunk("converted evidence", 1), pageStart: 3, pageEnd: 3 }], [null], {
        contentHash: "derived-import-hash", indexVersion: INDEX_VERSION,
        sourceType: "pdf-import", sourceVersion: "original-pdf-hash", sourceId: "imported.pdf",
        parseVersion: "import-v1",
        pdfExtraction: {
          status: "ready", sourceHash: "original-pdf-hash", inputHash: "derived-import-hash",
          parseVersion: "import-v1", pageCount: 4, extractedPageCount: 1, coverage: 0.25,
          coverageKind: "mapped", error: null, stale: false,
          pages: [{ page: 3, text: "converted evidence" }],
        },
      });
    db.close();

    db = createDb();
    assert.equal(db.getDocumentSourceState("imported.pdf")?.sourceType, "pdf-import");
    assert.equal(db.getPdfState("imported.pdf")?.status, "ready");
    assert.deepEqual(db.getPdfPages("imported.pdf"), [{ page: 3, text: "converted evidence" }]);
    db.close();
  });
});

test("vector ordering keeps full score precision and rejects invalid dimensions or values", () => {
  withVault((root, createDb) => {
    const db = createDb();
    db.saveDocument(
      "precision.md",
      "markdown",
      null,
      4,
      [chunk("lower", 1), chunk("higher", 2)],
      [new Float32Array([0.1111]), new Float32Array([0.1122])],
      { contentHash: "hash-precision", indexVersion: INDEX_VERSION }
    );

    const results = db.searchVector(new Float32Array([1]));
    assert.equal(results[0].content, "higher");
    assert.ok(results[0].score > results[1].score);
    assert.equal(results[0].score, results[0].vectorScore);
    assert.notEqual(results[0].score, Math.round(results[0].score * 100) / 100);
    assert.throws(() => db.searchVector(new Float32Array([1, 0])), /dimension mismatch/i);
    assert.throws(() => db.searchVector(new Float32Array([Number.NaN])), /non-finite/i);
    assert.throws(() => db.saveDocument(
      "invalid.md", "markdown", null, 5, [chunk("invalid", 1)],
      [new Float32Array([Number.POSITIVE_INFINITY])]
    ), /non-finite/i);
    db.close();
  });
});
