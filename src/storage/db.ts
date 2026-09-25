import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { INDEX_VERSION } from "../config.js";
import type { MarkdownChunk } from "../parser/markdown.js";
import { getEmbeddingProfile, type EmbeddingProfileName } from "./profiles.js";
import { makeFtsQuery, makeSearchText } from "./searchText.js";

const DATABASE_SCHEMA_VERSION = "3";

export type SearchSourceType = "markdown" | "code" | "pdf" | "pdf-native" | "pdf-import";
export type PdfExtractionStatus = "pending" | "extracting" | "ready" | "empty" | "failed";

export interface SearchResult {
  relativePath: string;
  originalPdf: string | null;
  headingPath: string;
  startLine: number;
  endLine: number;
  content: string;
  score: number;
  matchType?: "bm25" | "vector" | "hybrid";
  bm25Rank?: number;
  vectorScore?: number;
  sourceType: SearchSourceType;
  sourceVersion: string;
  citationId: string;
  pageStart: number | null;
  pageEnd: number | null;
  stale: boolean;
  sourceId: string;
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
  totalPdfDocuments: number;
  pdfReady: number;
  pdfPending: number;
  pdfExtracting: number;
  pdfEmpty: number;
  pdfFailed: number;
  pdfStale: number;
  pdfPages: number;
  pdfCoverage: number;
}

export interface DocumentMetadata {
  contentHash: string;
  indexVersion: string;
  sourceType?: SearchSourceType;
  sourceVersion?: string;
  sourceId?: string;
  stale?: boolean;
  parseVersion?: string;
  embeddingFingerprint?: string;
  pdfExtraction?: PdfExtractionWrite;
}

export interface DocumentState {
  contentHash: string;
  indexVersion: string;
  originalPdf: string | null;
  vectorsComplete: boolean;
}

export interface DocumentSourceState extends DocumentState {
  sourceType: SearchSourceType;
  sourceVersion: string;
  sourceId: string;
  stale: boolean;
  parseVersion: string;
}

export interface PdfPageRecord {
  page: number | null;
  text: string;
}

export interface PdfExtractionState {
  status: PdfExtractionStatus;
  sourceHash: string;
  inputHash: string;
  parseVersion: string;
  pageCount: number;
  extractedPageCount: number;
  coverage: number;
  coverageKind: "extracted" | "mapped";
  error: string | null;
  stale: boolean;
}

export interface PdfExtractionWrite extends PdfExtractionState {
  pages?: PdfPageRecord[];
}

interface SearchRow {
  relative_path: string;
  original_pdf: string | null;
  heading_path: string;
  start_line: number;
  end_line: number;
  content: string;
  rank?: number;
  embedding?: Buffer;
  source_type: SearchSourceType;
  source_version: string;
  source_id: string;
  stale: number;
  page_start: number | null;
  page_end: number | null;
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

function citationId(row: SearchRow): string {
  const contentHash = createHash("sha256").update(row.content, "utf8").digest("hex");
  const payload = [
    row.source_id,
    row.source_version,
    row.page_start,
    row.page_end,
    row.start_line,
    row.end_line,
    contentHash,
  ].join("\0");
  return `cite_${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32)}`;
}

function toSearchResult(row: SearchRow, score: number, matchType: SearchResult["matchType"], rank?: number, vectorScore?: number): SearchResult {
  return {
    relativePath: row.relative_path,
    originalPdf: row.original_pdf,
    headingPath: row.heading_path,
    startLine: Number(row.start_line),
    endLine: Number(row.end_line),
    content: row.content,
    score,
    ...(rank === undefined ? {} : { bm25Rank: rank }),
    ...(vectorScore === undefined ? {} : { vectorScore }),
    matchType,
    sourceType: row.source_type,
    sourceVersion: row.source_version,
    citationId: citationId(row),
    pageStart: row.page_start === null ? null : Number(row.page_start),
    pageEnd: row.page_end === null ? null : Number(row.page_end),
    stale: row.stale === 1,
    sourceId: row.source_id,
  };
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function tableColumns(db: Database.Database, tableName: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((column) => column.name));
}

function embeddingConfigMatches(serialized: string, expected: object): boolean {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const canonical = (value: object) => JSON.stringify(
      Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))),
    );
    return canonical(parsed) === canonical(expected);
  } catch {
    return false;
  }
}

export class VaultDatabase {
  private db: Database.Database;
  private dbPath: string;
  private vaultRoot: string;
  private readonlyMode: boolean;
  private embeddingProfile: EmbeddingProfileName;

  constructor(vaultRoot: string, options: { readonly?: boolean } = {}) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.dbPath = path.join(this.vaultRoot, ".vault_index.db");
    this.readonlyMode = options.readonly ?? false;

