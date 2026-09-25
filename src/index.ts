import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { VaultDatabase } from "./storage/db.js";
import { VaultIndexer } from "./indexer.js";
import { EmbeddingService } from "./storage/embedding.js";
import { VaultFileWatcher } from "./watcher/fileWatcher.js";
import { readVaultFile } from "./vaultPaths.js";
import { INDEX_VERSION, SERVER_VERSION } from "./config.js";

// 1. 获取知识库路径参数
function getVaultPath(): string {
  const args = process.argv.slice(2);
  const pathIndex = args.indexOf("--path");
  if (pathIndex !== -1 && args[pathIndex + 1]) {
    return path.resolve(args[pathIndex + 1]);
  }
  return path.resolve(process.cwd(), "sample_vault");
}

const vaultRoot = getVaultPath();
console.error(`>>> [Vault-MCP] 知识库根目录绑定为: ${vaultRoot}`);

if (!fs.existsSync(vaultRoot)) {
  fs.mkdirSync(vaultRoot, { recursive: true });
}

// 2. 初始化核心组件
const db = new VaultDatabase(vaultRoot);
const indexer = new VaultIndexer(vaultRoot, db);
const embeddingService = EmbeddingService.getInstance();
const watcher = new VaultFileWatcher(vaultRoot, indexer);

// 3. 注册 MCP Server 与工具接口
const server = new McpServer({
  name: "vault-mcp",
  version: SERVER_VERSION
});

// Tool 1: ping_vault
server.tool(
  "ping_vault",
  "测试 Vault-MCP 知识库服务器的连接状态",
  {
    message: z.string().optional().describe("发送给知识库的问候语或测试文字")
  },
  async ({ message }) => {
    const greeting = message ? `，收到你的测试消息: "${message}"` : "";
    return {
      content: [
        {
          type: "text",
          text: `Vault-MCP ${SERVER_VERSION} 连接成功${greeting}。索引状态: ${indexer.getStatus().state}；向量状态: ${embeddingService.getStatus().state}。连接成功不代表索引已经完成。`
        }
      ]
    };
  }
);

// Tool 2: get_vault_stats
server.tool(
  "get_vault_stats",
  "获取当前知识库的运行状态与详细统计数据（文档数、切片数、向量数、关联 PDF 数、数据库体积）",
  {},
  async () => {
    const stats = { ...db.getStats(), version: SERVER_VERSION, indexVersion: INDEX_VERSION,
      indexing: indexer.getStatus(), embedding: embeddingService.getStatus() };
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(stats, null, 2)
        }
      ]
    };
  }
);

// Tool 3: return retrieval candidates, never a claim of answer confidence.
server.tool(
  "search_vault",
  "在本地知识库中基于【BM25关键词 + 纯本地向量语义】混合检索学术论文、笔记与代码",
  {
    query: z.string().trim().min(1).max(4000).describe("检索问题或关键词"),
    limit: z.number().int().min(1).max(50).optional().default(5).describe("候选片段数量，1 到 50，默认 5")
  },
  async ({ query, limit }) => {
    let queryEmbedding: Float32Array | null = null;
    const notices: string[] = [];
    const status = indexer.getStatus();
    if (status.state !== "ready" || status.pendingFiles > 0) notices.push("索引尚未完全就绪，候选可能不完整或仍在更新。");
    const vectorState = embeddingService.getStatus().state;
    if (vectorState === "ready" || vectorState === "unavailable") {
      try { queryEmbedding = await embeddingService.getEmbedding(query); }
      catch (error) { console.error("查询向量不可用:", error); }
      if (vectorState === "unavailable" && queryEmbedding && db.getStats().incompleteDocuments > 0) {
        void indexer.indexAll();
        notices.push("模型已恢复，正在后台补齐缺失向量。");
      }
    } else if (vectorState === "idle") {
      void embeddingService.init().catch(error => console.error("向量初始化失败:", error));
    }
    if (!queryEmbedding) notices.push("本次仅使用关键词检索；模型未就绪、已禁用或暂不可用。");
    const coverage = db.getStats();
    if (coverage.totalVectors < coverage.totalChunks && queryEmbedding) notices.push("部分切片尚无向量，语义候选覆盖不完整。");
    let results;
    try { results = db.searchHybrid(query, queryEmbedding, limit); }
    catch (error) {
      console.error("向量索引异常，使用关键词候选:", error);
      results = db.searchBM25(query, limit);
      queryEmbedding = null;
      notices.push("向量索引异常，本次已降级为关键词检索，请查看服务日志。");
    }

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `${notices.join("\n")}\n未找到检索候选；这不证明资料库中一定没有答案。`.trim()
          }
        ]
      };
    }

    const typeLabels = {
      hybrid: "【关键词与向量候选】",
      bm25: "【关键词候选】",
      vector: "【仅向量候选】"
    };

    const formatted = results.map((r, index) => {
      const tag = typeLabels[r.matchType || "bm25"];
      let header = `### 【候选 ${index + 1}】 ${tag} 排序分: ${r.score.toFixed(6)} | 来源: ${r.relativePath} (L${r.startLine}-L${r.endLine})`;
      if (r.vectorScore !== undefined) header += `\n向量相似度: ${r.vectorScore.toFixed(4)}（不是正确率）`;
      if (r.headingPath && r.headingPath !== "Root") {
        header += `\n📌 章节大纲: ${r.headingPath}`;
      }
      if (r.originalPdf) {
        header += `\n📖 关联的原始论文 PDF: ${r.originalPdf}`;
      }
      return `${header}\n\n${r.content}\n---`;
    });

    return {
      content: [
        {
          type: "text",
          text: `${notices.join("\n")}\n返回 ${results.length} 条检索候选。排序分不是相关概率；候选不保证能够回答问题。请核对原文，缺乏依据时明确说明。${results.every(r => r.matchType === "vector") ? "\n仅有向量候选，尚无关键词证据；资料库可能没有答案。" : ""}\n\n` + formatted.join("\n\n")
        }
      ]
    };
  }
);

// Tool 4: read_vault_file
server.tool(
  "read_vault_file",
  "读取知识库中指定文件的完整内容或指定行范围",
  {
    relative_path: z.string().min(1).max(4096).describe("知识库内的文件相对路径"),
    start_line: z.number().int().positive().optional().describe("起始行号 (1-based)"),
    end_line: z.number().int().positive().optional().describe("结束行号")
  },
  async ({ relative_path, start_line, end_line }) => {
    try {
      return { content: [{ type: "text", text: readVaultFile(vaultRoot, relative_path, start_line, end_line) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  }
);

// 4. 启动服务与激活实时监听
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(">>> [Vault-MCP] MCP 已连接，索引将在后台准备。");
  await watcher.start();
  if (embeddingService.getStatus().state !== "disabled") {
    void embeddingService.init().catch(error => console.error("向量模型暂不可用，将保留关键词检索:", error));
  }
  void indexer.indexAll().then(status => console.error("[初始索引]", JSON.stringify(status)));
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(0), 5000);
  deadline.unref();
  await watcher.close();
  db.close();
  await server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("end", () => void shutdown());

main().catch((error) => {
  console.error(">>> [Vault-MCP] 启动出现致命错误:", error);
  process.exit(1);
});
