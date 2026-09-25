import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VaultDatabase } from "./storage/db.js";
import { parseAndChunkMarkdown } from "./parser/markdown.js";
import { chunkPdfPage, extractPdfPages, PDF_PARSE_VERSION, type PdfExtractionResult, type PdfPageText } from "./parser/pdf.js";
import { findTwinPdf } from "./parser/twinBinder.js";
import {
  findImportForMarkdown,
  findImportForPdf,
  loadImportManifest,
  type ImportManifest,
  type PdfMarkdownImport,
} from "./parser/imports.js";
import { EmbeddingService } from "./storage/embedding.js";
import { getEmbeddingProfile } from "./storage/profiles.js";
import { INDEX_VERSION } from "./config.js";
import { hasLinkedComponent, isIgnoredPath, isSupportedFile, resolveVaultPath } from "./vaultPaths.js";

export interface EmbeddingProvider {
  getEmbedding(text: string, kind?: "document" | "query"): Promise<Float32Array>;
  getStatus?(): { state: string; lastError?: string };
  getProfile?(): { fingerprint: string; dimensions: number };
}
export interface IndexStatus {
  state: "idle" | "indexing" | "ready" | "degraded" | "error";
  pendingFiles: number;
  scannedFiles: number;
  updatedFiles: number;
  skippedFiles: number;
  failedFiles: number;
  lastError?: string;
}
type FileResult = "updated" | "skipped" | "deleted" | "superseded";
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const hashBytes = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");
const IMPORT_PARSE_VERSION = "vault-import-markdown-v1";

function applyMappedPageRanges(
  chunks: ReturnType<typeof parseAndChunkMarkdown>,
  markdown: string,
  ranges: PdfMarkdownImport["pages"] = [],
) {
  if (!ranges?.length) return chunks.map((chunk) => ({ ...chunk, pageStart: undefined, pageEnd: undefined }));
  const lines = markdown.split(/\r?\n/);
  const mapped = [];
  for (const chunk of chunks) {
    const boundaries = new Set<number>([chunk.startLine, chunk.endLine + 1]);
    for (const range of ranges) {
      if (range.startLine > chunk.startLine && range.startLine <= chunk.endLine) boundaries.add(range.startLine);
      const afterRange = range.endLine + 1;
      if (afterRange > chunk.startLine && afterRange <= chunk.endLine) boundaries.add(afterRange);
    }
    const sorted = [...boundaries].sort((a, b) => a - b);
    for (let index = 0; index < sorted.length - 1; index++) {
      const startLine = sorted[index];
      const endLine = sorted[index + 1] - 1;
      const content = lines.slice(startLine - 1, endLine).join("\n").trim();
      if (!content) continue;
      const matches = ranges.filter((range) => range.startLine <= startLine && range.endLine >= endLine);
      const page = matches.length === 1 ? matches[0].page : undefined;
      mapped.push({
        headingPath: chunk.headingPath, startLine, endLine, content,
        pageStart: page, pageEnd: page,
      });
    }
  }
  return mapped;
}

export class VaultIndexer {
  private queues = new Map<string, Promise<FileResult>>();
  private revisions = new Map<string, number>();
  private scanPromise: Promise<IndexStatus> | null = null;
  private rescanRequested = false;
  private status: IndexStatus = { state: "idle", pendingFiles: 0, scannedFiles: 0, updatedFiles: 0, skippedFiles: 0, failedFiles: 0 };

  constructor(
    private vaultRoot: string,
    private db: VaultDatabase,
    private embeddingService: EmbeddingProvider = EmbeddingService.getInstance({ profile: db.getEmbeddingProfile() }),
  ) {}

  public getStatus(): IndexStatus {
    return { ...this.status, pendingFiles: this.queues.size };
  }