    if (this.readonlyMode) {
      if (!fs.existsSync(this.dbPath)) throw new Error(`只读数据库不存在，拒绝创建：${this.dbPath}`);
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      try {
        if (!tableExists(this.db, "vault_metadata")) {
          throw new Error("知识库数据库需要升级；请先以写模式启动一次再使用只读模式。");
        }
        const schemaVersion = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
        if (schemaVersion?.value !== DATABASE_SCHEMA_VERSION) {
          throw new Error("知识库数据库需要升级；请先以写模式启动一次再使用只读模式。");
        }
        const profile = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_profile'").get() as { value: string } | undefined;
        if (!profile) throw new Error("数据库缺少向量模型配置，请先以写模式打开并完成迁移。");
        this.embeddingProfile = this.parseProfile(profile.value);
        const embeddingConfig = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_config'").get() as { value: string } | undefined;
        if (!embeddingConfig || !embeddingConfigMatches(embeddingConfig.value, getEmbeddingProfile(this.embeddingProfile))) {
          throw new Error("数据库的embedding配置缺失或与当前程序不一致；请先以写模式打开并重新索引，再使用只读模式。");
        }
      } catch (error) {
        this.db.close();
        throw error;
      }
      return;
    }

    fs.mkdirSync(this.vaultRoot, { recursive: true });
    const existedBeforeOpen = fs.existsSync(this.dbPath);
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    try {
      this.initTables(existedBeforeOpen);
      this.embeddingProfile = this.readEmbeddingProfile();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private parseProfile(value: string): EmbeddingProfileName {
    if (value !== "bge-small-zh" && value !== "multilingual-e5-small") {
      throw new Error(`数据库保存了未知的embedding profile: ${value}`);
    }
    return value;
  }

  private readEmbeddingProfile(): EmbeddingProfileName {
    const row = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_profile'").get() as { value: string } | undefined;
    if (!row) throw new Error("数据库迁移未写入embedding profile。");
    return this.parseProfile(row.value);
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
        page_start UNINDEXED,
        page_end UNINDEXED,
        tokenize = 'unicode61'
      );
    `);
  }

  private initTables(_existingFile: boolean) {
    const hadDocumentsTable = tableExists(this.db, "documents");
    const migrate = this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vault_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          relative_path TEXT UNIQUE NOT NULL,
          file_type TEXT NOT NULL,
          original_pdf TEXT,
          mtime INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          content_hash TEXT NOT NULL DEFAULT '',
          index_version TEXT NOT NULL DEFAULT '',
          vectors_complete INTEGER NOT NULL DEFAULT 0,
          source_type TEXT NOT NULL DEFAULT 'markdown',
          source_version TEXT NOT NULL DEFAULT '',
          source_id TEXT NOT NULL DEFAULT '',
          parse_version TEXT NOT NULL DEFAULT '',
          stale INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS chunk_vectors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          relative_path TEXT NOT NULL,
          original_pdf TEXT,
          heading_path TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          page_start INTEGER,
          page_end INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_vec_relpath ON chunk_vectors(relative_path);
        CREATE TABLE IF NOT EXISTS pdf_extractions (
          relative_path TEXT NOT NULL,
          source_hash TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          parse_version TEXT NOT NULL,
          status TEXT NOT NULL,
          page_count INTEGER NOT NULL DEFAULT 0,
          extracted_page_count INTEGER NOT NULL DEFAULT 0,
          coverage_kind TEXT NOT NULL DEFAULT 'extracted',
          error TEXT,
          stale INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (relative_path, input_hash, parse_version)
        );
        CREATE INDEX IF NOT EXISTS idx_pdf_extractions_latest ON pdf_extractions(relative_path, updated_at DESC);
        CREATE TABLE IF NOT EXISTS pdf_pages (
          relative_path TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          parse_version TEXT NOT NULL,
          page_order INTEGER NOT NULL,
          page_number INTEGER,
          text TEXT NOT NULL,
          text_hash TEXT NOT NULL,
          PRIMARY KEY (relative_path, input_hash, parse_version, page_order)
        );
      `);

      const documentColumns = tableColumns(this.db, "documents");
      const documentMigrations: Array<[string, string]> = [
        ["content_hash", "ALTER TABLE documents ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''"],
        ["index_version", "ALTER TABLE documents ADD COLUMN index_version TEXT NOT NULL DEFAULT ''"],
        ["vectors_complete", "ALTER TABLE documents ADD COLUMN vectors_complete INTEGER NOT NULL DEFAULT 0"],
        ["source_type", "ALTER TABLE documents ADD COLUMN source_type TEXT NOT NULL DEFAULT 'markdown'"],
        ["source_version", "ALTER TABLE documents ADD COLUMN source_version TEXT NOT NULL DEFAULT ''"],
        ["source_id", "ALTER TABLE documents ADD COLUMN source_id TEXT NOT NULL DEFAULT ''"],
        ["parse_version", "ALTER TABLE documents ADD COLUMN parse_version TEXT NOT NULL DEFAULT ''"],
        ["stale", "ALTER TABLE documents ADD COLUMN stale INTEGER NOT NULL DEFAULT 0"],
      ];
      for (const [column, sql] of documentMigrations) if (!documentColumns.has(column)) this.db.exec(sql);

