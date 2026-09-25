import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VaultDatabase } from "./storage/db.js";
import { parseAndChunkMarkdown } from "./parser/markdown.js";
import { findTwinPdf } from "./parser/twinBinder.js";
import { EmbeddingService } from "./storage/embedding.js";
import { INDEX_VERSION } from "./config.js";
import { hasLinkedComponent, isIgnoredPath, isSupportedFile, resolveVaultPath } from "./vaultPaths.js";

export interface EmbeddingProvider {
  getEmbedding(text: string): Promise<Float32Array>;
  getStatus?(): { state: string; lastError?: string };
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
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

export class VaultIndexer {
  private queues = new Map<string, Promise<FileResult>>();
  private revisions = new Map<string, number>();
  private scanPromise: Promise<IndexStatus> | null = null;
  private rescanRequested = false;
  private status: IndexStatus = { state: "idle", pendingFiles: 0, scannedFiles: 0, updatedFiles: 0, skippedFiles: 0, failedFiles: 0 };

  constructor(
    private vaultRoot: string,
    private db: VaultDatabase,
    private embeddingService: EmbeddingProvider = EmbeddingService.getInstance(),
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
        const knownPaths = this.db.listDocumentPaths();
        const files = new Set<string>();
        const walk = (directory: string) => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            const relativePath = path.relative(this.vaultRoot, fullPath).replace(/\\/g, "/");
            if (entry.isSymbolicLink() || isIgnoredPath(relativePath)) continue;
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.isFile() && isSupportedFile(relativePath)) files.add(relativePath);
          }
        };
        // Never prune records after an incomplete/failed enumeration.
        walk(this.vaultRoot);
        for (const relativePath of knownPaths) {
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
    const normalized = relativePath.replace(/\\/g, "/");
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
    const previous = this.db.getDocumentState(relativePath);
    const disabled = this.embeddingService.getStatus?.().state === "disabled";
    if (previous?.contentHash === contentHash && previous.indexVersion === INDEX_VERSION &&
        previous.originalPdf === twinPdf && (previous.vectorsComplete || disabled)) return "skipped";

    const chunks = parseAndChunkMarkdown(content);
    const embeddings: Array<Float32Array | null> = Array(chunks.length).fill(null);
    if (!disabled) {
      for (let i = 0; i < chunks.length; i++) {
        if (this.revisions.get(relativePath) !== revision) return "superseded";
        try {
          const chunk = chunks[i];
          // The chunk already contains its own heading. Repeating ancestor
          // headings diluted the known memory-release query in a real-model test.
          embeddings[i] = await this.embeddingService.getEmbedding(chunk.content);
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
    this.db.saveDocument(relativePath, ext === ".md" || ext === ".markdown" ? "markdown" : "code",
      twinPdf, mtime, chunks, embeddings, { contentHash, indexVersion: INDEX_VERSION });
    return "updated";
  }

  public async drain(): Promise<void> {
    if (this.scanPromise) await this.scanPromise;
    while (this.queues.size) await Promise.allSettled([...this.queues.values()]);
  }
}
