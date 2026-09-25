import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { INDEX_VERSION } from "../config.js";
import { MarkdownChunk } from "../parser/markdown.js";
import { makeFtsQuery, makeSearchText } from "./searchText.js";

export interface SearchResult {
  relativePath: string;
  originalPdf: string | null;
  headingPath: string;
  startLine: number;
  endLine: number;
  content: string;
  /** Ranking value for this search mode; an RRF value is not a confidence. */
  score: number;
  matchType?: "bm25" | "vector" | "hybrid";
  /** Raw SQLite BM25 value. Lower values rank first. */
  bm25Rank?: number;
  /** Raw dot product between stored and query embeddings. */
  vectorScore?: number;
}

export interface VaultStats {
  vaultPath: string;
  dbPath: string;
  totalDocuments: number;
  totalChunks: number;
  totalTwinPdfs: number;
  totalVectors: number;
  incompleteDocuments: number;
  dbSizeKb: number;
}

export interface DocumentMetadata {
  contentHash: string;
  indexVersion: string;
}

export interface DocumentState extends DocumentMetadata {
  originalPdf: string | null;
  vectorsComplete: boolean;
}

interface FtsRow {
  relative_path: string;
  original_pdf: string | null;
  heading_path: string;
  start_line: number;
  end_line: number;
  content: string;
  rank: number;
}

interface VectorRow extends Omit<FtsRow, "rank"> {
  embedding: Buffer;
}

function normalizeLimit(limit: number, fallback: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}

function encodeEmbedding(embedding: Float32Array): Buffer {
  if (embedding.length === 0) throw new RangeError("Embedding must contain at least one value");
  const bytes = Buffer.allocUnsafe(embedding.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i];
    if (!Number.isFinite(value)) throw new TypeError(`Embedding contains a non-finite value at index ${i}`);
    view.setFloat32(i * Float32Array.BYTES_PER_ELEMENT, value, true);
  }
  return bytes;
}

function decodeEmbedding(buffer: Buffer): Float32Array {
  if (buffer.byteLength === 0 || buffer.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new RangeError("Stored embedding has an invalid byte length");
  }
  const values = new Float32Array(buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let i = 0; i < values.length; i++) {
    values[i] = view.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
    if (!Number.isFinite(values[i])) throw new TypeError(`Stored embedding contains a non-finite value at index ${i}`);
  }
  return values;
}

function toSearchResult(row: FtsRow): SearchResult {
  const rank = Number(row.rank);
  return {
    relativePath: row.relative_path,
    originalPdf: row.original_pdf,
    headingPath: row.heading_path,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    content: row.content,
    // Preserve precision for downstream ordering and inspection.
    score: -rank,
    bm25Rank: rank,
    matchType: "bm25"
  };
}

export class VaultDatabase {
  private db: Database.Database;
  private dbPath: string;
  private vaultRoot: string;

