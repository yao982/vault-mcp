import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { VaultApp } from "../src/app.js";

test("multiple PDF hits share one source read, while later queries detect changed and missing originals", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vault-source-versions-")));
  const filename = path.join(root, "paper.pdf");
  const previous = process.env.VAULT_EMBEDDINGS;
  process.env.VAULT_EMBEDDINGS = "off";
  let app: VaultApp | undefined;
  try {
    const pdf = await PDFDocument.create();
    for (let page = 1; page <= 3; page++) pdf.addPage().drawText(`sourcecanary evidence on page ${page}`);
    fs.writeFileSync(filename, await pdf.save());
    app = new VaultApp(root, { writable: true });
    await app.indexer!.indexAll();
    const reads = t.mock.method(fs, "readFileSync");
    const result = await app.search("sourcecanary", 50, "bm25");
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every(hit => !hit.stale));
    assert.equal(reads.mock.calls.filter(call => call.arguments[0] === filename).length, 1);
    reads.mock.restore();

    fs.appendFileSync(filename, "\n% file changed since indexing\n");
    const changed = await app.search("sourcecanary", 50, "bm25");
    assert.ok(changed.results.every(hit => hit.stale));
    fs.unlinkSync(filename);
    const missing = await app.search("sourcecanary", 50, "bm25");
    assert.ok(missing.results.every(hit => hit.stale));
  } finally {
    t.mock.restoreAll();
    await app?.close();
    if (previous === undefined) delete process.env.VAULT_EMBEDDINGS;
    else process.env.VAULT_EMBEDDINGS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
