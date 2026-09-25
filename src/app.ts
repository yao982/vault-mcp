import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VaultDatabase, type SearchResult } from "./storage/db.js";
import { EmbeddingService } from "./storage/embedding.js";
import { type EmbeddingProfileName, inspectEmbeddingCache } from "./storage/profiles.js";
import { VaultIndexer } from "./indexer.js";
import { acquireVaultLock, inspectVaultLock, recoverVaultLock } from "./runtime/lock.js";
import { readVaultFile, resolveVaultPath } from "./vaultPaths.js";
import { INDEX_VERSION, SERVER_VERSION } from "./config.js";

export type SearchMode = "bm25" | "vector" | "hybrid";
export interface SearchResponse {
  query: string; requestedMode: SearchMode; mode: SearchMode;
  results: SearchResult[]; notices: string[];
}
export interface ReadOptions { startLine?: number; endLine?: number; startPage?: number; endPage?: number }
export const sourceHash = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** All mutations enter through this boundary before SQLite can migrate. */
export class VaultApp {
  readonly db!: VaultDatabase;
  readonly embedding: EmbeddingService;
  readonly indexer?: VaultIndexer;
  private lock?: ReturnType<typeof acquireVaultLock>;
  private closed = false;

  constructor(readonly root: string, options: { writable?: boolean; profile?: EmbeddingProfileName } = {}) {
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory()) throw new Error("知识库路径必须是目录。");
    if (options.profile && !options.writable) throw new Error("切换模型需要先运行 index --profile；只读命令不会改变索引。");
    if (options.writable) this.lock = acquireVaultLock(this.root);
    try {
      this.db = new VaultDatabase(this.root, { readonly: !options.writable });
      if (options.profile) this.db.setEmbeddingProfile(options.profile);
      this.embedding = new EmbeddingService({ profile: this.db.getEmbeddingProfile() });
      if (options.writable) this.indexer = new VaultIndexer(this.root, this.db, this.embedding);
    } catch (error) {
      this.db!?.close();
      this.lock?.release();
      throw error;
    }
  }

  stats() {
    return { ...this.db.getStats(), version: SERVER_VERSION, indexVersion: INDEX_VERSION,
      indexing: this.indexer?.getStatus() ?? { state: "read-only" }, embedding: this.embedding.getStatus() };
  }

  async search(query: string, limit = 5, requestedMode: SearchMode = "hybrid"): Promise<SearchResponse> {
    query = query.trim();
    if (!query || query.length > 4000) throw new Error("查询长度必须为 1–4000 字符。");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("limit 必须是 1–50 的整数。");
    if (!["bm25", "vector", "hybrid"].includes(requestedMode)) throw new Error("mode 必须为 bm25、vector 或 hybrid。");
    const notices: string[] = [];
    const state = this.indexer?.getStatus();
    if (state && (state.state !== "ready" || state.pendingFiles)) notices.push("索引尚未完全就绪，候选可能不完整或仍在更新。");
    let vector: Float32Array | null = null;
    if (requestedMode !== "bm25" && this.embedding.getStatus().state !== "disabled") {
      try { vector = await this.embedding.getEmbedding(query, "query"); }
      catch (error) { notices.push(`模型不可用：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!vector && requestedMode !== "bm25") notices.push("本次仅使用关键词检索；模型未就绪、已禁用或暂不可用。");
    if (vector && this.db.getStats().totalVectors < this.db.getStats().totalChunks) notices.push("部分切片尚无向量，语义候选覆盖不完整。");
    let mode: SearchMode = vector ? requestedMode : "bm25";
    let results: SearchResult[];
    try {
      results = mode === "bm25" ? this.db.searchBM25(query, limit)
        : mode === "vector" ? this.db.searchVector(vector!, limit) : this.db.searchHybrid(query, vector, limit);
    } catch (error) {
      if (mode === "bm25") throw error;
      notices.push(`向量索引异常，已降级为关键词候选：${error instanceof Error ? error.message : String(error)}`);
      mode = "bm25";
      results = this.db.searchBM25(query, limit);
    }
    const currentVersions = new Map<string, string | null>();
    results = results.map(result => {
      const original = result.sourceType.startsWith("pdf") ? result.originalPdf ?? result.relativePath : result.relativePath;
      if (!currentVersions.has(original)) {
        try { currentVersions.set(original, sourceHash(fs.readFileSync(resolveVaultPath(this.root, original)))); }
        catch { currentVersions.set(original, null); }
      }
      const current = currentVersions.get(original);
      return { ...result, stale: result.stale || current === null || current !== result.sourceVersion };
    });
    return { query, requestedMode, mode, results, notices };
  }

  read(relativePath: string, options: ReadOptions = {}) {
    const { startLine, endLine, startPage, endPage } = options;
    const hasLines = startLine !== undefined || endLine !== undefined;
    const hasPages = startPage !== undefined || endPage !== undefined;
    if (hasLines && hasPages) throw new Error("禁止混用行范围与页范围。");
    for (const n of Object.values(options)) if (n !== undefined && (!Number.isSafeInteger(n) || n < 1)) throw new Error("页码和行号必须是正整数。");
    if (startPage !== undefined && endPage !== undefined && endPage < startPage) throw new Error("结束页不能小于起始页。");
    const filename = resolveVaultPath(this.root, relativePath);
    if (!fs.statSync(filename).isFile()) throw new Error("指定路径不是普通文件。");
    relativePath = path.relative(this.root, filename).replace(/\\/g, "/");
    const currentHash = sourceHash(fs.readFileSync(filename));
    if (path.extname(filename).toLowerCase() !== ".pdf") {
      if (hasPages) throw new Error("文本和代码使用行范围；页范围只适用于 PDF。");
      return { relativePath, sourceType: "text", sourceVersion: currentHash, stale: false,
        startLine: startLine ?? 1, endLine: endLine ?? null, text: readVaultFile(this.root, relativePath, startLine, endLine) };
    }
    if (hasLines) throw new Error("PDF 使用物理页范围，请指定 start_page/end_page 或 --start-page/--end-page。");
    const state = this.db.getPdfState(relativePath);
    if (!state) throw new Error("PDF 尚未提取。请运行 vault-mcp index --path <知识库>，或等待后台提取完成。");
    const pages = this.db.getPdfPages(relativePath);
    if (!pages.length && ["pending", "extracting", "failed"].includes(state.status)) {
      throw new Error(`PDF 提取状态：${state.status}；${state.error ?? "请等待后台提取，或运行 index。"}`);
    }
    if (hasPages && pages.length > 0 && !pages.some(page => page.page !== null)) throw new Error("此转换文本没有可靠页映射，页码未知；请读取全文或显式导入页映射。");
    const selected = pages.filter(page => page.page === null ? !hasPages : (page.page >= (startPage ?? 1) && page.page <= (endPage ?? Infinity)));
    if (hasPages && selected.length === 0) throw new Error("请求的页范围不存在或尚无可读的提取结果；请检查 PDF 页数和提取状态。");
    const cachedVersion = this.db.getDocumentSourceState(relativePath)?.sourceVersion ?? state.sourceHash;
    const stale = state.stale || currentHash !== cachedVersion;
    const text = selected.map(page => `--- ${page.page === null ? "页码未知" : `第 ${page.page} 页（物理页）`} ---\n${page.text || "[本页无可用文字]"}`).join("\n\n");
    return { relativePath, sourceType: "pdf", sourceVersion: cachedVersion, currentSourceVersion: currentHash,
      stale, extraction: state, pages: selected, text: `${stale ? "[过期提取结果：请重新索引并核对当前原文]\n" : ""}${text || "没有可用文字；扫描件需要外部 OCR 后显式导入。"}` };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try { await this.indexer?.drain(); await this.embedding.dispose(); }
    finally { try { this.db.close(); } finally { this.lock?.release(); } }
  }
}

export function formatSearch(response: SearchResponse): string {
  return [...response.notices, `返回 ${response.results.length} 条检索候选。排序分不是相关概率；请核对原文，候选不保证能够回答问题。`,
    ...(response.results.length > 0 && response.results.every(r => r.matchType === "vector") ? ["仅有向量候选，尚无关键词证据；资料库可能没有答案。"] : []),
    ...response.results.map((r, i) => {
      const location = r.sourceType.startsWith("pdf")
        ? (r.pageStart ? `第 ${r.pageStart}${r.pageEnd !== r.pageStart ? `–${r.pageEnd}` : ""} 页（物理页）` : "页码未知")
        : `L${r.startLine}–L${r.endLine}`;
      return `\n### 候选 ${i + 1} | ${r.relativePath} | ${location}${r.stale ? " | 已过期" : ""}\n引用: ${r.citationId}\n来源版本: ${r.sourceVersion}\n排序分: ${r.score.toFixed(6)} (${r.matchType ?? response.mode})\n${r.content}`;
    }), response.results.length ? "" : "未找到候选；这不证明资料库中一定没有答案。"].filter(Boolean).join("\n");
}

