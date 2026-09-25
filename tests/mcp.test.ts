import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = fileURLToPath(new URL("..", import.meta.url));
const extractText = (result: any): string => result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
async function until(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 8000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${label}`);
}

test("MCP handshake, bounded reads, keyword mode and actual watcher lifecycle", { timeout: 30_000 }, async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-protocol-"));
  const vault = path.join(scratch, "vault");
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(scratch, "outside.txt"), "OUTSIDE_CANARY");
  fs.writeFileSync(path.join(vault, "note.md"), "# 学习\n液压系统采用自适应控制。\nthird line");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/index.ts", "--path", vault],
    cwd: project,
    env: { ...process.env, VAULT_EMBEDDINGS: "off", VAULT_OFFLINE: "1" } as Record<string, string>,
    stderr: "pipe",
  });
  let logs = "";
  transport.stderr?.on("data", value => { logs += value.toString(); });
  const client = new Client({ name: "regression-client", version: "1" });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  const stats = async () => JSON.parse(extractText(await call("get_vault_stats")));
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(),
      ["get_vault_stats", "ping_vault", "read_vault_file", "search_vault"]);
    assert.match(extractText(await call("ping_vault")), /0\.5\.0/);
    await until(async () => (await stats()).indexing.state === "ready", "initial indexing");
    assert.equal((await stats()).embedding.state, "disabled");
    const result = extractText(await call("search_vault", { query: "自适应控制" }));
    assert.match(result, /note\.md/);
    assert.match(result, /仅使用关键词/);
    assert.match(result, /不是相关概率/);
    assert.doesNotMatch(result, /高相关|精准.*命中|语义理解命中/);
    assert.equal(extractText(await call("read_vault_file", { relative_path: "note.md", start_line: 3, end_line: 3 })), "third line");
    for (const relative_path of ["../outside.txt", "..\\outside.txt", path.join(scratch, "outside.txt")]) {
      const blocked = await call("read_vault_file", { relative_path });
      assert.equal(blocked.isError, true);
      assert.doesNotMatch(extractText(blocked), /OUTSIDE_CANARY/);
    }
    assert.equal((await call("read_vault_file", { relative_path: "note.md", start_line: 3, end_line: 1 })).isError, true);
    for (const args of [{ query: " " }, { query: "test", limit: -1 }, { query: "test", limit: 1.2 }]) {
      assert.equal((await call("search_vault", args)).isError, true);
    }
    const file = path.join(vault, "dynamic.md");
    fs.writeFileSync(file, "# uniqueaddtoken\n首次内容");
    await until(async () => (await stats()).totalDocuments === 2, "watcher add");
    fs.writeFileSync(file, "# uniquechangetoken\n第二次内容");
    await until(async () => extractText(await call("search_vault", { query: "uniquechangetoken" })).includes("dynamic.md"), "watcher change");
    // PDF association should also update without editing the Markdown.
    fs.writeFileSync(path.join(vault, "dynamic.pdf"), "%PDF fixture for path binding only");
    await until(async () => (await stats()).totalTwinPdfs === 1, "PDF association add");
    fs.unlinkSync(path.join(vault, "dynamic.pdf"));
    await until(async () => (await stats()).totalTwinPdfs === 0, "PDF association removal");
    fs.unlinkSync(file);
    await until(async () => (await stats()).totalDocuments === 1, "watcher deletion");
    assert.doesNotMatch(extractText(await call("search_vault", { query: "uniquechangetoken" })), /dynamic\.md/);
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    await client.close();
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
