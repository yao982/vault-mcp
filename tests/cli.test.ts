import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { acquireVaultLock } from "../src/runtime/lock.js";
import { SERVER_VERSION } from "../src/config.js";
const project = fileURLToPath(new URL("..", import.meta.url));
function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    cwd: project, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, VAULT_OFFLINE: "1", VAULT_EMBEDDINGS: "off" },
  });
  if (r.error) throw r.error;
  return r;
}
test("CLI package entry help, JSON errors and version do not create a vault", () => {
  assert.equal(cli(["--version"]).stdout.trim(), SERVER_VERSION);
  assert.match(cli(["--help"]).stdout, /doctor/);
  const r = cli(["unknown", "--json"]);
  assert.equal(r.status, 1);
  assert.match(JSON.parse(r.stdout).error, /未知命令/);
});
test("CLI indexes text/PDF, reads citations, enforces lock and explicitly imports converted text", { timeout: 90_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-cli-"));
  try {
    fs.writeFileSync(path.join(root, "note.md"), "# 实验笔记\n中文科研控制记录\nlast line");
    const pdf = await PDFDocument.create();
    pdf.addPage().drawText("Research physics firstpage");
    pdf.addPage().drawText("Research evidence secondpage");
    fs.writeFileSync(path.join(root, "paper.pdf"), await pdf.save());
    const invoke = (args: string[]) => cli([...args, "--path", root, "--json"]);
    let r = invoke(["index"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const status = JSON.parse(r.stdout);
    assert.equal(status.embedding.profile, "multilingual-e5-small");
    assert.equal(status.totalDocuments, 2);
    assert.equal(status.pdfReady, 1);
    const lexicalDoctor = JSON.parse(invoke(["doctor", "--no-embeddings"]).stdout);
    assert.equal(lexicalDoctor.ok, true);
    const lexicalModelCheck = lexicalDoctor.checks.find((c: any) => c.name === "model-cache");
    assert.equal(lexicalModelCheck.ok, true);
    assert.equal(lexicalModelCheck.detail.required, false);
    assert.equal(lexicalModelCheck.detail.disabled, true);

    r = invoke(["import", "--pdf", "paper.pdf", "--profile", "bge-small-zh"]);
    assert.equal(r.status, 1, "import must reject --profile before opening the writer");
    assert.match(JSON.parse(r.stdout).error, /index --profile/);
    assert.equal(JSON.parse(invoke(["status"]).stdout).embedding.profile, "multilingual-e5-small",
      "invalid import must leave the persisted embedding profile unchanged");
    r = invoke(["search", "secondpage"]);
    const match = JSON.parse(r.stdout).results[0];
    assert.equal(match.pageStart, 2);
    assert.match(match.sourceVersion, /^[a-f0-9]{64}$/);
    assert.ok(match.citationId);
    r = invoke(["read", "paper.pdf", "--start-page", "2", "--end-page", "2"]);
    const page = JSON.parse(r.stdout);
    assert.match(page.text, /secondpage/);
    assert.doesNotMatch(page.text, /firstpage/);
    assert.equal(page.stale, false);
    assert.equal(invoke(["read", "paper.pdf", "--start-page", "1", "--start-line", "1"]).status, 1);
    assert.equal(invoke(["read", "paper.pdf", "--start-page", "99"]).status, 1);
    assert.equal(invoke(["read", "note.md", "--start-page", "1"]).status, 1);
    assert.equal(invoke(["search", "question", "--limit", "0"]).status, 1);
    const lock = acquireVaultLock(root);
    try {
      assert.equal(invoke(["status"]).status, 0, "status must work while another writer is active");
      const rejected = invoke(["index"]);
      assert.equal(rejected.status, 1);
      assert.match(rejected.stdout, /lock|占用|pid|PID/i);
      const doctor = JSON.parse(invoke(["doctor"]).stdout);
      assert.equal(doctor.checks.find((c: any) => c.name === "writer-lock").detail.state, "active");
    } finally { lock.release(); }
    fs.writeFileSync(path.join(root, "converted.md"), "# Converted body\nExplicitconversion proof\n");
    r = invoke(["import", "--pdf", "paper.pdf", "--markdown", "converted.md"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(JSON.parse(r.stdout).totalDocuments, 2, "converted body is indexed only once; personal note retained");
    const imported = JSON.parse(invoke(["search", "Explicitconversion"]).stdout).results[0];
    assert.equal(imported.pageStart, null);
    assert.equal(imported.originalPdf, "paper.pdf");
    assert.match(JSON.parse(invoke(["read", "paper.pdf"]).stdout).text, /页码未知/);
    assert.equal(invoke(["read", "paper.pdf", "--start-page", "1"]).status, 1);
    fs.writeFileSync(path.join(root, "map.json"), JSON.stringify([{ page: 2, startLine: 1, endLine: 2 }]));
    r = invoke(["import", "--pdf", "paper.pdf", "--markdown", "converted.md", "--page-map", path.join(root, "map.json")]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(JSON.parse(invoke(["read", "paper.pdf", "--start-page", "2", "--end-page", "2"]).stdout).text, /Explicitconversion/);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
