import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { MarkdownChunk } from "../parser/markdown.js";

export interface SearchResult {
  relativePath: string;
  originalPdf: string | null;
  headingPath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number; // 综合匹配得分
  matchType?: "bm25" | "vector" | "hybrid"; // 命中来源
}

export interface VaultStats {
  vaultPath: string;
  dbPath: string;
  totalDocuments: number;
  totalChunks: number;
  totalTwinPdfs: number;
  totalVectors: number;
  dbSizeKb: number;
}

export class VaultDatabase {
  private db: Database.Database;
  private dbPath: string;
  private vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.dbPath = path.join(vaultRoot, ".vault_index.db");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");

    this.initTables();
  }

  private initTables() {
    // 1. 文档元数据表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relative_path TEXT UNIQUE NOT NULL,
        file_type TEXT NOT NULL,
        original_pdf TEXT,
        mtime INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    // 2. FTS5 全文搜索虚拟表（BM25 算法）
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        relative_path,
        original_pdf UNINDEXED,
        heading_path,
        start_line UNINDEXED,
        end_line UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);

    // 3. 向量存储表（将 512 维 float 数组以原始二进制 BLOB 形式持久化，类似 C 的 memcpy）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunk_vectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        relative_path TEXT NOT NULL,
        original_pdf TEXT,
        heading_path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vec_relpath ON chunk_vectors(relative_path);
    `);
  }

  /**
   * 保存文档、全文索引与对应的向量切片
   */
  public saveDocument(
    relativePath: string,
    fileType: string,
    originalPdf: string | null,
    mtime: number,
    chunks: MarkdownChunk[],
    embeddings?: Float32Array[]
  ) {
    const normalizedRelPath = relativePath.replace(/\\/g, "/");
    const normalizedPdf = originalPdf ? originalPdf.replace(/\\/g, "/") : null;

    const transaction = this.db.transaction(() => {
      // 1. 清理该文件的旧数据
      this.db.prepare("DELETE FROM documents WHERE relative_path = ?").run(normalizedRelPath);
      this.db.prepare("DELETE FROM chunks_fts WHERE relative_path = ?").run(normalizedRelPath);
      this.db.prepare("DELETE FROM chunk_vectors WHERE relative_path = ?").run(normalizedRelPath);

      // 2. 插入新文档元数据
      this.db.prepare(`
        INSERT INTO documents (relative_path, file_type, original_pdf, mtime, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(normalizedRelPath, fileType, normalizedPdf, mtime, Date.now());

      // 3. 插入 FTS5 倒排索引
      const insertFts = this.db.prepare(`
        INSERT INTO chunks_fts (relative_path, original_pdf, heading_path, start_line, end_line, content)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      // 4. 插入向量数据表 (BLOB 二进制)
      const insertVector = this.db.prepare(`
        INSERT INTO chunk_vectors (relative_path, original_pdf, heading_path, start_line, end_line, content, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        insertFts.run(
          normalizedRelPath,
          normalizedPdf,
          chunk.headingPath,
          chunk.startLine,
          chunk.endLine,
          chunk.content
        );

        if (embeddings && embeddings[i]) {
          // 将 Float32Array 直接转换为 Buffer 写入 SQLite BLOB
          const floatArr = embeddings[i];
          const buffer = Buffer.from(floatArr.buffer, floatArr.byteOffset, floatArr.byteLength);
          insertVector.run(
            normalizedRelPath,
            normalizedPdf,
            chunk.headingPath,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            buffer
          );
        }
      }
    });

    transaction();
  }

  public deleteDocument(relativePath: string) {
    const normalized = relativePath.replace(/\\/g, "/");
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE relative_path = ?").run(normalized);
      this.db.prepare("DELETE FROM chunks_fts WHERE relative_path = ?").run(normalized);
      this.db.prepare("DELETE FROM chunk_vectors WHERE relative_path = ?").run(normalized);
    });
    transaction();
  }

  /**
   * BM25 关键词检索
   */
  public searchBM25(query: string, limit = 10): SearchResult[] {
    const cleanTokens = query
      .replace(/['"“”‘’]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (cleanTokens.length === 0) return [];
    const ftsQuery = cleanTokens.map((t) => `"${t}"`).join(" OR ");

    try {
      const stmt = this.db.prepare(`
        SELECT 
          relative_path,
          original_pdf,
          heading_path,
          start_line,
          end_line,
          content,
          bm25(chunks_fts) AS rank
        FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `);

      const rows = stmt.all(ftsQuery, limit) as any[];
      return rows.map((r) => ({
        relativePath: r.relative_path,
        originalPdf: r.original_pdf,
        headingPath: r.heading_path,
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        content: r.content,
        score: Math.round((1 / (1 + Math.abs(r.rank))) * 100) / 100,
        matchType: "bm25"
      }));
    } catch {
      return [];
    }
  }

  /**
   * 纯本地向量余弦相似度检索 (Cosine Similarity)
   * 知识点：归一化向量的余弦相似度 = 向量的点积（Dot Product）
   */
  public searchVector(queryEmbedding: Float32Array, limit = 10): SearchResult[] {
    const rows = this.db.prepare(`
      SELECT 
        relative_path,
        original_pdf,
        heading_path,
        start_line,
        end_line,
        content,
        embedding
      FROM chunk_vectors
    `).all() as any[];

    if (rows.length === 0) return [];

    const scored: SearchResult[] = [];

    for (const r of rows) {
      const buf: Buffer = r.embedding;
      // 快速还原为 Float32Array (等同于 C 语言的指针强转 (float*)buf)
      const docEmbedding = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);

      // 计算点积
      let dotProduct = 0;
      const len = Math.min(queryEmbedding.length, docEmbedding.length);
      for (let i = 0; i < len; i++) {
        dotProduct += queryEmbedding[i] * docEmbedding[i];
      }

      scored.push({
        relativePath: r.relative_path,
        originalPdf: r.original_pdf,
        headingPath: r.heading_path,
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        content: r.content,
        score: Math.round(dotProduct * 100) / 100,
        matchType: "vector"
      });
    }

    // 按得分从高到低排序并取 Top K
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * 工业级混合检索：RRF (Reciprocal Rank Fusion, 倒数排名融合算法)
   * 将 BM25 关键词排名与 Vector 语义排名综合加权融合
   */
  public searchHybrid(query: string, queryEmbedding: Float32Array | null, limit = 5): SearchResult[] {
    const bm25Results = this.searchBM25(query, limit * 2);

    if (!queryEmbedding) {
      return bm25Results.slice(0, limit);
    }

    const vectorResults = this.searchVector(queryEmbedding, limit * 2);

    // RRF 算法核心：Score = 1 / (60 + rank)
    const k = 60;
    const scoreMap = new Map<string, { rrfScore: number; item: SearchResult; matchType: "bm25" | "vector" | "hybrid" }>();

    // 1. 累加 BM25 排名得分
    bm25Results.forEach((item, index) => {
      const key = `${item.relativePath}#${item.startLine}`;
      const rrf = 1 / (k + (index + 1));
      scoreMap.set(key, { rrfScore: rrf, item, matchType: "bm25" });
    });

    // 2. 累加 向量 排名得分
    vectorResults.forEach((item, index) => {
      const key = `${item.relativePath}#${item.startLine}`;
      const rrf = 1 / (k + (index + 1));
      const existing = scoreMap.get(key);
      if (existing) {
        existing.rrfScore += rrf;
        existing.matchType = "hybrid"; // 关键词和向量都命中！
      } else {
        scoreMap.set(key, { rrfScore: rrf, item, matchType: "vector" });
      }
    });

    // 3. 排序得出最终混合结果
    const combined = Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, limit)
      .map(({ item, matchType, rrfScore }) => ({
        ...item,
        score: Math.round(rrfScore * 1000) / 1000,
        matchType
      }));

    return combined;
  }

  public getStats(): VaultStats {
    const totalDocs = (this.db.prepare("SELECT count(*) as cnt FROM documents").get() as any).cnt;
    const totalChunks = (this.db.prepare("SELECT count(*) as cnt FROM chunks_fts").get() as any).cnt;
    const totalVectors = (this.db.prepare("SELECT count(*) as cnt FROM chunk_vectors").get() as any).cnt;
    const totalTwinPdfs = (
      this.db.prepare("SELECT count(DISTINCT original_pdf) as cnt FROM documents WHERE original_pdf IS NOT NULL").get() as any
    ).cnt;

    let dbSizeKb = 0;
    if (fs.existsSync(this.dbPath)) {
      dbSizeKb = Math.round(fs.statSync(this.dbPath).size / 1024);
    }

    return {
      vaultPath: this.vaultRoot,
      dbPath: this.dbPath,
      totalDocuments: totalDocs,
      totalChunks: totalChunks,
      totalTwinPdfs: totalTwinPdfs,
      totalVectors: totalVectors,
      dbSizeKb: dbSizeKb
    };
  }

  public close() {
    this.db.close();
  }
}