      const vectorColumns = tableColumns(this.db, "chunk_vectors");
      if (!vectorColumns.has("page_start")) this.db.exec("ALTER TABLE chunk_vectors ADD COLUMN page_start INTEGER");
      if (!vectorColumns.has("page_end")) this.db.exec("ALTER TABLE chunk_vectors ADD COLUMN page_end INTEGER");

      const hadFtsTable = tableExists(this.db, "chunks_fts");
      if (!hadFtsTable) this.createFtsTable();
      const ftsColumns = tableColumns(this.db, "chunks_fts");
      const requiredFtsColumns = ["relative_path", "original_pdf", "heading_path", "start_line", "end_line", "content", "search_text", "page_start", "page_end"];
      if (!hadFtsTable || requiredFtsColumns.some((column) => !ftsColumns.has(column))) {
        const hasSearchText = ftsColumns.has("search_text");
        const hasPageStart = ftsColumns.has("page_start");
        const hasPageEnd = ftsColumns.has("page_end");
        const oldRows = hadFtsTable ? this.db.prepare(`
          SELECT relative_path, original_pdf, heading_path, start_line, end_line, content
            ${hasSearchText ? ", search_text" : ""}
            ${hasPageStart ? ", page_start" : ""}
            ${hasPageEnd ? ", page_end" : ""}
          FROM chunks_fts
        `).all() as Array<{
          relative_path: string; original_pdf: string | null; heading_path: string; start_line: number;
          end_line: number; content: string; search_text?: string; page_start?: number | null; page_end?: number | null;
        }> : this.db.prepare(`
          SELECT relative_path, original_pdf, heading_path, start_line, end_line, content,
                 NULL AS search_text, NULL AS page_start, NULL AS page_end
          FROM chunk_vectors
        `).all() as Array<{
          relative_path: string; original_pdf: string | null; heading_path: string; start_line: number;
          end_line: number; content: string; search_text?: null; page_start: number | null; page_end: number | null;
        }>;
        if (hadFtsTable) {
          this.db.exec("DROP TABLE chunks_fts");
          this.createFtsTable();
        }
        const insert = this.db.prepare(`
          INSERT INTO chunks_fts (
            relative_path, original_pdf, heading_path, start_line, end_line, content, search_text, page_start, page_end
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of oldRows) insert.run(
          row.relative_path, row.original_pdf, row.heading_path, row.start_line, row.end_line, row.content,
          row.search_text ?? makeSearchText(row.content, row.heading_path, row.relative_path),
          row.page_start ?? null, row.page_end ?? null,
        );
      }

      this.db.prepare(`
        UPDATE documents
        SET source_type = CASE
              WHEN source_type IN ('', 'markdown') AND lower(file_type) LIKE '%pdf%' THEN 'pdf'
              WHEN source_type IN ('', 'markdown') AND lower(file_type) = 'code' THEN 'code'
              ELSE source_type END,
            source_version = CASE WHEN source_version = '' THEN content_hash ELSE source_version END,
            source_id = CASE WHEN source_id = '' THEN relative_path ELSE source_id END
      `).run();

      const storedProfileRow = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_profile'").get() as { value: string } | undefined;
      const activeProfile: EmbeddingProfileName = storedProfileRow
        ? this.parseProfile(storedProfileRow.value)
        : hadDocumentsTable ? "bge-small-zh" : "multilingual-e5-small";
      const activeEmbeddingConfig = getEmbeddingProfile(activeProfile);
      const storedConfigRow = this.db.prepare("SELECT value FROM vault_metadata WHERE key = 'embedding_config'").get() as { value: string } | undefined;
      const embeddingConfigCurrent = Boolean(
        storedProfileRow && storedConfigRow && embeddingConfigMatches(storedConfigRow.value, activeEmbeddingConfig),
      );
      const resetVectors = !embeddingConfigCurrent;
      this.db.prepare("INSERT OR REPLACE INTO vault_metadata (key, value) VALUES ('embedding_profile', ?)").run(activeProfile);
      this.db.prepare("INSERT OR REPLACE INTO vault_metadata (key, value) VALUES ('embedding_config', ?)")
        .run(JSON.stringify(activeEmbeddingConfig));
      this.db.prepare("INSERT OR REPLACE INTO vault_metadata (key, value) VALUES ('schema_version', ?)").run(DATABASE_SCHEMA_VERSION);

      // Missing or changed model configuration means stored vectors cannot be
      // trusted even when INDEX_VERSION and the profile name are unchanged.
      // Keep lexical rows so searches remain available until vectors rebuild.
      if (resetVectors) {
        this.db.exec("DELETE FROM chunk_vectors");
        this.db.exec("UPDATE documents SET vectors_complete = 0");
      } else {
        this.db.prepare(`
          DELETE FROM chunk_vectors
          WHERE relative_path NOT IN (SELECT relative_path FROM documents)
             OR relative_path IN (SELECT relative_path FROM documents WHERE index_version <> ?)
        `).run(INDEX_VERSION);
        this.db.prepare("UPDATE documents SET vectors_complete = 0 WHERE index_version <> ?").run(INDEX_VERSION);
      }
    });
    migrate();
  }

  public getEmbeddingProfile(): EmbeddingProfileName {
    return this.embeddingProfile;
  }

  public setEmbeddingProfile(name: EmbeddingProfileName): void {
    if (this.readonlyMode) throw new Error("只读数据库不能切换embedding profile。");
    const config = getEmbeddingProfile(name);
    if (name === this.embeddingProfile) return;
    const change = this.db.transaction(() => {
      this.db.prepare("INSERT OR REPLACE INTO vault_metadata (key, value) VALUES ('embedding_profile', ?)").run(name);
      this.db.prepare("INSERT OR REPLACE INTO vault_metadata (key, value) VALUES ('embedding_config', ?)").run(JSON.stringify(config));
      this.db.exec("DELETE FROM chunk_vectors");
      this.db.exec("UPDATE documents SET vectors_complete = 0");
    });
    change();
    this.embeddingProfile = name;
  }

  private writePdfExtraction(relativePath: string, extraction: PdfExtractionWrite) {
    this.db.prepare(`
      INSERT OR REPLACE INTO pdf_extractions (
        relative_path, source_hash, input_hash, parse_version, status,
        page_count, extracted_page_count, coverage_kind, error, stale, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      relativePath, extraction.sourceHash, extraction.inputHash, extraction.parseVersion,
      extraction.status, extraction.pageCount, extraction.extractedPageCount,
      extraction.coverageKind, extraction.error, extraction.stale ? 1 : 0, Date.now(),
    );
    if (extraction.pages) {
      this.db.prepare(`
        DELETE FROM pdf_pages WHERE relative_path = ? AND input_hash = ? AND parse_version = ?
      `).run(relativePath, extraction.inputHash, extraction.parseVersion);
      const insertPage = this.db.prepare(`
        INSERT INTO pdf_pages (
          relative_path, input_hash, parse_version, page_order, page_number, text, text_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      extraction.pages.forEach((record, index) => {
        insertPage.run(
          relativePath, extraction.inputHash, extraction.parseVersion, index + 1, record.page,
          record.text, createHash("sha256").update(record.text, "utf8").digest("hex"),
        );
      });
    }
  }

  public beginPdfExtraction(
    relativePath: string,
    values: Pick<PdfExtractionWrite, "sourceHash" | "inputHash" | "parseVersion"> & { coverageKind?: "extracted" | "mapped" },
  ): void {
    if (this.readonlyMode) throw new Error("只读数据库不能更新PDF提取状态。");
    const normalized = relativePath.replace(/\\/g, "/");
    const transaction = this.db.transaction(() => {
      const hasPrevious = Boolean(this.db.prepare("SELECT 1 FROM documents WHERE relative_path = ?").get(normalized));
      this.writePdfExtraction(normalized, {
        ...values,
        status: "extracting",
        pageCount: 0,
        extractedPageCount: 0,
        coverage: 0,
        coverageKind: values.coverageKind ?? "extracted",
        error: null,
        stale: hasPrevious,
      });
      if (hasPrevious) this.db.prepare("UPDATE documents SET stale = 1 WHERE relative_path = ?").run(normalized);
    });
    transaction();
  }

  /** Register a first-seen PDF once so queued files are visible in status. */
  public queuePdfExtraction(
    relativePath: string,
    values: Pick<PdfExtractionWrite, "sourceHash" | "inputHash" | "parseVersion"> & { coverageKind?: "extracted" | "mapped" },
  ): boolean {
    if (this.readonlyMode) throw new Error("只读数据库不能登记PDF提取状态。");
    const normalized = relativePath.replace(/\\/g, "/");
    const transaction = this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM documents WHERE relative_path = ?").get(normalized) ||
          this.db.prepare("SELECT 1 FROM pdf_extractions WHERE relative_path = ? LIMIT 1").get(normalized)) return false;
      this.writePdfExtraction(normalized, {
        ...values,
        status: "pending",
        pageCount: 0,
        extractedPageCount: 0,
        coverage: 0,
        coverageKind: values.coverageKind ?? "extracted",
        error: null,
        stale: false,
      });
      return true;
    });
    return transaction();
  }

  public failPdfExtraction(
    relativePath: string,
    values: Pick<PdfExtractionWrite, "sourceHash" | "inputHash" | "parseVersion"> & {
      error: string;
      status?: "empty" | "failed";
      pageCount?: number;
      extractedPageCount?: number;
      coverageKind?: "extracted" | "mapped";
      pages?: PdfPageRecord[];
    },
  ): void {
    if (this.readonlyMode) throw new Error("只读数据库不能更新PDF提取状态。");
    const normalized = relativePath.replace(/\\/g, "/");
    const transaction = this.db.transaction(() => {
      const previous = this.db.prepare("SELECT page_count, extracted_page_count, coverage_kind FROM pdf_extractions WHERE relative_path = ? AND status IN ('ready','empty') ORDER BY updated_at DESC, rowid DESC LIMIT 1")
        .get(normalized) as { page_count: number; extracted_page_count: number; coverage_kind: "extracted" | "mapped" } | undefined;
      const hasPrevious = Boolean(this.db.prepare("SELECT 1 FROM documents WHERE relative_path = ?").get(normalized));
      const pageCount = values.pageCount ?? previous?.page_count ?? 0;
      const extractedPageCount = values.extractedPageCount ?? previous?.extracted_page_count ?? 0;
      this.writePdfExtraction(normalized, {
        sourceHash: values.sourceHash,
        inputHash: values.inputHash,
        parseVersion: values.parseVersion,
        status: values.status ?? "failed",
        pageCount,
        extractedPageCount,
        coverage: pageCount > 0 ? extractedPageCount / pageCount : 0,
        coverageKind: values.coverageKind ?? previous?.coverage_kind ?? "extracted",
        error: values.error,
        stale: hasPrevious,
        ...(values.pages ? { pages: values.pages } : {}),
      });
      if (hasPrevious) this.db.prepare("UPDATE documents SET stale = 1 WHERE relative_path = ?").run(normalized);
    });
    transaction();
  }

  public markDocumentStale(relativePath: string, stale = true): void {
    if (this.readonlyMode) throw new Error("只读数据库不能更新来源状态。");
    const normalized = relativePath.replace(/\\/g, "/");
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE documents SET stale = ? WHERE relative_path = ?").run(stale ? 1 : 0, normalized);
      this.db.prepare(`
        UPDATE pdf_extractions SET stale = ?
        WHERE relative_path = ? AND rowid = (
          SELECT rowid FROM pdf_extractions WHERE relative_path = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1
        )
      `).run(stale ? 1 : 0, normalized, normalized);
    });
    transaction();
  }

  public saveDocument(
    relativePath: string,
    fileType: string,
    originalPdf: string | null,
    mtime: number,
    chunks: MarkdownChunk[],
    embeddings?: Array<Float32Array | null>,
    metadata?: DocumentMetadata,
  ) {
    if (this.readonlyMode) throw new Error("只读数据库不能保存文档索引。");
    const normalizedRelPath = relativePath.replace(/\\/g, "/");
    const normalizedPdf = originalPdf ? originalPdf.replace(/\\/g, "/") : null;
    if (embeddings && embeddings.length > chunks.length) throw new RangeError("Embedding list cannot contain more entries than chunks");
    const profile = getEmbeddingProfile(this.embeddingProfile);
    if (metadata?.embeddingFingerprint && metadata.embeddingFingerprint !== profile.fingerprint) {
      throw new Error(`Embedding fingerprint does not match the active profile ${profile.name}.`);
    }

    const encodedEmbeddings = chunks.map((_, index) => {
      const embedding = embeddings?.[index] ?? null;
      if (!embedding) return null;
      const encoded = encodeEmbedding(embedding);
      if (metadata?.embeddingFingerprint && embedding.length !== profile.dimensions) {
        throw new RangeError(`Embedding dimension ${embedding.length} does not match profile ${profile.name} (${profile.dimensions}).`);
      }
      return encoded;
    });
    const vectorsComplete = chunks.every((_, index) => encodedEmbeddings[index] !== null);
    const contentHash = metadata?.contentHash ?? "";
    const indexVersion = metadata?.indexVersion ?? INDEX_VERSION;
    const sourceType = metadata?.sourceType ?? (fileType === "code" ? "code" : fileType.includes("pdf") ? "pdf" : "markdown");
    const sourceVersion = metadata?.sourceVersion ?? contentHash;
    const sourceId = metadata?.sourceId ?? normalizedRelPath;
    const stale = metadata?.stale ? 1 : 0;

    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE relative_path = ?").run(normalizedRelPath);
      this.db.prepare("DELETE FROM chunks_fts WHERE relative_path = ?").run(normalizedRelPath);
      this.db.prepare("DELETE FROM chunk_vectors WHERE relative_path = ?").run(normalizedRelPath);

      this.db.prepare(`
        INSERT INTO documents (
          relative_path, file_type, original_pdf, mtime, created_at,
          content_hash, index_version, vectors_complete, source_type,
          source_version, source_id, parse_version, stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalizedRelPath, fileType, normalizedPdf, mtime, Date.now(), contentHash, indexVersion,
        vectorsComplete ? 1 : 0, sourceType, sourceVersion, sourceId, metadata?.parseVersion ?? "", stale,
      );

      const insertFts = this.db.prepare(`
        INSERT INTO chunks_fts (
          relative_path, original_pdf, heading_path, start_line, end_line, content,
          search_text, page_start, page_end
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertVector = this.db.prepare(`
        INSERT INTO chunk_vectors (
          relative_path, original_pdf, heading_path, start_line, end_line, content,
          embedding, page_start, page_end
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index];
        insertFts.run(
          normalizedRelPath, normalizedPdf, chunk.headingPath, chunk.startLine, chunk.endLine,
          chunk.content, makeSearchText(chunk.content, chunk.headingPath, normalizedRelPath),
          chunk.pageStart ?? null, chunk.pageEnd ?? null,
        );
        if (encodedEmbeddings[index]) {
          insertVector.run(
            normalizedRelPath, normalizedPdf, chunk.headingPath, chunk.startLine, chunk.endLine,
            chunk.content, encodedEmbeddings[index], chunk.pageStart ?? null, chunk.pageEnd ?? null,
          );
        }
      }

      if (metadata?.pdfExtraction) this.writePdfExtraction(normalizedRelPath, metadata.pdfExtraction);
    });
    transaction();
  }

  public deleteDocument(relativePath: string) {
    if (this.readonlyMode) throw new Error("只读数据库不能删除文档索引。");
    const normalized = relativePath.replace(/\\/g, "/");
    const transaction = this.db.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE relative_path = ?").run(normalized);
      this.db.prepare("DELETE FROM chunks_fts WHERE relative_path = ?").run(normalized);
      this.db.prepare("DELETE FROM chunk_vectors WHERE relative_path = ?").run(normalized);
      this.db.prepare("DELETE FROM pdf_pages WHERE relative_path = ?").run(normalized);
      this.db.prepare("DELETE FROM pdf_extractions WHERE relative_path = ?").run(normalized);
    });
    transaction();
  }

  public searchBM25(query: string, limit = 10): SearchResult[] {
    const ftsQuery = makeFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db.prepare(`
      SELECT f.relative_path, f.original_pdf, f.heading_path, f.start_line, f.end_line,
        f.content, f.page_start, f.page_end, d.source_type, d.source_version,
        d.source_id, d.stale, bm25(chunks_fts) AS rank
      FROM chunks_fts f JOIN documents d ON d.relative_path = f.relative_path
      WHERE chunks_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(ftsQuery, normalizeLimit(limit, 10)) as SearchRow[];
    return rows.map((row) => toSearchResult(row, -Number(row.rank), "bm25", Number(row.rank)));
  }

  public searchVector(queryEmbedding: Float32Array, limit = 10): SearchResult[] {
    if (!(queryEmbedding instanceof Float32Array) || queryEmbedding.length === 0) {
      throw new TypeError("Query embedding must be a non-empty Float32Array");
    }
    for (let index = 0; index < queryEmbedding.length; index++) {
      if (!Number.isFinite(queryEmbedding[index])) throw new TypeError(`Query embedding contains a non-finite value at index ${index}`);
    }
    const rows = this.db.prepare(`
      SELECT v.relative_path, v.original_pdf, v.heading_path, v.start_line, v.end_line,
        v.content, v.embedding, v.page_start, v.page_end, d.source_type,
        d.source_version, d.source_id, d.stale
      FROM chunk_vectors v JOIN documents d ON d.relative_path = v.relative_path
      WHERE d.stale = 0
    `).all() as SearchRow[];
    const scored: SearchResult[] = [];
    for (const row of rows) {
      const docEmbedding = decodeEmbedding(row.embedding!);
      if (docEmbedding.length !== queryEmbedding.length) {
        throw new RangeError(`Embedding dimension mismatch for ${row.relative_path} at line ${row.start_line}: stored ${docEmbedding.length}, query ${queryEmbedding.length}`);
      }
      let score = 0;
      for (let index = 0; index < queryEmbedding.length; index++) score += queryEmbedding[index] * docEmbedding[index];
      scored.push(toSearchResult(row, score, "vector", undefined, score));
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, normalizeLimit(limit, 10));
  }

  public searchHybrid(query: string, queryEmbedding: Float32Array | null, limit = 5): SearchResult[] {
    if (!makeFtsQuery(query)) return [];
    const safeLimit = normalizeLimit(limit, 5);
    const bm25Results = this.searchBM25(query, safeLimit * 2);
    if (!queryEmbedding) return bm25Results.slice(0, safeLimit);
    const vectorResults = this.searchVector(queryEmbedding, safeLimit * 2);
    const k = 60;
    const scoreMap = new Map<string, { score: number; item: SearchResult; matchType: "bm25" | "vector" | "hybrid"; bm25Rank?: number; vectorScore?: number }>();
    bm25Results.forEach((item, index) => scoreMap.set(item.citationId, {
      score: 1 / (k + index + 1), item, matchType: "bm25", bm25Rank: item.bm25Rank,
    }));
    vectorResults.forEach((item, index) => {
      const key = item.citationId;
      const rrfScore = 1 / (k + index + 1);
      const current = scoreMap.get(key);
      if (current) {
        current.score += rrfScore;
        current.matchType = "hybrid";
        current.vectorScore = item.vectorScore;
      } else {
        scoreMap.set(key, { score: rrfScore, item, matchType: "vector", vectorScore: item.vectorScore });
      }
    });
    return [...scoreMap.values()].sort((a, b) => b.score - a.score).slice(0, safeLimit).map(({ item, score, matchType, bm25Rank, vectorScore }) => ({
      ...item, score, matchType, bm25Rank, vectorScore,
    }));
  }

  public getDocumentState(relativePath: string): DocumentState | null {
    const row = this.db.prepare(`
      SELECT content_hash, index_version, original_pdf, vectors_complete
      FROM documents WHERE relative_path = ?
    `).get(relativePath.replace(/\\/g, "/")) as { content_hash: string; index_version: string; original_pdf: string | null; vectors_complete: number } | undefined;
    if (!row) return null;
    return { contentHash: row.content_hash, indexVersion: row.index_version, originalPdf: row.original_pdf, vectorsComplete: row.vectors_complete === 1 };
  }

  public getDocumentSourceState(relativePath: string): DocumentSourceState | null {
    const row = this.db.prepare(`
      SELECT content_hash, index_version, original_pdf, vectors_complete,
        source_type, source_version, source_id, stale, parse_version
      FROM documents WHERE relative_path = ?
    `).get(relativePath.replace(/\\/g, "/")) as {
      content_hash: string; index_version: string; original_pdf: string | null; vectors_complete: number;
      source_type: SearchSourceType; source_version: string; source_id: string; stale: number; parse_version: string;
    } | undefined;
    if (!row) return null;
    return {
      contentHash: row.content_hash, indexVersion: row.index_version, originalPdf: row.original_pdf,
      vectorsComplete: row.vectors_complete === 1, sourceType: row.source_type,
      sourceVersion: row.source_version, sourceId: row.source_id, stale: row.stale === 1, parseVersion: row.parse_version,
    };
  }

  public listDocumentPaths(): string[] {
    return (this.db.prepare("SELECT relative_path FROM documents ORDER BY relative_path").all() as Array<{ relative_path: string }>).map((row) => row.relative_path);
  }

  /** All source paths known to reconciliation, including failed/empty PDFs without documents rows. */
  public listSourcePaths(): string[] {
    return (this.db.prepare(`
      SELECT relative_path FROM documents
      UNION
      SELECT relative_path FROM pdf_extractions
      ORDER BY relative_path
    `).all() as Array<{ relative_path: string }>).map((row) => row.relative_path);
  }

  public listImportedPdfPaths(): string[] {
    return (this.db.prepare("SELECT relative_path FROM documents WHERE source_type = 'pdf-import' ORDER BY relative_path").all() as Array<{ relative_path: string }>).map((row) => row.relative_path);
  }

  public getPdfState(relativePath: string): PdfExtractionState | null {
    const row = this.db.prepare(`
      SELECT source_hash, input_hash, parse_version, status, page_count,
        extracted_page_count, coverage_kind, error, stale
      FROM pdf_extractions WHERE relative_path = ?
      ORDER BY updated_at DESC, rowid DESC LIMIT 1
    `).get(relativePath.replace(/\\/g, "/")) as {
      source_hash: string; input_hash: string; parse_version: string; status: PdfExtractionStatus;
      page_count: number; extracted_page_count: number; coverage_kind: "extracted" | "mapped";
      error: string | null; stale: number;
    } | undefined;
    if (!row) return null;
    return {
      sourceHash: row.source_hash, inputHash: row.input_hash, parseVersion: row.parse_version,
      status: row.status, pageCount: row.page_count, extractedPageCount: row.extracted_page_count,
      coverage: row.page_count > 0 ? row.extracted_page_count / row.page_count : 0,
      coverageKind: row.coverage_kind, error: row.error, stale: row.stale === 1,
    };
  }

  public getPdfPages(relativePath: string, inputHash?: string): PdfPageRecord[] {
    const normalized = relativePath.replace(/\\/g, "/");
    const document = inputHash ? undefined : this.db.prepare(`
      SELECT content_hash, parse_version, source_type FROM documents WHERE relative_path = ?
    `).get(normalized) as { content_hash: string; parse_version: string; source_type: SearchSourceType } | undefined;
    const preferredInputHash = inputHash ?? document?.content_hash;
    const preferredParseVersion = document?.parse_version;
    const state = preferredInputHash
      ? this.db.prepare(`SELECT input_hash, parse_version FROM pdf_extractions WHERE relative_path = ? AND input_hash = ? ${preferredParseVersion ? "AND parse_version = ?" : ""} AND status IN ('ready','empty') ORDER BY updated_at DESC, rowid DESC LIMIT 1`)
        .get(...(preferredParseVersion ? [normalized, preferredInputHash, preferredParseVersion] : [normalized, preferredInputHash])) as { input_hash: string; parse_version: string } | undefined
      : this.db.prepare(`SELECT input_hash, parse_version FROM pdf_extractions WHERE relative_path = ? AND status IN ('ready','empty') ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(normalized) as { input_hash: string; parse_version: string } | undefined;
    if (state) {
      return (this.db.prepare(`
        SELECT page_number, text FROM pdf_pages
        WHERE relative_path = ? AND input_hash = ? AND parse_version = ? ORDER BY page_order
      `).all(normalized, state.input_hash, state.parse_version) as Array<{ page_number: number | null; text: string }>).map((row) => ({ page: row.page_number, text: row.text }));
    }
    // Imported Markdown derived text remains in FTS rows if a page cache is
    // absent; null page means the manifest did not map that chunk unambiguously.
    const chunks = this.db.prepare(`
      SELECT page_start, page_end, content FROM chunks_fts
      WHERE relative_path = ? ORDER BY start_line, end_line
    `).all(normalized) as Array<{ page_start: number | null; page_end: number | null; content: string }>;
    return chunks.map((row) => ({
      page: row.page_start !== null && row.page_start === row.page_end ? row.page_start : null,
      text: row.content,
    }));
  }

  public getStats(): VaultStats {
    const count = (sql: string, ...params: unknown[]) => Number((this.db.prepare(sql).get(...params) as { cnt: number }).cnt);
    const latestPdfRows = this.db.prepare(`
      SELECT e.status, e.stale, e.page_count, e.extracted_page_count
      FROM pdf_extractions e
      WHERE e.rowid = (SELECT e2.rowid FROM pdf_extractions e2 WHERE e2.relative_path = e.relative_path ORDER BY e2.updated_at DESC, e2.rowid DESC LIMIT 1)
    `).all() as Array<{ status: PdfExtractionStatus; stale: number; page_count: number; extracted_page_count: number }>;
    const pdfCounts = { ready: 0, pending: 0, extracting: 0, empty: 0, failed: 0, stale: 0, pages: 0, extracted: 0 };
    for (const row of latestPdfRows) {
      pdfCounts[row.status]++;
      if (row.stale) pdfCounts.stale++;
      pdfCounts.pages += row.page_count;
      pdfCounts.extracted += row.extracted_page_count;
    }
    const walPath = `${this.dbPath}-wal`;
    const mainSize = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    return {
      vaultPath: this.vaultRoot,
      dbPath: this.dbPath,
      totalDocuments: count("SELECT count(*) AS cnt FROM documents"),
      totalChunks: count("SELECT count(*) AS cnt FROM chunks_fts"),
      totalTwinPdfs: count("SELECT count(DISTINCT original_pdf) AS cnt FROM documents WHERE original_pdf IS NOT NULL"),
      totalVectors: count("SELECT count(*) AS cnt FROM chunk_vectors"),
      incompleteDocuments: count("SELECT count(*) AS cnt FROM documents WHERE index_version <> ? OR vectors_complete = 0", INDEX_VERSION),
      dbSizeKb: Math.round((mainSize + walSize) / 1024),
      totalPdfDocuments: count("SELECT count(*) AS cnt FROM documents WHERE source_type IN ('pdf','pdf-native','pdf-import')"),
      pdfReady: pdfCounts.ready,
      pdfPending: pdfCounts.pending,
      pdfExtracting: pdfCounts.extracting,
      pdfEmpty: pdfCounts.empty,
      pdfFailed: pdfCounts.failed,
      pdfStale: pdfCounts.stale,
      pdfPages: pdfCounts.pages,
      pdfCoverage: pdfCounts.pages > 0 ? pdfCounts.extracted / pdfCounts.pages : 0,
    };
  }

  public close() {
    this.db.close();
  }
}
