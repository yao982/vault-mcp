import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { VaultIndexer } from "../../src/indexer.js";
import { VaultDatabase } from "../../src/storage/db.js";
import { EmbeddingService } from "../../src/storage/embedding.js";

interface RetrievalFixture {
  documents: Array<{ path: string; content: string }>;
  positiveQueries: Array<{ question: string; expectedPath: string }>;
  minimumRecallAt3: number;
  noAnswerQueries: string[];
}

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const sampleVault = path.join(projectRoot, "sample_vault");
const fixturePath = path.join(projectRoot, "tests", "fixtures", "retrieval.json");

function copySampleFiles(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || path.extname(entry.name).toLowerCase() === ".pdf") continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copySampleFiles(sourcePath, destinationPath);
    else if (entry.isFile()) copyFileSync(sourcePath, destinationPath);
  }
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test("offline cached BGE model retrieves sample and synthetic knowledge", { timeout: 30_000 }, async () => {
  const previousOffline = process.env.VAULT_OFFLINE;
  process.env.VAULT_OFFLINE = "1";

  let temporaryRoot: string | undefined;
  let database: VaultDatabase | undefined;
  try {
    if (process.env.VAULT_EMBEDDINGS?.trim().toLowerCase() === "off") {
      throw new Error("Retrieval integration requires embeddings enabled; VAULT_EMBEDDINGS is currently off.");
    }

    // Use a fresh service instance so the integration exercises the real
    // production loader and local cache rather than a shared singleton.
    const embeddingService = new EmbeddingService();
    try {
      await embeddingService.init();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Offline retrieval integration could not load cached Xenova/bge-small-zh-v1.5; ` +
        `downloads are disabled (VAULT_OFFLINE=1). Cache/model load error: ${reason}`,
        { cause: error }
      );
    }
    assert.equal(embeddingService.getStatus().state, "ready");

    const unitVector = await embeddingService.getEmbedding("液压伺服系统的位置跟踪误差用于控制阀芯开口。");
    assert.equal(unitVector.length, 512, "BGE small zh v1.5 should produce 512-dimensional vectors");
    const unitNorm = Math.sqrt(unitVector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(unitNorm - 1) < 1e-4, `expected a normalized vector, got norm ${unitNorm}`);

    const sharedPrefix = "Hydraulic valve controller tracks pressure and piston position. ".repeat(12).slice(0, 512);
    const tailA = `${sharedPrefix} Tail A: positive valve motion increases cylinder pressure.`;
    const tailB = `${sharedPrefix} Tail B: leakage compensation reduces a steady pressure offset.`;
    assert.equal(tailA.slice(0, 512), tailB.slice(0, 512), "the pair must share exactly the first 512 characters");
    const tailVectorA = await embeddingService.getEmbedding(tailA);
    const tailVectorB = await embeddingService.getEmbedding(tailB);
    const maximumDifference = Math.max(...tailVectorA.map((value, index) => Math.abs(value - tailVectorB[index])));
    assert.ok(maximumDifference > 1e-7, `different text after character 512 should change the vector; max delta=${maximumDifference}`);

    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as RetrievalFixture;
    assert.ok(fixture.positiveQueries.length >= 12 && fixture.positiveQueries.length <= 24);
    assert.ok(existsSync(sampleVault), `sample vault is missing: ${sampleVault}`);

    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "vault-mcp-retrieval-"));
    const vaultRoot = path.join(temporaryRoot, "vault");
    copySampleFiles(sampleVault, vaultRoot);
    for (const document of fixture.documents) {
      const targetPath = path.resolve(vaultRoot, document.path);
      assert.ok(targetPath.startsWith(`${vaultRoot}${path.sep}`), `fixture path escapes temporary vault: ${document.path}`);
      mkdirSync(path.dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, document.content, "utf8");
    }

    database = new VaultDatabase(vaultRoot);
    database.setEmbeddingProfile("bge-small-zh");
    const indexer = new VaultIndexer(vaultRoot, database, embeddingService);
    const indexStatus = await indexer.indexAll();
    assert.equal(indexStatus.failedFiles, 0, `indexing failed: ${indexStatus.lastError ?? "unknown error"}`);
    assert.equal(indexStatus.state, "ready");
    assert.ok(database.getStats().totalVectors > 0, "the real model should have produced stored vectors");

    const positiveResults: Array<{ question: string; expectedPath: string; hit: boolean; paths: string[] }> = [];
    for (const item of fixture.positiveQueries) {
      const queryEmbedding = await embeddingService.getEmbedding(item.question);
      const candidates = database.searchHybrid(item.question, queryEmbedding, 3);
      positiveResults.push({
        question: item.question,
        expectedPath: item.expectedPath,
        hit: candidates.some((candidate) => candidate.relativePath === item.expectedPath),
        paths: [...new Set(candidates.map((candidate) => candidate.relativePath))]
      });
    }

    const hits = positiveResults.filter((result) => result.hit).length;
    const recallAt3 = hits / positiveResults.length;
    console.log(`Retrieval Recall@3: ${hits}/${positiveResults.length} = ${recallAt3.toFixed(3)}`);
    for (const result of positiveResults) {
      console.log(
        `[${result.hit ? "HIT" : "MISS"}] ${result.question} -> ${result.paths.join(", ") || "no candidates"}`
      );
    }
    const misses = positiveResults.filter((result) => !result.hit);
    assert.ok(
      recallAt3 >= fixture.minimumRecallAt3,
      `Recall@3 ${recallAt3.toFixed(3)} is below ${fixture.minimumRecallAt3}; misses: ` +
      misses.map((miss) => `${miss.question} (expected ${miss.expectedPath})`).join("; ")
    );

    console.log("No-answer queries below show retrieval candidates only; candidates are not answers:");
    for (const question of fixture.noAnswerQueries) {
      const queryEmbedding = await embeddingService.getEmbedding(question);
      const candidates = database.searchHybrid(question, queryEmbedding, 3);
      console.log(`[NO ANSWER IN FIXTURE] ${question} -> ${candidates.map((candidate) => candidate.relativePath).join(", ") || "no candidates"}`);
      assert.ok(candidates.every((candidate) => typeof candidate.content === "string"));
    }
  } finally {
    database?.close();
    restoreEnvironment("VAULT_OFFLINE", previousOffline);
    if (temporaryRoot) {
      assert.equal(path.dirname(path.resolve(temporaryRoot)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith("vault-mcp-retrieval-"));
      rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});
