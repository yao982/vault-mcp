import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { VaultApp } from "../dist/app.js";
import { inspectEmbeddingCache } from "../dist/storage/profiles.js";

const PROFILE = "multilingual-e5-small";
const TARGET_COUNTS = [1_000, 10_000];
const QUERY_COUNT = 50;
const QUERY = "adaptive controller estimates hydraulic pressure from sensor observations and reduces tracking error while preserving stability";
const SYNTHETIC_NOTICE = "Synthetic numbered English research sentences measure throughput only; they are not retrieval-quality evidence.";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "benchmarks", "results", "performance.json");

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 0.50).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
  };
}

function nowMs() {
  return performance.now();
}

function roundedMs(start) {
  return Number((nowMs() - start).toFixed(3));
}

function makeSyntheticMarkdown(id) {
  const label = String(id).padStart(5, "0");
  return `# Synthetic experiment ${label}\n\nIn this synthetic adaptive control study, controller ${label} estimates hydraulic pressure from sensor observations and updates the valve command to reduce tracking error while preserving stability margins. The numbered sentence is generated only for throughput measurement.\n`;
}

function generateFiles(vaultRoot, startId, endId) {
  const started = nowMs();
  for (let id = startId; id < endId; id++) {
    const filename = path.join(vaultRoot, `study-${String(id).padStart(5, "0")}.md`);
    fs.writeFileSync(filename, makeSyntheticMarkdown(id), "utf8");
  }
  return roundedMs(started);
}

function vectorNorm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

async function sampleSearches(app, size) {
  const modes = ["bm25", "vector", "hybrid"];
  const fullSearch = {};
  const pureRetrieval = {};

  for (const mode of modes) {
    await app.search(QUERY, 5, mode); // warm caches and the query path
    const latencies = [];
    for (let index = 0; index < QUERY_COUNT; index++) {
      const started = nowMs();
      const response = await app.search(QUERY, 5, mode);
      latencies.push(roundedMs(started));
      assert.equal(response.mode, mode, `${mode} unexpectedly fell back during full-path measurement`);
    }
    fullSearch[mode] = summarize(latencies);
  }

  const queryVector = await app.embedding.getEmbedding(QUERY, "query");
  assert.equal(queryVector.length, 384);
  assert.ok(Math.abs(vectorNorm(queryVector) - 1) < 1e-4);
  const pureCalls = {
    bm25: () => app.db.searchBM25(QUERY, 5),
    vector: () => app.db.searchVector(queryVector, 5),
    hybrid: () => app.db.searchHybrid(QUERY, queryVector, 5),
  };
  for (const mode of modes) {
    pureCalls[mode]();
    const latencies = [];
    for (let index = 0; index < QUERY_COUNT; index++) {
      const started = nowMs();
      pureCalls[mode]();
      latencies.push(roundedMs(started));
    }
    pureRetrieval[mode] = summarize(latencies);
  }

  const embeddingLatencies = [];
  for (let index = 0; index < QUERY_COUNT; index++) {
    const started = nowMs();
    await app.embedding.getEmbedding(QUERY, "query");
    embeddingLatencies.push(roundedMs(started));
  }

  return { count: size, fullSearch, pureRetrieval, queryEmbeddingOnly: summarize(embeddingLatencies) };
}

function getCpuDescription() {
  const cpus = os.cpus();
  return {
    model: cpus[0]?.model ?? "unknown",
    logicalCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
}

function measureModelBytes(cacheDir, modelId) {
  const modelDir = path.join(cacheDir, ...modelId.split("/"));
  if (!fs.existsSync(modelDir)) return 0;
  let bytes = 0;
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) bytes += fs.statSync(filename).size;
    }
  };
  walk(modelDir);
  return bytes;
}