  constructor(vaultRoot: string) {
    this.vaultRoot = vaultRoot;
    this.dbPath = path.join(vaultRoot, ".vault_index.db");
    fs.mkdirSync(vaultRoot, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");

    this.initTables();
  }

  private createFtsTable() {
    this.db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        relative_path UNINDEXED,
        original_pdf UNINDEXED,
        heading_path UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED,
        content UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );
    `);
  }

  private initTables() {
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          relative_path TEXT UNIQUE NOT NULL,
          file_type TEXT NOT NULL,
          original_pdf TEXT,
          mtime INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          content_hash TEXT NOT NULL DEFAULT '',
          index_version TEXT NOT NULL DEFAULT '',
          vectors_complete INTEGER NOT NULL DEFAULT 0
        );

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

      // Add metadata fields to databases created by older versions.
      const documentColumns = new Set(
        (this.db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map((column) => column.name)
      );
      if (!documentColumns.has("content_hash")) {
        this.db.exec("ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''");
      }
      if (!documentColumns.has("index_version")) {
        this.db.exec("ALTER TABLE documents ADD COLUMN index_version TEXT NOT NULL DEFAULT ''");
      }
      if (!documentColumns.has("vectors_complete")) {
        this.db.exec("ALTER TABLE documents ADD COLUMN vectors_complete INTEGER NOT NULL DEFAULT 0");
      }

      const ftsExists = Boolean(
        this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'").get()
      );
      const ftsColumns = ftsExists
        ? new Set((this.db.prepare("PRAGMA table_info(chunks_fts)").all() as Array<{ name: string }>).map((column) => column.name))
        : new Set<string>();

      if (!ftsExists) {
        this.createFtsTable();
      } else if (!ftsColumns.has("search_text")) {
        // Rebuild only the derived FTS table; the original body and source rows
        // remain untouched, and the legacy FTS content is copied verbatim.
        const oldRows = this.db.prepare(`
          SELECT relative_path, original_pdf, heading_path, start_line, end_line, content
          FROM chunks_fts
        `).all() as Array<Omit<FtsRow, "rank">>;
        this.db.exec("DROP TABLE chunks_fts");
        this.createFtsTable();
        const insert = this.db.prepare(`
          INSERT INTO chunks_fts (relative_path, original_pdf, heading_path, start_line, end_line, content, search_text)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of oldRows) {
          insert.run(
            row.relative_path,
            row.original_pdf,
            row.heading_path,
            row.start_line,
            row.end_line,
            row.content,
            makeSearchText(row.content, row.heading_path, row.relative_path)
          );
        }
      }

      // Vector blobs have no per-row version. Remove all blobs owned by an old
      // document version before they can be compared with current CLS queries.
      this.db.prepare(`
        DELETE FROM chunk_vectors
        WHERE relative_path NOT IN (
          SELECT relative_path FROM documents WHERE index_version = ?
        )
      `).run(INDEX_VERSION);

      // Repair stale completion flags, including records interrupted midway
      // through embedding generation or persistence.
      this.db.prepare(`
        UPDATE documents
        SET vectors_complete = CASE
          WHEN index_version = ?
            AND (SELECT count(*) FROM chunks_fts f WHERE f.relative_path = documents.relative_path)
              = (SELECT count(*) FROM chunk_vectors v WHERE v.relative_path = documents.relative_path)
          THEN 1 ELSE 0 END
      `).run(INDEX_VERSION);
    });

    migrate();
  }

  /** Save document metadata, full-text rows, and available vectors atomically. */
  public saveDocument(
    relativePath: string,
    fileType: string,
    originalPdf: string | null,
    mtime: number,
    chunks: MarkdownChunk[],
    embeddings?: Array<Float32Array | null>,
    metadata?: DocumentMetadata
  ) {
    const normalizedRelPath = relativePath.replace(/\\/g, "/");
    const normalizedPdf = originalPdf ? originalPdf.replace(/\\/g, "/") : null;
    if (embeddings && embeddings.length > chunks.length) {
      throw new RangeError("Embedding list cannot contain more entries than chunks");
    }

    // Validate and copy every supplied vector before starting the transaction.
    const encodedEmbeddings = chunks.map((_, index) => {
      const embedding = embeddings?.[index] ?? null;
      return embedding ? encodeEmbedding(embedding) : null;
    });
    const vectorsComplete = chunks.every((_, index) => encodedEmbeddings[index] !== null);
    const contentHash = metadata?.contentHash ?? "";
    const indexVersion = metadata?.indexVersion ?? INDEX_VERSION;

    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE relative_path = ?").run(normalizedRelPath);
      this.db.prepare("DELETE FROM chunks_fts WHERE relative_path = ?").run(normalizedRelPath);
      this.db.prepare("DELETE FROM chunk_vectors WHERE relative_path = ?").run(normalizedRelPath);

      this.db.prepare(`
        INSERT INTO documents (
          relative_path, file_type, original_pdf, mtime, created_at,
          content_hash, index_version, vectors_complete
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedRelPath,
        fileType,
        normalizedPdf,
        mtime,
        Date.now(),
        contentHash,
        indexVersion,
        vectorsComplete ? 1 : 0
      );

      const insertFts = this.db.prepare(`
        INSERT INTO chunks_fts (
          relative_path, original_pdf, heading_path, start_line, end_line, content, search_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertVector = this.db.prepare(`
        INSERT INTO chunk_vectors (
          relative_path, original_pdf, heading_path, start_line, end_line, content, embedding
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        insertFts.run(
          normalizedRelPath,
          normalizedPdf,
          chunk.headingPath,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          makeSearchText(chunk.content, chunk.headingPath, normalizedRelPath)
        );

        if (encodedEmbeddings[i]) {
          insertVector.run(
            normalizedRelPath,
            normalizedPdf,
            chunk.headingPath,
            chunk.startLine,
            chunk.endLine,
            chunk.content,
            encodedEmbeddings[i]
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

  /** BM25 keyword search over generated Chinese and original Latin terms. */
  public searchBM25(query: string, limit = 10): SearchResult[] {
    const ftsQuery = makeFtsQuery(query);
    if (!ftsQuery) return [];
    const safeLimit = normalizeLimit(limit, 10);
    const rows = this.db.prepare(`
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
    `).all(ftsQuery, safeLimit) as FtsRow[];
    return rows.map(toSearchResult);
  }

  /** Local dot-product search over vectors with the exact same dimension. */
  public searchVector(queryEmbedding: Float32Array, limit = 10): SearchResult[] {
    if (!(queryEmbedding instanceof Float32Array) || queryEmbedding.length === 0) {
      throw new TypeError("Query embedding must be a non-empty Float32Array");
    }
    for (let i = 0; i < queryEmbedding.length; i++) {
      if (!Number.isFinite(queryEmbedding[i])) throw new TypeError(`Query embedding contains a non-finite value at index ${i}`);
    }

    const rows = this.db.prepare(`
      SELECT relative_path, original_pdf, heading_path, start_line, end_line, content, embedding
      FROM chunk_vectors
    `).all() as VectorRow[];
    if (rows.length === 0) return [];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      const docEmbedding = decodeEmbedding(row.embedding);
      if (docEmbedding.length !== queryEmbedding.length) {
        throw new RangeError(
          `Embedding dimension mismatch for ${row.relative_path} at line ${row.start_line}: ` +
          `stored ${docEmbedding.length}, query ${queryEmbedding.length}`
        );
      }

      let dotProduct = 0;
      for (let i = 0; i < queryEmbedding.length; i++) dotProduct += queryEmbedding[i] * docEmbedding[i];
      scored.push({
        relativePath: row.relative_path,
        originalPdf: row.original_pdf,
        headingPath: row.heading_path,
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
        content: row.content,
        score: dotProduct,
        vectorScore: dotProduct,
        matchType: "vector"
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, normalizeLimit(limit, 10));
  }

  /** Combine the two ordered candidate lists with reciprocal rank fusion. */
  public searchHybrid(query: string, queryEmbedding: Float32Array | null, limit = 5): SearchResult[] {
    if (!makeFtsQuery(query)) return [];
    const safeLimit = normalizeLimit(limit, 5);
    const bm25Results = this.searchBM25(query, safeLimit * 2);
    if (!queryEmbedding) return bm25Results.slice(0, safeLimit);

    const vectorResults = this.searchVector(queryEmbedding, safeLimit * 2);
    const k = 60;
    const scoreMap = new Map<string, {
      rrfScore: number;
      item: SearchResult;
      matchType: "bm25" | "vector" | "hybrid";
      bm25Rank?: number;
      vectorScore?: number;
    }>();

    bm25Results.forEach((item, index) => {
      const key = `${item.relativePath}#${item.startLine}`;
      scoreMap.set(key, {
        rrfScore: 1 / (k + index + 1),
        item,
        matchType: "bm25",
        bm25Rank: item.bm25Rank
      });
    });

    vectorResults.forEach((item, index) => {
      const key = `${item.relativePath}#${item.startLine}`;
      const existing = scoreMap.get(key);
      const rrf = 1 / (k + index + 1);
      if (existing) {
        existing.rrfScore += rrf;
        existing.matchType = "hybrid";
        existing.vectorScore = item.vectorScore;
      } else {
        scoreMap.set(key, {
          rrfScore: rrf,
          item,
          matchType: "vector",
          vectorScore: item.vectorScore
        });
      }
    });

    return Array.from(scoreMap.values())
      .sort((a, b) => b.rrfScore - a.rrfScore)
      .slice(0, safeLimit)
      .map(({ item, matchType, rrfScore, bm25Rank, vectorScore }) => ({
        ...item,
        score: rrfScore,
        bm25Rank,
        vectorScore,
        matchType
      }));
  }

  public getDocumentState(relativePath: string): DocumentState | null {
    const normalized = relativePath.replace(/\\/g, "/");
    const row = this.db.prepare(`
      SELECT content_hash, index_version, original_pdf, vectors_complete
      FROM documents WHERE relative_path = ?
    `).get(normalized) as {
      content_hash: string;
      index_version: string;
      original_pdf: string | null;
      vectors_complete: number;
    } | undefined;
    if (!row) return null;
    return {
      contentHash: row.content_hash,
      indexVersion: row.index_version,
      originalPdf: row.original_pdf,
      vectorsComplete: row.vectors_complete === 1
    };
  }

  public listDocumentPaths(): string[] {
    return (this.db.prepare("SELECT relative_path FROM documents ORDER BY relative_path").all() as Array<{ relative_path: string }>)
      .map((row) => row.relative_path);
  }

  public getStats(): VaultStats {
    const totalDocs = (this.db.prepare("SELECT count(*) as cnt FROM documents").get() as { cnt: number }).cnt;
    const totalChunks = (this.db.prepare("SELECT count(*) as cnt FROM chunks_fts").get() as { cnt: number }).cnt;
    const totalVectors = (this.db.prepare("SELECT count(*) as cnt FROM chunk_vectors").get() as { cnt: number }).cnt;
    const incompleteDocuments = (this.db.prepare(`
      SELECT count(*) as cnt
      FROM documents
      WHERE index_version <> ? OR vectors_complete = 0
    `).get(INDEX_VERSION) as { cnt: number }).cnt;
    const totalTwinPdfs = (this.db.prepare(
      "SELECT count(DISTINCT original_pdf) as cnt FROM documents WHERE original_pdf IS NOT NULL"
    ).get() as { cnt: number }).cnt;

    const walPath = `${this.dbPath}-wal`;
    const mainSize = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

    return {
      vaultPath: this.vaultRoot,
      dbPath: this.dbPath,
      totalDocuments: totalDocs,
      totalChunks,
      totalTwinPdfs,
      totalVectors,
      incompleteDocuments,
      dbSizeKb: Math.round((mainSize + walSize) / 1024)
    };
  }

  public close() {
    this.db.close();
  }
}
