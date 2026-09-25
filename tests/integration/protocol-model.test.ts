import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const text = (r: any): string => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

test("built MCP server uses the cached model and labels unrelated results as candidates", { timeout: 30_000 }, async t => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-model-protocol-"));
  fs.cpSync(path.join(project, "sample_vault"), scratch, {
    recursive: true,
    filter: filename => !path.basename(filename).startsWith(".") && path.extname(filename).toLowerCase() !== ".pdf",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--path", scratch],
    cwd: project,
    env: { ...process.env, VAULT_OFFLINE: "1", VAULT_EMBEDDINGS: "on" } as Record<string, string>,
    stderr: "pipe",
  });
  let logs = "";
  transport.stderr?.on("data", d => { logs += d.toString(); });
  const client = new Client({ name: "cached-model-protocol", version: "1" });
  try {
    // Model changes use the explicit index command; serve honors the persisted profile.
    execFileSync(process.execPath, ["dist/index.js", "index", "--path", scratch,
      "--profile", "bge-small-zh", "--offline", "--no-embeddings"], { cwd: project, stdio: "pipe" });
    const before = performance.now();
    await client.connect(transport);
    t.diagnostic(`MCP handshake ${Math.round(performance.now() - before)} ms (local observation, not a latency guarantee)`);
    const stats = async () => JSON.parse(text(await client.callTool({ name: "get_vault_stats", arguments: {} })));
    const deadline = Date.now() + 20_000;
    let state = await stats();
    while (state.indexing.state !== "ready" || state.embedding.state !== "ready") {
      if (state.embedding.state === "unavailable") assert.fail(`Cached model unavailable: ${state.embedding.lastError}. Prepare cache before running integration tests.`);
      if (Date.now() > deadline) assert.fail(`Index did not become ready: ${JSON.stringify(state)}`);
      await new Promise(resolve => setTimeout(resolve, 50));
      state = await stats();
    }
    assert.ok(state.totalDocuments >= 3);
    assert.equal(state.totalVectors, state.totalChunks);
    assert.equal(state.incompleteDocuments, 0);
    const positive = text(await client.callTool({ name: "search_vault", arguments: { query: "如何销毁堆中空间", limit: 1 } }));
    assert.match(positive, /c_language_pointers\.md/);
    assert.match(positive, /free\(arr\)/);
    const negative = text(await client.callTool({ name: "search_vault", arguments: { query: "怎么做红烧肉", limit: 1 } }));
    assert.match(negative, /资料库可能没有答案/);
    assert.match(negative, /候选不保证能够回答问题/);
    assert.doesNotMatch(negative, /高相关|语义理解命中|精准.*命中/);
    const original = text(await client.callTool({ name: "read_vault_file", arguments: { relative_path: "notes/c_language_pointers.md" } }));
    assert.match(original, /free\(arr\)/);
  } catch (error) {
    console.error(logs);
    throw error;
  } finally {
    await client.close();
    assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