async function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-performance-"));
  const vaultRoot = path.join(tempRoot, "synthetic-vault");
  fs.mkdirSync(vaultRoot);
  let app;
  let peakRssBytes = process.memoryUsage().rss;
  const rssSampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 50);
  rssSampler.unref();

  try {
    const generation = [];
    generation.push({ through: 1_000, files: 1_000, durationMs: generateFiles(vaultRoot, 0, 1_000) });

    const cacheBefore = inspectEmbeddingCache(PROFILE);
    const modelCacheStarted = nowMs();
    app = new VaultApp(vaultRoot, { writable: true, profile: PROFILE });
    await app.embedding.init();
    const modelLoadMs = roundedMs(modelCacheStarted);
    const profile = app.embedding.getProfile();
    assert.equal(profile.name, PROFILE);
    assert.equal(profile.dimensions, 384);

    const indexing = [];
    let cumulativeIndexMs = 0;
    let previousVectorCount = 0;
    for (const target of TARGET_COUNTS) {
      if (target > 1_000) {
        const addedFiles = target - 1_000;
        generation.push({
          through: target,
          files: addedFiles,
          durationMs: generateFiles(vaultRoot, 1_000, target),
        });
      }

      const indexStarted = nowMs();
      const status = await app.indexer.indexAll();
      const indexMs = roundedMs(indexStarted);
      cumulativeIndexMs = Number((cumulativeIndexMs + indexMs).toFixed(3));
      const stats = app.db.getStats();
      const expected = { documents: target, chunks: target, vectors: target };
      assert.equal(stats.totalDocuments, expected.documents, `document count at ${target}`);
      assert.equal(stats.totalChunks, expected.chunks, `chunk count at ${target}; each generated file must produce one chunk`);
      assert.equal(stats.totalVectors, expected.vectors, `persisted real vector count at ${target}`);
      assert.equal(status.failedFiles, 0, `index failures at ${target}`);
      assert.equal(status.state, "ready", `index state at ${target}`);
      indexing.push({
        through: target,
        indexPassMs: indexMs,
        cumulativeIndexMs,
        updatedFiles: status.updatedFiles,
        skippedFiles: status.skippedFiles,
        failedFiles: status.failedFiles,
        persistedDocuments: stats.totalDocuments,
        persistedChunks: stats.totalChunks,
        persistedVectors: stats.totalVectors,
        vectorsWrittenThisPass: stats.totalVectors - previousVectorCount,
      });
      previousVectorCount = stats.totalVectors;
      generation[generation.length - 1].cumulativeMs = Number(
        generation.reduce((sum, item) => sum + item.durationMs, 0).toFixed(3),
      );

      indexing[indexing.length - 1].warmQueries = await sampleSearches(app, target);
    }

    const cacheAfter = inspectEmbeddingCache(PROFILE);
    assert.ok(cacheAfter.available, "E5 cache must be complete and persistent before benchmark results are written");
    const modelBytes = measureModelBytes(cacheAfter.cacheDir, profile.modelId);
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      purpose: "Synthetic throughput and latency benchmark; no retrieval-quality claim.",
      syntheticDataNotice: SYNTHETIC_NOTICE,
      profile: {
        name: profile.name,
        modelId: profile.modelId,
        dimensions: profile.dimensions,
        pooling: profile.pooling,
        queryPrefix: profile.queryPrefix,
        documentPrefix: profile.documentPrefix,
        fingerprint: profile.fingerprint,
        quantized: true,
      },
      environment: {
        operatingSystem: `${os.type()} ${os.release()} (${os.platform()} ${os.arch()})`,
        node: process.version,
        cpu: getCpuDescription(),
        peakRssSampledBytes: peakRssBytes,
        processResourceUsage: {
          maxRssKiB: process.resourceUsage().maxRSS,
          maxRssBytes: process.resourceUsage().maxRSS * 1024,
          userCpuTimeMicroseconds: process.resourceUsage().userCPUTime,
          systemCpuTimeMicroseconds: process.resourceUsage().systemCPUTime,
        },
        finalRssBytes: process.memoryUsage().rss,
        peakSamplingIntervalMs: 50,
      },
      model: {
        cacheSourceBefore: cacheBefore.source,
        cacheSourceAfter: cacheAfter.source,
        modelBytes,
        modelMiB: Number((modelBytes / (1024 * 1024)).toFixed(2)),
        quantized: true,
        initializeMs: modelLoadMs,
        state: app.embedding.getStatus().state,
      },
      queryCountPerModeAndSize: QUERY_COUNT,
      generation,
      indexing,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ output: "benchmarks/results/performance.json", generation, indexing, model: result.model, environment: result.environment }, null, 2));
  } finally {
    clearInterval(rssSampler);
    await app?.close();
    const absoluteTemp = path.resolve(tempRoot);
    const canonicalTemp = path.resolve(os.tmpdir());
    if (path.dirname(absoluteTemp) !== canonicalTemp || !path.basename(absoluteTemp).startsWith("vault-mcp-performance-")) {
      throw new Error(`Refusing to remove non-benchmark temporary path: ${absoluteTemp}`);
    }
    fs.rmSync(absoluteTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
}

await run();
