import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "path";
import fs from "fs";
import { VaultDatabase } from "./storage/db.js";
import { VaultIndexer } from "./indexer.js";
import { EmbeddingService } from "./storage/embedding.js";
import { VaultFileWatcher } from "./watcher/fileWatcher.js";

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
const watcher = new VaultFileWatcher(vaultRoot, indexer, db);

// 3. 注册 MCP Server 与工具接口
const server = new McpServer({
  name: "vault-mcp",
  version: "0.1.0"
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
          text: `🎉 恭喜！Vault-MCP 本地知识库连接成功${greeting}！已启用：SQLite FTS5 + 向量混合检索 + 实时增量监听。`
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
    const stats = db.getStats();
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

// Tool 3: search_vault (工业级 RRF 混合检索：BM25 + 向量语义)
server.tool(
  "search_vault",
  "在本地知识库中基于【BM25关键词 + 纯本地向量语义】混合检索学术论文、笔记与代码",
  {
    query: z.string().describe("检索问题或关键词，支持自然语言提问（如'怎么释放内存'）或专有名词（如'Scaled Dot-Product'）"),
    limit: z.number().optional().default(5).describe("返回最相关的结果片段数量，默认 5 条")
  },
  async ({ query, limit }) => {
    let queryEmbedding: Float32Array | null = null;
    try {
      queryEmbedding = await embeddingService.getEmbedding(query);
    } catch (err) {
      console.error("生成查询向量失败，自动降级为纯 BM25 检索:", err);
    }

    const results = db.searchHybrid(query, queryEmbedding, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `未在本地知识库中检索到与 "${query}" 相关的切片内容。`
          }
        ]
      };
    }

    const typeLabels = {
      hybrid: "🔥【精准+语义双重命中】",
      bm25: "🎯【关键词命中】",
      vector: "🧠【语义理解命中】"
    };

    const formatted = results.map((r, index) => {
      const tag = typeLabels[r.matchType || "bm25"];
      let header = `### 【结果 ${index + 1}】 ${tag} 综合分: ${r.score} | 来源: ${r.relativePath} (L${r.startLine}-L${r.endLine})`;
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
          text: `共检索到 ${results.length} 条高相关片段（基于 BM25 + 本地向量混合排序）：\n\n` + formatted.join("\n\n")
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
    relative_path: z.string().describe("文件的相对路径，例如 'papers/attention.md'"),
    start_line: z.number().optional().describe("起始行号 (1-based)"),
    end_line: z.number().optional().describe("结束行号")
  },
  async ({ relative_path, start_line, end_line }) => {
    const fullPath = path.join(vaultRoot, relative_path);
    if (!fs.existsSync(fullPath)) {
      return {
        content: [
          {
            type: "text",
            text: `文件不存在: ${relative_path}`
          }
        ]
      };
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split(/\r?\n/);
    const start = start_line ? Math.max(1, start_line) - 1 : 0;
    const end = end_line ? Math.min(lines.length, end_line) : lines.length;

    const slice = lines.slice(start, end).join("\n");
    return {
      content: [
        {
          type: "text",
          text: slice
        }
      ]
    };
  }
);

// 4. 启动服务与激活实时监听
async function main() {
  console.error(">>> [Vault-MCP] 正在扫描文件并计算本地语义向量...");
  const indexResult = await indexer.indexAll();
  console.error(`>>> [Vault-MCP] 初始索引就绪: 扫描 ${indexResult.indexedFiles} 个文件，生成 ${indexResult.totalChunks} 个文本切片与 ${indexResult.totalVectors} 条向量。`);

  // 启动文件系统增量热重载监听器
  watcher.start();

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(">>> [Vault-MCP] 服务已就绪，正在监听 stdio 指令...");
}

// 优雅停机
process.on("SIGINT", async () => {
  await watcher.close();
  db.close();
  process.exit(0);
});

main().catch((error) => {
  console.error(">>> [Vault-MCP] 启动出现致命错误:", error);
  process.exit(1);
});
