import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VaultApp, formatSearch } from "./app.js";
import { VaultFileWatcher } from "./watcher/fileWatcher.js";
import { SERVER_VERSION } from "./config.js";

export async function serve(app: VaultApp): Promise<void> {
  if (!app.indexer) throw new Error("MCP 服务需要知识库写锁。");
  const server = new McpServer({ name: "vault-mcp", version: SERVER_VERSION });
  const watcher = new VaultFileWatcher(app.root, app.indexer);
  server.tool("ping_vault", "测试连接；连接成功不表示索引已经完成", { message: z.string().optional() }, async ({ message }) => ({
    content: [{ type: "text", text: `Vault-MCP ${SERVER_VERSION} 连接成功${message ? `，收到：${message}` : ""}。索引状态: ${app.indexer!.getStatus().state}；向量状态: ${app.embedding.getStatus().state}。连接成功不代表索引已经完成。` }],
  }));
  server.tool("get_vault_stats", "文档、PDF 提取进度、错误和当前模型配置", {}, async () => {
    const stats = app.stats();
    return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }], structuredContent: stats };
  });
  server.tool("search_vault", "检索本地论文、笔记和代码，返回可核对的候选证据和页码/行号", {
    query: z.string().trim().min(1).max(4000), limit: z.number().int().min(1).max(50).optional().default(5),
    mode: z.enum(["bm25", "vector", "hybrid"]).optional().default("hybrid"),
  }, async ({ query, limit, mode }) => {
    const response = await app.search(query, limit, mode);
    return { content: [{ type: "text", text: formatSearch(response) }], structuredContent: { ...response } };
  });
  server.tool("read_vault_file", "读取文本行范围或 PDF 物理页范围；页码从 1 开始，禁止混用页/行", {
    relative_path: z.string().min(1).max(4096),
    start_line: z.number().int().positive().optional(), end_line: z.number().int().positive().optional(),
    start_page: z.number().int().positive().optional(), end_page: z.number().int().positive().optional(),
  }, async ({ relative_path, start_line, end_line, start_page, end_page }) => {
    try {
      const result = app.read(relative_path, { startLine: start_line, endLine: end_line, startPage: start_page, endPage: end_page });
      return { content: [{ type: "text", text: result.text }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
  });
  let stopping = false;
  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(code || 1), 10_000);
    deadline.unref();
    try { await watcher.close(); await app.close(); await server.close(); }
    finally { process.exit(code); }
  }
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.stdin.once("end", () => void shutdown());
  try {
    await server.connect(new StdioServerTransport());
    console.error(`[Vault-MCP ${SERVER_VERSION}] ${app.root}；后台准备索引。`);
    await watcher.start();
    void app.indexer.indexAll().then(status => console.error("[初始索引]", JSON.stringify(status))).catch(error => console.error(error));
  } catch (error) { console.error(error); await shutdown(1); }
}
