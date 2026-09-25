import fs from "fs";
import path from "path";
import { VaultDatabase } from "./storage/db.js";
import { parseAndChunkMarkdown } from "./parser/markdown.js";
import { findTwinPdf } from "./parser/twinBinder.js";
import { EmbeddingService } from "./storage/embedding.js";

const IGNORED_DIRS = new Set([
  ".git",
  ".obsidian",
  ".trash",
  "node_modules",
  "images",
  "assets",
  "_assets",
  "dist",
  "build"
]);

const SUPPORTED_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".c",
  ".h",
  ".cpp",
  ".py",
  ".js",
  ".ts"
]);

export class VaultIndexer {
  private vaultRoot: string;
  private db: VaultDatabase;
  private embeddingService: EmbeddingService;

  constructor(vaultRoot: string, db: VaultDatabase) {
    this.vaultRoot = vaultRoot;
    this.db = db;
    this.embeddingService = EmbeddingService.getInstance();
  }

  /**
   * 递归扫描并全量索引知识库（同时计算 BM25 与向量 Embedding）
   */
  public async indexAll(): Promise<{ indexedFiles: number; totalChunks: number; totalVectors: number }> {
    let indexedFiles = 0;
    const filesToIndex: string[] = [];

    const walk = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(this.vaultRoot, fullPath);

        if (entry.name.startsWith(".") && entry.name !== ".vault_index.db") continue;
        if (entry.isDirectory()) {
          if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
          walk(fullPath);
          continue;
        }

        const ext = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_EXTS.has(ext)) continue;

        filesToIndex.push(relPath);
      }
    };

    if (fs.existsSync(this.vaultRoot)) {
      walk(this.vaultRoot);
    }

    for (const relPath of filesToIndex) {
      await this.indexSingleFile(relPath);
      indexedFiles++;
    }

    const stats = this.db.getStats();
    return {
      indexedFiles,
      totalChunks: stats.totalChunks,
      totalVectors: stats.totalVectors
    };
  }

  /**
   * 索引单个文件（支持分块与异步向量计算）
   */
  public async indexSingleFile(relativePath: string): Promise<void> {
    const fullPath = path.join(this.vaultRoot, relativePath);
    if (!fs.existsSync(fullPath)) {
      this.db.deleteDocument(relativePath);
      return;
    }

    const stat = fs.statSync(fullPath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const ext = path.extname(relativePath).toLowerCase();

    // 探测双生同名 PDF
    const twinPdf = (ext === ".md" || ext === ".markdown")
      ? findTwinPdf(this.vaultRoot, relativePath)
      : null;

    // 大纲智能切块
    const chunks = parseAndChunkMarkdown(content);

    // 为每个切片计算本地向量 Embedding (纯 CPU，Float32Array)
    const embeddings: Float32Array[] = [];
    for (const chunk of chunks) {
      try {
        const emb = await this.embeddingService.getEmbedding(chunk.content);
        embeddings.push(emb);
      } catch (err) {
        console.error(`计算切片向量失败: ${relativePath} L${chunk.startLine}`, err);
      }
    }

    // 保存到 SQLite (FTS5 + 二进制向量)
    this.db.saveDocument(
      relativePath,
      ext === ".md" || ext === ".markdown" ? "markdown" : "code",
      twinPdf,
      stat.mtimeMs,
      chunks,
      embeddings
    );
  }
}