  /** Reconciliation hashes files, re-embedding only changed/incomplete documents. */
  public indexAll(): Promise<IndexStatus> {
    if (this.scanPromise) {
      this.rescanRequested = true;
      return this.scanPromise;
    }
    this.scanPromise = this.scanLoop().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  private async scanLoop(): Promise<IndexStatus> {
    do {
      this.rescanRequested = false;
      this.status = { state: "indexing", pendingFiles: 0, scannedFiles: 0, updatedFiles: 0, skippedFiles: 0, failedFiles: 0 };
      try {
        let manifest: ImportManifest;
        try {
          manifest = loadImportManifest(this.vaultRoot);
        } catch (error) {
          for (const relativePath of this.db.listImportedPdfPaths()) this.db.markDocumentStale(relativePath);
          throw error;
        }
        const importedMarkdown = new Set(manifest.documents.map((item) => item.markdown.toLocaleLowerCase("en-US")));
        const knownPaths = this.db.listSourcePaths();
        const files = new Set<string>();
        const walk = (directory: string) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            const relativePath = path.relative(this.vaultRoot, fullPath).replace(/\\/g, "/");
            if (entry.isSymbolicLink() || isIgnoredPath(relativePath)) continue;
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.isFile() && isSupportedFile(relativePath) &&
                !importedMarkdown.has(relativePath.toLocaleLowerCase("en-US"))) files.add(relativePath);
          }
        };
        // Never prune records after an incomplete/failed enumeration.
        walk(this.vaultRoot);
        // Make first-seen PDFs visible as pending only after enumeration has
        // completed successfully. Existing documents, failures and extraction
        // caches are left untouched here; their normal snapshot logic decides
        // whether to skip, retry or replace them.
        for (const relativePath of files) {
          if (path.extname(relativePath).toLowerCase() !== ".pdf") continue;
          try {
            if (hasLinkedComponent(this.vaultRoot, relativePath)) continue;
            const filename = resolveVaultPath(this.vaultRoot, relativePath);
            const bytes = fs.readFileSync(filename);
            const sourceHash = hashBytes(bytes);
            const importEntry = findImportForPdf(manifest, relativePath);
            const parseVersion = importEntry ? IMPORT_PARSE_VERSION : PDF_PARSE_VERSION;
            const inputHash = hash(JSON.stringify({ sourceHash, parseVersion, pending: true }));
            this.db.queuePdfExtraction(relativePath, {
              sourceHash, inputHash, parseVersion,
              coverageKind: importEntry ? "mapped" : "extracted",
            });
          } catch {
            // The following snapshot pass reports the actual read/permission
            // error and handles files removed after directory enumeration.
          }
        }
        for (const relativePath of knownPaths) {
          if (importedMarkdown.has(relativePath.toLocaleLowerCase("en-US"))) {
            // Older versions may have indexed a converted Markdown file as a
            // separate source. The explicit manifest makes the PDF its source.
            this.db.deleteDocument(relativePath);
            continue;
          }
          if (!files.has(relativePath)) {
            try { await this.indexSingleFile(relativePath); }
            catch (error) { this.recordError(error); }
          }
        }
        for (const relativePath of files) {
          this.status.scannedFiles++;
          try {
            const result = await this.indexSingleFile(relativePath);
            if (result === "updated") this.status.updatedFiles++;
            if (result === "skipped") this.status.skippedFiles++;
          } catch (error) { this.recordError(error); }
        }
        this.status.state = this.status.failedFiles ? "degraded" : "ready";
      } catch (error) {
        this.recordError(error);
        this.status.state = "error";
      }
    } while (this.rescanRequested);
    return this.getStatus();
  }

  public recordError(error: unknown): void {
    this.status.failedFiles++;
    this.status.lastError = error instanceof Error ? error.message : String(error);
    if (this.status.state !== "indexing") this.status.state = "degraded";
    console.error("[索引]", this.status.lastError);
  }

  /** Allocate revisions before awaiting so superseded work cannot commit. */
  public indexSingleFile(relativePath: string): Promise<FileResult> {
    let normalized = relativePath.replace(/\\/g, "/");
    if (/\.(?:md|markdown)$/i.test(normalized)) {
      const manifest = loadImportManifest(this.vaultRoot);
      const importEntry = findImportForMarkdown(manifest, normalized);
      if (importEntry) normalized = importEntry.pdf;
    }
    const revision = (this.revisions.get(normalized) ?? 0) + 1;
    this.revisions.set(normalized, revision);
    const previous = this.queues.get(normalized) ?? Promise.resolve("skipped" as const);
    const next = previous.catch(() => "skipped" as const).then(() => this.indexSnapshot(normalized, revision));
    this.queues.set(normalized, next);
    void next.finally(() => {
      if (this.queues.get(normalized) === next) {
        this.queues.delete(normalized);
        this.revisions.delete(normalized);
      }
    }).catch(() => {});
    return next;
  }

  private async indexSnapshot(relativePath: string, revision: number, attempt = 0): Promise<FileResult> {
    if (this.revisions.get(relativePath) !== revision) return "superseded";
    if (!isSupportedFile(relativePath)) {
      this.db.deleteDocument(relativePath);
      return "deleted";
    }
    if (path.extname(relativePath).toLowerCase() === ".pdf") {
      return this.indexPdfSnapshot(relativePath, revision, attempt);
    }
    let fullPath: string;
    let content: string;
    let mtime: number;
    try {
      if (hasLinkedComponent(this.vaultRoot, relativePath)) {
        this.db.deleteDocument(relativePath);
        return "deleted";
      }
      fullPath = resolveVaultPath(this.vaultRoot, relativePath);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || fs.lstatSync(path.join(this.vaultRoot, relativePath)).isSymbolicLink()) {
        this.db.deleteDocument(relativePath);
        return "deleted";
      }
      content = fs.readFileSync(fullPath, "utf8");
      mtime = stat.mtimeMs;
    } catch (error) {
      if (!missing(error)) throw error;
      this.db.deleteDocument(relativePath);
      return "deleted";
    }
    const contentHash = hash(content);
    const ext = path.extname(relativePath).toLowerCase();
    const twinPdf = ext === ".md" || ext === ".markdown" ? findTwinPdf(this.vaultRoot, relativePath) : null;
    const previous = this.db.getDocumentSourceState(relativePath);
    const disabled = this.embeddingService.getStatus?.().state === "disabled";
    if (previous?.contentHash === contentHash && previous.indexVersion === INDEX_VERSION &&
        previous.originalPdf === twinPdf && !previous.stale && (previous.vectorsComplete || disabled)) return "skipped";

    const chunks = parseAndChunkMarkdown(content);
    const embeddings: Array<Float32Array | null> = Array(chunks.length).fill(null);
    if (!disabled) {
      for (let i = 0; i < chunks.length; i++) {
        if (this.revisions.get(relativePath) !== revision) return "superseded";
        try {
          const chunk = chunks[i];
          // The chunk already contains its own heading. Repeating ancestor
          // headings diluted the known memory-release query in a real-model test.
          embeddings[i] = await this.embeddingService.getEmbedding(chunk.content, "document");
        } catch (error) {
          this.recordError(new Error(`${relativePath} L${chunks[i].startLine}: ${error instanceof Error ? error.message : error}`));
          if (this.embeddingService.getStatus?.().state === "unavailable") break;
        }
      }
    }
    if (this.revisions.get(relativePath) !== revision) return "superseded";
    // Events can be delayed: compare the actual source again before committing.
    try {
      if (hasLinkedComponent(this.vaultRoot, relativePath)) {
        this.db.deleteDocument(relativePath);
        return "deleted";
      }
      const currentPath = resolveVaultPath(this.vaultRoot, relativePath);
      const currentHash = hash(fs.readFileSync(currentPath, "utf8"));
      const currentTwin = ext === ".md" || ext === ".markdown" ? findTwinPdf(this.vaultRoot, relativePath) : null;
      if (currentHash !== contentHash || currentTwin !== twinPdf || currentPath !== fullPath) {
        if (attempt >= 3) throw new Error(`文件持续变化，暂未提交索引: ${relativePath}`);
        return this.indexSnapshot(relativePath, revision, attempt + 1);
      }
    } catch (error) {
      if (!missing(error)) throw error;
      this.db.deleteDocument(relativePath);
      return "deleted";
    }
    const profile = this.embeddingService.getProfile?.();
    this.db.saveDocument(relativePath, ext === ".md" || ext === ".markdown" ? "markdown" : "code",
      twinPdf, mtime, chunks, embeddings, {
        contentHash,
        indexVersion: INDEX_VERSION,
        sourceType: ext === ".md" || ext === ".markdown" ? "markdown" : "code",
        sourceVersion: contentHash,
        sourceId: relativePath,
        stale: false,
        ...(profile ? { embeddingFingerprint: profile.fingerprint } : {}),
      });
    return "updated";
  }

  private async indexPdfSnapshot(relativePath: string, revision: number, attempt = 0): Promise<FileResult> {
    if (this.revisions.get(relativePath) !== revision) return "superseded";

    let fullPath: string;
    let pdfBytes: Buffer;
    let mtime: number;
    try {
      if (hasLinkedComponent(this.vaultRoot, relativePath)) {
        this.db.deleteDocument(relativePath);
        return "deleted";
      }
      fullPath = resolveVaultPath(this.vaultRoot, relativePath);
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        this.db.deleteDocument(relativePath);
        return "deleted";
      }
      pdfBytes = fs.readFileSync(fullPath);
      mtime = stat.mtimeMs;
    } catch (error) {
      if (!missing(error)) throw error;
      this.db.deleteDocument(relativePath);
      return "deleted";
    }
    const sourceHash = hashBytes(pdfBytes);
    let manifest: ImportManifest;
    try {
      manifest = loadImportManifest(this.vaultRoot);
    } catch (error) {
      this.db.markDocumentStale(relativePath);
      throw error;
    }
    const importEntry = findImportForPdf(manifest, relativePath);
    const previous = this.db.getDocumentSourceState(relativePath);
    const disabled = this.embeddingService.getStatus?.().state === "disabled";
    const profile = this.embeddingService.getProfile?.();

    if (importEntry) {
      return this.indexImportedPdf({
        relativePath, revision, attempt, fullPath, pdfBytes, sourceHash, mtime,
        importEntry, manifest, previous, disabled,
        embeddingFingerprint: profile?.fingerprint,
      });
    }

    const inputHash = hash(JSON.stringify({ sourceHash, parseVersion: PDF_PARSE_VERSION }));
    const previousPdfState = this.db.getPdfState(relativePath);
    if (previous?.contentHash === inputHash && previous.indexVersion === INDEX_VERSION &&
        previous.parseVersion === PDF_PARSE_VERSION && previous.sourceType === "pdf" &&
        previous.sourceVersion === sourceHash && !previous.stale &&
        previousPdfState?.inputHash === inputHash && previousPdfState.status === "ready" &&
        !previousPdfState.stale && (previous.vectorsComplete || disabled)) return "skipped";
    let extraction: PdfExtractionResult;
    if (previousPdfState?.inputHash === inputHash && previousPdfState.parseVersion === PDF_PARSE_VERSION &&
        !previousPdfState.stale && (previousPdfState.status === "ready" || previousPdfState.status === "empty")) {
      if (previousPdfState.status === "empty") return "skipped";
      const cachedPages = this.db.getPdfPages(relativePath, inputHash);
      extraction = {
        status: "ready",
        pageCount: previousPdfState.pageCount,
        extractedPageCount: previousPdfState.extractedPageCount,
        coverage: previousPdfState.coverage,
        pages: cachedPages.filter((page): page is { page: number; text: string } => page.page !== null),
      };
      if (extraction.pages.length !== extraction.pageCount) {
        // A partial cache is not trusted: regenerate it from the verified bytes.
        extraction = await this.extractAndRecordPdf(relativePath, sourceHash, inputHash, pdfBytes);
      }
    } else {
      extraction = await this.extractAndRecordPdf(relativePath, sourceHash, inputHash, pdfBytes);
    }

    if (extraction.status === "empty") {
      this.db.failPdfExtraction(relativePath, {
        sourceHash, inputHash, parseVersion: PDF_PARSE_VERSION, status: "empty",
        error: "PDF contains no extractable text.", pageCount: extraction.pageCount,
        extractedPageCount: 0, coverageKind: "extracted",
        pages: extraction.pages.map((page) => ({ page: page.page, text: page.text })),
      });
      return "updated";
    }

    const chunks = extraction.pages.flatMap((page) => chunkPdfPage(page));
    const embeddings = await this.embedChunks(relativePath, chunks, revision);
    if (embeddings === null) return "superseded";
    const latest = this.verifyPdfSnapshot(relativePath, fullPath, sourceHash, importEntry, manifest);
    if (!latest) {
      if (attempt >= 3) {
        const message = `PDF持续变化，暂未提交索引: ${relativePath}`;
        this.db.failPdfExtraction(relativePath, { sourceHash, inputHash, parseVersion: PDF_PARSE_VERSION, error: message });
        throw new Error(message);
      }
      return this.indexPdfSnapshot(relativePath, revision, attempt + 1);
    }

    const pdfExtraction = {
      status: "ready" as const, sourceHash, inputHash, parseVersion: PDF_PARSE_VERSION,
      pageCount: extraction.pageCount, extractedPageCount: extraction.extractedPageCount,
      coverage: extraction.coverage, coverageKind: "extracted" as const, error: null,
      stale: false, pages: extraction.pages.map((page) => ({ page: page.page, text: page.text })),
    };
    this.db.saveDocument(relativePath, "pdf", relativePath, mtime, chunks, embeddings, {
      contentHash: inputHash, indexVersion: INDEX_VERSION, sourceType: "pdf",
      sourceVersion: sourceHash, sourceId: relativePath, stale: false,
      parseVersion: PDF_PARSE_VERSION, ...(profile ? { embeddingFingerprint: profile.fingerprint } : {}),
      pdfExtraction,
    });
    return "updated";
  }

  private async extractAndRecordPdf(
    relativePath: string,
    sourceHash: string,
    inputHash: string,
    bytes: Uint8Array,
  ): Promise<PdfExtractionResult> {
    this.db.beginPdfExtraction(relativePath, { sourceHash, inputHash, parseVersion: PDF_PARSE_VERSION });
    try {
      return await extractPdfPages(bytes);
    } catch (error) {
      this.db.failPdfExtraction(relativePath, {
        sourceHash, inputHash, parseVersion: PDF_PARSE_VERSION,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async indexImportedPdf(args: {
    relativePath: string;
    revision: number;
    attempt: number;
    fullPath: string;
    pdfBytes: Uint8Array;
    sourceHash: string;
    mtime: number;
    importEntry: PdfMarkdownImport;
    manifest: ImportManifest;
    previous: ReturnType<VaultDatabase["getDocumentSourceState"]>;
    disabled: boolean;
    embeddingFingerprint?: string;
  }): Promise<FileResult> {
    const { relativePath, revision, attempt, fullPath, sourceHash, mtime, importEntry, manifest, previous, disabled } = args;
    let markdownPath: string;
    let markdown: string;
    let markdownHash: string;
    try {
      if (hasLinkedComponent(this.vaultRoot, importEntry.markdown)) throw new Error("Import Markdown path traverses a symbolic link.");
      markdownPath = resolveVaultPath(this.vaultRoot, importEntry.markdown);
      if (!fs.statSync(markdownPath).isFile()) throw new Error("Import Markdown path is not a regular file.");
      markdown = fs.readFileSync(markdownPath, "utf8");
      markdownHash = hash(markdown);
    } catch (error) {
      const inputHash = hash(JSON.stringify({ sourceHash, mapping: importEntry, parseVersion: IMPORT_PARSE_VERSION, unavailable: true }));
      const message = `显式转换文本不可用: ${error instanceof Error ? error.message : String(error)}`;
      this.db.beginPdfExtraction(relativePath, { sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION, coverageKind: "mapped" });
      this.db.failPdfExtraction(relativePath, {
        sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION,
        error: message,
        coverageKind: "mapped",
      });
      throw new Error(message, { cause: error });
    }

    const inputHash = hash(JSON.stringify({
      sourceHash, markdownHash, mapping: importEntry, parseVersion: IMPORT_PARSE_VERSION,
    }));
    if (importEntry.sourceHash && importEntry.sourceHash !== sourceHash) {
      this.db.beginPdfExtraction(relativePath, { sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION, coverageKind: "mapped" });
      this.db.failPdfExtraction(relativePath, {
        sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION, coverageKind: "mapped",
        error: `Import sourceHash does not match the current PDF: ${relativePath}`,
      });
      throw new Error(`Import sourceHash does not match the current PDF: ${relativePath}`);
    }

    const disabledOrDone = disabled && previous?.contentHash === inputHash && previous.indexVersion === INDEX_VERSION &&
      previous.sourceType === "pdf-import" && previous.sourceVersion === sourceHash && !previous.stale;
    if (previous?.contentHash === inputHash && previous.indexVersion === INDEX_VERSION &&
        previous.parseVersion === IMPORT_PARSE_VERSION && previous.sourceType === "pdf-import" &&
        previous.sourceVersion === sourceHash && !previous.stale && (previous.vectorsComplete || disabledOrDone)) return "skipped";

    if (this.revisions.get(relativePath) !== revision) return "superseded";
    this.db.beginPdfExtraction(relativePath, { sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION, coverageKind: "mapped" });
    const pageRanges = importEntry.pages ?? [];
    const chunks = applyMappedPageRanges(parseAndChunkMarkdown(markdown), markdown, pageRanges);
    if (chunks.length === 0) {
      const pageCount = pageRanges.reduce((max, range) => Math.max(max, range.page), 0);
      this.db.failPdfExtraction(relativePath, {
        sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION, status: "empty",
        error: "Converted Markdown contains no indexable text.", pageCount, extractedPageCount: 0,
        coverageKind: "mapped", pages: [],
      });
      return "updated";
    }

    const embeddings = await this.embedChunks(relativePath, chunks, revision);
    if (embeddings === null) return "superseded";
    let currentMarkdownHash = "";
    try {
      if (hasLinkedComponent(this.vaultRoot, importEntry.markdown)) throw new Error("Import Markdown path traverses a symbolic link.");
      currentMarkdownHash = hash(fs.readFileSync(resolveVaultPath(this.vaultRoot, importEntry.markdown), "utf8"));
    } catch (error) {
      const message = `显式转换文本在提交前不可用: ${error instanceof Error ? error.message : String(error)}`;
      this.db.failPdfExtraction(relativePath, {
        sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION,
        error: message, coverageKind: "mapped",
      });
      throw new Error(message, { cause: error });
    }
    if (currentMarkdownHash !== markdownHash || !this.verifyPdfSnapshot(relativePath, fullPath, sourceHash, importEntry, manifest)) {
      if (attempt >= 3) {
        const message = `PDF或转换文本持续变化，暂未提交索引: ${relativePath}`;
        this.db.failPdfExtraction(relativePath, {
          sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION,
          error: message, coverageKind: "mapped",
        });
        throw new Error(message);
      }
      return this.indexPdfSnapshot(relativePath, revision, attempt + 1);
    }

    const pageCount = pageRanges.reduce((max, range) => Math.max(max, range.page), 0);
    const mappedPages = new Set(chunks.flatMap((chunk) => chunk.pageStart === undefined ? [] : [chunk.pageStart]));
    const pages = chunks.map((chunk) => ({ page: chunk.pageStart ?? null, text: chunk.content }));
    this.db.saveDocument(relativePath, "pdf-import", relativePath, mtime, chunks, embeddings, {
      contentHash: inputHash, indexVersion: INDEX_VERSION, sourceType: "pdf-import",
      sourceVersion: sourceHash, sourceId: relativePath, stale: false,
      parseVersion: IMPORT_PARSE_VERSION,
      ...(args.embeddingFingerprint ? { embeddingFingerprint: args.embeddingFingerprint } : {}),
      pdfExtraction: {
        status: "ready", sourceHash, inputHash, parseVersion: IMPORT_PARSE_VERSION,
        pageCount, extractedPageCount: mappedPages.size,
        coverage: pageCount > 0 ? mappedPages.size / pageCount : 0,
        coverageKind: "mapped", error: null, stale: false, pages,
      },
    });
    return "updated";
  }

  private async embedChunks(relativePath: string, chunks: ReturnType<typeof parseAndChunkMarkdown>, revision: number): Promise<Array<Float32Array | null> | null> {
    const embeddings: Array<Float32Array | null> = Array(chunks.length).fill(null);
    if (this.embeddingService.getStatus?.().state === "disabled") return embeddings;
    for (let index = 0; index < chunks.length; index++) {
      if (this.revisions.get(relativePath) !== revision) return null;
      try {
        embeddings[index] = await this.embeddingService.getEmbedding(chunks[index].content, "document");
      } catch (error) {
        this.recordError(new Error(`${relativePath} L${chunks[index].startLine}: ${error instanceof Error ? error.message : error}`));
        if (this.embeddingService.getStatus?.().state === "unavailable") break;
      }
    }
    return embeddings;
  }

  private verifyPdfSnapshot(
    relativePath: string,
    fullPath: string,
    sourceHash: string,
    importEntry: PdfMarkdownImport | null,
    originalManifest: ImportManifest,
  ): boolean {
    try {
      if (hasLinkedComponent(this.vaultRoot, relativePath)) {
        this.db.deleteDocument(relativePath);
        return false;
      }
      const currentPath = resolveVaultPath(this.vaultRoot, relativePath);
      if (currentPath !== fullPath || hashBytes(fs.readFileSync(currentPath)) !== sourceHash) return false;
      const latestManifest = loadImportManifest(this.vaultRoot);
      const latestEntry = findImportForPdf(latestManifest, relativePath);
      if (JSON.stringify(latestEntry) !== JSON.stringify(importEntry) ||
          JSON.stringify(latestManifest) !== JSON.stringify(originalManifest)) return false;
      return true;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  }

  public async drain(): Promise<void> {
    if (this.scanPromise) await this.scanPromise;
    while (this.queues.size) await Promise.allSettled([...this.queues.values()]);
  }
}
