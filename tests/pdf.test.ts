import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { PDFDocument } from "pdf-lib";
import { VaultIndexer, type EmbeddingProvider } from "../src/indexer.js";
import { validateImportManifest } from "../src/parser/imports.js";
import { extractPdfPages } from "../src/parser/pdf.js";
import { VaultDatabase } from "../src/storage/db.js";

const TEMP_PREFIX = "vault-mcp-pdf-test-";

function createVault(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let db = new VaultDatabase(root);
  let closed = false;
  t.after(() => {
    if (!closed) db.close();
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith(TEMP_PREFIX)) {
      throw new Error(`Refusing to remove a path outside this PDF test's generated directory: ${absolute}`);
    }
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    root,
    get db() { return db; },
    reopen() {
      if (!closed) db.close();
      db = new VaultDatabase(root);
      closed = false;
      return db;
    },
    close() {
      if (!closed) db.close();
      closed = true;
    },
  };
}

const offlineProvider: EmbeddingProvider = {
  getStatus: () => ({ state: "disabled" }),
  getEmbedding: async () => { throw new Error("offline provider must not be called"); },
};

async function makePdf(pages: Array<string | null>): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (const text of pages) {
    const page = document.addPage();
    if (text) page.drawText(text);
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function makeEncryptedPdf(): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.addPage().drawText("encrypted fixture marker");
  const source = Buffer.from(await document.save({ useObjectStreams: false }));
  const text = source.toString("latin1");
  const xrefStart = text.lastIndexOf("\nxref\n") + 1;
  const trailerStart = text.indexOf("trailer", xrefStart);
  const originalSize = Number(text.slice(trailerStart).match(/\/Size\s+(\d+)/)?.[1]);
  assert.ok(Number.isSafeInteger(originalSize) && originalSize > 0);

  // Add a valid Standard security dictionary and xref subsection. PDF.js must
  // request a password before it can expose even this unencrypted test text.
  const object = `${originalSize} 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>\nendobj\n`;
  const prefix = text.slice(0, xrefStart) + object;
  const xrefOffset = Buffer.byteLength(prefix, "latin1");
  const objectOffset = Buffer.byteLength(text.slice(0, xrefStart), "latin1");
  const oldXref = text.slice(xrefStart, trailerStart);
  const trailerEnd = text.lastIndexOf("startxref");
  const trailer = text.slice(trailerStart, trailerEnd)
    .replace(/\/Size\s+\d+/, `/Size ${originalSize + 1}`)
    .replace("<<", `<<\n/Encrypt ${originalSize} 0 R`);
  const encrypted = prefix + oldXref +
    `${originalSize} 1\n${objectOffset.toString().padStart(10, "0")} 00000 n\n` +
    trailer + `startxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(encrypted, "latin1");
}

test("native PDF extraction keeps physical page boundaries, blank-page coverage and restart cache", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  fs.writeFileSync(path.join(vault.root, "paper.pdf"), await makePdf(["hydraulic alpha marker", null]));
  const indexer = new VaultIndexer(vault.root, vault.db, offlineProvider);

  assert.equal(await indexer.indexSingleFile("paper.pdf"), "updated");
  const state = vault.db.getPdfState("paper.pdf");
  assert.equal(state?.status, "ready");
  assert.equal(state?.pageCount, 2);
  assert.equal(state?.extractedPageCount, 1);
  assert.equal(state?.coverage, 0.5);
  assert.deepEqual(vault.db.getPdfPages("paper.pdf"), [
    { page: 1, text: "hydraulic alpha marker" },
    { page: 2, text: "" },
  ]);
  const hit = vault.db.searchBM25("hydraulic")[0];
  assert.equal(hit?.relativePath, "paper.pdf");
  assert.equal(hit?.pageStart, 1);
  assert.equal(hit?.pageEnd, 1);

  vault.close();
  const reopened = vault.reopen();
  assert.equal(reopened.getPdfState("paper.pdf")?.status, "ready");
  assert.equal(reopened.getPdfPages("paper.pdf")[0]?.text, "hydraulic alpha marker");
  assert.equal(await new VaultIndexer(vault.root, reopened, offlineProvider).indexSingleFile("paper.pdf"), "skipped");
});

test("scan exposes queued first-seen PDFs as pending before extraction completes", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  fs.writeFileSync(path.join(vault.root, "a.pdf"), await makePdf(["first queued document"]));
  fs.writeFileSync(path.join(vault.root, "b.pdf"), await makePdf(["second queued document"]));
  let announceFirstCall!: () => void;
  const firstCall = new Promise<void>((resolve) => { announceFirstCall = resolve; });
  let releaseFirstCall!: () => void;
  const gate = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
  let hasPaused = false;
  const slowProvider: EmbeddingProvider = {
    getStatus: () => ({ state: "ready" }),
    getEmbedding: async () => {
      if (!hasPaused) {
        hasPaused = true;
        announceFirstCall();
        await gate;
      }
      return new Float32Array([1, 0]);
    },
  };
  const indexing = new VaultIndexer(vault.root, vault.db, slowProvider).indexAll();
  await firstCall;

  const stats = vault.db.getStats();
  assert.equal(stats.pdfPending, 1);
  assert.equal(stats.pdfExtracting, 1);
  assert.deepEqual(new Set([vault.db.getPdfState("a.pdf")?.status, vault.db.getPdfState("b.pdf")?.status]), new Set(["pending", "extracting"]));

  releaseFirstCall();
  const result = await indexing;
  assert.equal(result.state, "ready");
  assert.equal(vault.db.getStats().pdfPending, 0);
  assert.equal(vault.db.getStats().pdfReady, 2);
});

test("reconciliation removes failed and empty PDF extraction records without documents rows", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  const failedPath = path.join(vault.root, "failed.pdf");
  fs.writeFileSync(failedPath, Buffer.from("not a PDF"));
  await assert.rejects(new VaultIndexer(vault.root, vault.db, offlineProvider).indexSingleFile("failed.pdf"), /PDF header/);
  assert.equal(vault.db.getDocumentState("failed.pdf"), null);
  assert.equal(vault.db.getPdfState("failed.pdf")?.status, "failed");

  vault.close();
  fs.rmSync(failedPath);
  let db = vault.reopen();
  let status = await new VaultIndexer(vault.root, db, offlineProvider).indexAll();
  assert.equal(status.state, "ready");
  assert.equal(db.getPdfState("failed.pdf"), null);
  assert.deepEqual(db.listSourcePaths(), []);
  assert.equal(db.getStats().pdfFailed, 0);

  const emptyPath = path.join(vault.root, "empty.pdf");
  fs.writeFileSync(emptyPath, await makePdf([null]));
  await new VaultIndexer(vault.root, db, offlineProvider).indexSingleFile("empty.pdf");
  assert.equal(db.getDocumentState("empty.pdf"), null);
  assert.equal(db.getPdfState("empty.pdf")?.status, "empty");
  vault.close();
  fs.rmSync(emptyPath);
  db = vault.reopen();
  status = await new VaultIndexer(vault.root, db, offlineProvider).indexAll();
  assert.equal(status.state, "ready");
  assert.equal(db.getPdfState("empty.pdf"), null);
  assert.equal(db.getStats().pdfEmpty, 0);
  assert.deepEqual(db.listDocumentPaths(), []);
});

test("blank updates keep the previous successful PDF body stale and versioned", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  const filename = path.join(vault.root, "changing.pdf");
  const oldPdf = await makePdf(["retained old hydraulic result"]);
  fs.writeFileSync(filename, oldPdf);
  const indexer = new VaultIndexer(vault.root, vault.db, offlineProvider);
  await indexer.indexSingleFile("changing.pdf");
  const originalVersion = vault.db.getDocumentSourceState("changing.pdf")?.sourceVersion;
  assert.ok(originalVersion);

  fs.writeFileSync(filename, await makePdf([null, null]));
  assert.equal(await indexer.indexSingleFile("changing.pdf"), "updated");

  assert.equal(vault.db.getPdfState("changing.pdf")?.status, "empty");
  assert.equal(vault.db.getDocumentSourceState("changing.pdf")?.sourceVersion, originalVersion);
  assert.equal(vault.db.getDocumentSourceState("changing.pdf")?.stale, true);
  const retained = vault.db.searchBM25("hydraulic")[0];
  assert.match(retained?.content ?? "", /retained old hydraulic result/);
  assert.equal(retained?.stale, true);
  assert.equal(vault.db.getPdfPages("changing.pdf")[0]?.text, "retained old hydraulic result");
});

test("corrupt and password-protected PDFs fail without replacing a prior index", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  const filename = path.join(vault.root, "protected.pdf");
  fs.writeFileSync(filename, await makePdf(["prior successful indexed content"]));
  const indexer = new VaultIndexer(vault.root, vault.db, offlineProvider);
  await indexer.indexSingleFile("protected.pdf");
  const originalVersion = vault.db.getDocumentSourceState("protected.pdf")?.sourceVersion;

  fs.writeFileSync(filename, Buffer.from("not a PDF"));
  await assert.rejects(indexer.indexSingleFile("protected.pdf"), /PDF header/);
  assert.equal(vault.db.getPdfState("protected.pdf")?.status, "failed");
  assert.equal(vault.db.getDocumentSourceState("protected.pdf")?.sourceVersion, originalVersion);
  assert.equal(vault.db.searchBM25("prior")[0]?.stale, true);

  await assert.rejects(extractPdfPages(await makeEncryptedPdf()), /password-protected/i);
  fs.writeFileSync(filename, await makeEncryptedPdf());
  await assert.rejects(indexer.indexSingleFile("protected.pdf"), /password-protected/i);
  assert.equal(vault.db.getDocumentSourceState("protected.pdf")?.sourceVersion, originalVersion);
  assert.match(vault.db.getPdfState("protected.pdf")?.error ?? "", /password-protected/i);
  assert.match(vault.db.searchBM25("prior")[0]?.content ?? "", /prior successful indexed content/);
});

test("PDF removal clears document, extraction state and page cache", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  fs.writeFileSync(path.join(vault.root, "removed.pdf"), await makePdf(["removal marker"]));
  const indexer = new VaultIndexer(vault.root, vault.db, offlineProvider);
  await indexer.indexSingleFile("removed.pdf");
  assert.ok(vault.db.getPdfState("removed.pdf"));
  fs.rmSync(path.join(vault.root, "removed.pdf"));

  assert.equal(await indexer.indexSingleFile("removed.pdf"), "deleted");
  assert.equal(vault.db.getDocumentState("removed.pdf"), null);
  assert.equal(vault.db.getPdfState("removed.pdf"), null);
  assert.deepEqual(vault.db.getPdfPages("removed.pdf"), []);
});

test("explicit Markdown import splits chunks at mapped pages, keeps sibling notes, and survives restart", { timeout: 15_000 }, async (t) => {
  const vault = createVault(t);
  fs.mkdirSync(path.join(vault.root, "converted"));
  fs.writeFileSync(path.join(vault.root, "paper.pdf"), await makePdf(["native extraction should be replaced", "second page"]));
  const indexer = new VaultIndexer(vault.root, vault.db, offlineProvider);
  assert.equal(await indexer.indexSingleFile("paper.pdf"), "updated");
  assert.equal(vault.db.getDocumentSourceState("paper.pdf")?.sourceType, "pdf");
  assert.match(vault.db.getPdfPages("paper.pdf")[0]?.text ?? "", /native extraction/);

  fs.writeFileSync(path.join(vault.root, "paper.md"), "ordinary sibling note searchable marker");
  fs.writeFileSync(path.join(vault.root, "converted", "paper.md"),
    "# Converted Page One\nalpha mapped evidence\n\n# Converted Page Two\nbeta mapped evidence\n");
  fs.writeFileSync(path.join(vault.root, "vault.imports.json"), JSON.stringify({
    version: 1,
    documents: [{
      pdf: "paper.pdf", markdown: "converted/paper.md",
      pages: [{ page: 1, startLine: 1, endLine: 2 }, { page: 2, startLine: 3, endLine: 6 }],
    }],
  }));

  const status = await indexer.indexAll();
  assert.equal(status.state, "ready");
  assert.equal(vault.db.getStats().totalDocuments, 2);
  assert.deepEqual(vault.db.listDocumentPaths(), ["paper.md", "paper.pdf"]);
  const first = vault.db.searchBM25("alpha mapped")[0];
  const second = vault.db.searchBM25("beta mapped")[0];
  assert.equal(first?.relativePath, "paper.pdf");
  assert.equal(first?.sourceType, "pdf-import");
  assert.equal(first?.originalPdf, "paper.pdf");
  assert.equal(first?.pageStart, 1);
  assert.equal(second?.pageStart, 2);
  assert.equal(second?.pageEnd, 2);
  assert.deepEqual(vault.db.getPdfPages("paper.pdf").map((page) => page.page), [1, 2]);
  assert.equal(vault.db.searchBM25("ordinary sibling")[0]?.relativePath, "paper.md");

  vault.close();
  const reopened = vault.reopen();
  assert.equal(reopened.getDocumentSourceState("paper.pdf")?.sourceType, "pdf-import");
  assert.equal(reopened.getPdfPages("paper.pdf")[1]?.page, 2);
  const secondScan = await new VaultIndexer(vault.root, reopened, offlineProvider).indexAll();
  assert.equal(secondScan.state, "ready");
  assert.equal(reopened.getStats().totalDocuments, 2);

  fs.rmSync(path.join(vault.root, "converted", "paper.md"));
  const failedRefresh = await new VaultIndexer(vault.root, reopened, offlineProvider).indexAll();
  assert.equal(failedRefresh.state, "degraded");
  assert.equal(reopened.getDocumentSourceState("paper.pdf")?.stale, true);
  assert.equal(reopened.getPdfState("paper.pdf")?.status, "failed");
  assert.match(reopened.getPdfPages("paper.pdf").map((page) => page.text).join(" "), /beta mapped evidence/);
});

test("manifest path validation accepts a canonicalized vault-root alias", (t) => {
  const vault = createVault(t);
  fs.writeFileSync(path.join(vault.root, "paper.pdf"), "pdf placeholder");
  fs.writeFileSync(path.join(vault.root, "paper.md"), "converted placeholder");
  const alias = `${vault.root}-alias`;
  try {
    fs.symlinkSync(vault.root, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`Directory symlink is unavailable in this environment: ${error instanceof Error ? error.message : error}`);
    return;
  }

  try {
    assert.deepEqual(validateImportManifest(alias, {
      version: 1,
      documents: [{ pdf: "paper.pdf", markdown: "paper.md" }],
    }), { version: 1, documents: [{ pdf: "paper.pdf", markdown: "paper.md" }] });
  } finally {
    if (process.platform === "win32") fs.rmdirSync(alias);
    else fs.unlinkSync(alias);
  }
});
