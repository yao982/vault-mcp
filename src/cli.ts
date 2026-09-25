import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SERVER_VERSION } from "./config.js";

const HELP = `Vault-MCP ${SERVER_VERSION} — 本地科研证据检索 / local research retrieval

vault-mcp <command> --path <vault> [options]
  serve   启动 MCP stdio 服务（省略命令时默认执行）
  index   建立/更新索引；--profile 切换模型并重建向量
  search  <query> [--mode hybrid|bm25|vector] [--limit 5]
  read    <relative-file> [--start-page N --end-page N | --start-line N --end-line N]
  status  只读查看索引和模型配置
  doctor  环境、权限、缓存、索引和锁诊断 [--recover-lock]
  import  --pdf papers/a.pdf --markdown converted/a.md [--page-map pages.json]

通用: --json（serve 除外）, --offline, --no-embeddings, --help, --version
模型: --profile multilingual-e5-small（新库默认）|bge-small-zh（旧库保留）
PDF 页码是从 1 开始的物理页；扫描件请先外部 OCR 再显式 import。
示例: vault-mcp index --path ./sample_vault --no-embeddings
      vault-mcp search "自适应控制" --path ./sample_vault --json
`;

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    path: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
    offline: { type: "boolean" }, "no-embeddings": { type: "boolean" }, profile: { type: "string" },
    mode: { type: "string" }, limit: { type: "string" }, query: { type: "string" }, file: { type: "string" },
    "start-line": { type: "string" }, "end-line": { type: "string" }, "start-page": { type: "string" }, "end-page": { type: "string" },
    "recover-lock": { type: "boolean" }, pdf: { type: "string" }, markdown: { type: "string" }, "page-map": { type: "string" },
  } });
  if (v.help) { console.log(HELP); return; }
  if (v.version) { console.log(SERVER_VERSION); return; }
  const command = positionals.shift() ?? "serve";
  if (!["serve", "index", "search", "read", "status", "doctor", "import"].includes(command)) throw new Error(`未知命令 ${command}。运行 --help 查看用法。`);
  if (v.json && command === "serve") throw new Error("serve 的标准输出只用于 MCP 协议；请移除 --json。");
  if (v["recover-lock"] && command !== "doctor") throw new Error("--recover-lock 只能与 doctor 一起使用。");
  if (v.profile && !["serve", "index", "import"].includes(command)) throw new Error("请使用 index --profile 切换模型。");
  if (v.profile && !["bge-small-zh", "multilingual-e5-small"].includes(v.profile)) throw new Error("未知模型配置；支持 bge-small-zh、multilingual-e5-small。");
  if (v.offline) process.env.VAULT_OFFLINE = "1";
  if (v["no-embeddings"]) process.env.VAULT_EMBEDDINGS = "off";
  const root = path.resolve(v.path ?? "sample_vault");
  const { VaultApp, formatSearch, diagnose, sourceHash } = await import("./app.js");
  const output = (value: unknown) => console.log(typeof value === "string" && !v.json ? value : JSON.stringify(value, null, 2));
  if (command === "doctor") {
    const result = await diagnose(root, v["recover-lock"]);
    output(v.json ? result : result.checks.map(c => `${c.ok ? "OK" : "检查"} ${c.name}: ${typeof c.detail === "string" ? c.detail : JSON.stringify(c.detail)}${!c.ok && c.fix ? `\n  修复: ${c.fix}` : ""}`).join("\n"));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  const app = new VaultApp(root, { writable: ["serve", "index", "import"].includes(command), profile: v.profile as "bge-small-zh" | "multilingual-e5-small" | undefined });
  if (command === "serve") { const { serve } = await import("./server.js"); await serve(app); return; }
  try {
    switch (command) {
      case "status": output(app.stats()); break;
      case "index": {
        const indexing = await app.indexer!.indexAll();
        output(app.stats());
        if (indexing.failedFiles) process.exitCode = 2;
        break;
      }
      case "search": {
        const result = await app.search(v.query ?? positionals.join(" "), positiveInt(v.limit, "limit") ?? 5, (v.mode ?? "hybrid") as "hybrid");
        output(v.json ? result : formatSearch(result));
        break;
      }
      case "read": {
        const file = v.file ?? positionals[0];
        if (!file) throw new Error("read 需要知识库内的相对文件路径。");
        const result = app.read(file, { startLine: positiveInt(v["start-line"], "start-line"), endLine: positiveInt(v["end-line"], "end-line"),
          startPage: positiveInt(v["start-page"], "start-page"), endPage: positiveInt(v["end-page"], "end-page") });
        output(v.json ? result : result.text);
        break;
      }
      case "import": {
        if (!v.pdf || !v.markdown) throw new Error("import 需要 --pdf 和 --markdown，均为知识库内相对路径。");
        const { loadImportManifest, validateImportManifest } = await import("./parser/imports.js");
        const { resolveVaultPath } = await import("./vaultPaths.js");
        const pdf = v.pdf.replace(/\\/g, "/"), markdown = v.markdown.replace(/\\/g, "/");
        const pages = v["page-map"] ? JSON.parse(fs.readFileSync(v["page-map"], "utf8")) : undefined;
        const entry = { pdf, markdown, sourceHash: sourceHash(fs.readFileSync(resolveVaultPath(root, pdf))), ...(pages ? { pages } : {}) };
        const manifest = loadImportManifest(app.root);
        const updated = { version: 1, documents: [...manifest.documents.filter(item => item.pdf !== pdf), entry] };
        validateImportManifest(app.root, updated);
        const filename = path.join(app.root, "vault.imports.json");
        if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error("转换清单不能是符号链接。");
        const temporary = path.join(app.root, `.vault-import-${randomUUID()}.tmp`);
        try { fs.writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: "wx" }); fs.renameSync(temporary, filename); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        const indexing = await app.indexer!.indexAll();
        output({ imported: entry, ...app.stats() });
        if (indexing.failedFiles) process.exitCode = 2;
        break;
      }
    }
  } finally { await app.close(); }
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} 必须为正整数。`);
  return Number(value);
}