export async function diagnose(root: string, recover = false) {
  const checks: Array<{ name: string; ok: boolean; detail: unknown; fix?: string }> = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "node", ok: major === 22 && minor >= 14 || major === 24, detail: process.version, fix: "安装受支持的 Node.js 22.14+ 或 24 LTS。" });
  let readable = false;
  try { fs.accessSync(root, fs.constants.R_OK); readable = fs.statSync(root).isDirectory(); } catch {}
  checks.push({ name: "directory", ok: readable, detail: root, fix: "确认 --path 指向已存在、当前用户可读取的资料目录。" });
  if (readable) {
    let writable = true;
    try { fs.accessSync(root, fs.constants.W_OK); } catch { writable = false; }
    checks.push({ name: "write-permission", ok: writable, detail: writable, fix: "索引需要目录写权限；status/read/search 可以只读运行。" });
    const lock = recover ? recoverVaultLock(root) : inspectVaultLock(root);
    checks.push({ name: "writer-lock", ok: ["unlocked", "recovered", "active"].includes(lock.state), detail: lock,
      fix: "活动实例请先正常停止；仅确认进程已退出后运行 doctor --recover-lock。同库只能有一个写入服务。" });
    let app: VaultApp | undefined;
    try {
      app = new VaultApp(root);
      checks.push({ name: "index", ok: true, detail: app.stats() });
      const embeddingsDisabled = process.env.VAULT_EMBEDDINGS === "off";
      const cache = embeddingsDisabled
        ? { available: true, required: false, disabled: true }
        : { ...inspectEmbeddingCache(app.db.getEmbeddingProfile()), required: true, disabled: false };
      checks.push({ name: "model-cache", ok: cache.available, detail: cache,
        fix: "首次联网运行 index 下载模型；缓存完成后使用 --offline。仅关键词模式使用 --no-embeddings。" });
    } catch (error) {
      checks.push({ name: "index", ok: false, detail: error instanceof Error ? error.message : String(error),
        fix: "先停止旧版服务，再运行 vault-mcp index --path <目录> 创建或升级索引。原始资料不会改动。" });
    } finally { await app?.close(); }
  }
  return { version: SERVER_VERSION, ok: checks.every(check => check.ok), checks };
}
