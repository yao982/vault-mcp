import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EmbeddingService } from "../dist/storage/embedding.js";
import { EMBEDDING_PROFILES, inspectEmbeddingCache } from "../dist/storage/profiles.js";

function vectorNorm(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function modelBytes(cacheDir, modelId) {
  const modelDir = path.join(cacheDir, ...modelId.split("/"));
  if (!fs.existsSync(modelDir)) return 0;
  let total = 0;
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) total += fs.statSync(filename).size;
    }
  };
  walk(modelDir);
  return total;
}

const samples = {
  query: "如何释放动态分配的堆内存？",
  document: "Use free() to release heap memory allocated with malloc.",
};

for (const profileName of Object.keys(EMBEDDING_PROFILES)) {
  const profile = EMBEDDING_PROFILES[profileName];
  const before = inspectEmbeddingCache(profileName);
  const service = new EmbeddingService({ profile: profileName });
  const started = Date.now();
  try {
    await service.init();
    const initializedMs = Date.now() - started;
    const queryStarted = Date.now();
    const queryVector = await service.getEmbedding(samples.query, "query");
    const documentVector = await service.getEmbedding(samples.document, "document");
    const embeddingMs = Date.now() - queryStarted;
    assert.equal(queryVector.length, profile.dimensions);
    assert.equal(documentVector.length, profile.dimensions);
    assert.ok(Math.abs(vectorNorm(queryVector) - 1) < 1e-4);
    assert.ok(Math.abs(vectorNorm(documentVector) - 1) < 1e-4);

    const after = inspectEmbeddingCache(profileName);
    assert.ok(after.available, `${profileName} inference succeeded but model files were not persisted in its cache`);
    const bytes = modelBytes(after.cacheDir, profile.modelId);
    const crossLanguageCosine = cosine(queryVector, documentVector);
    if (profileName === "multilingual-e5-small") {
      assert.ok(crossLanguageCosine > 0.35, `E5 Chinese-English semantic similarity too low: ${crossLanguageCosine}`);
    }
    console.log(JSON.stringify({
      profile: profile.name,
      modelId: profile.modelId,
      dimensions: profile.dimensions,
      pooling: profile.pooling,
      queryPrefix: profile.queryPrefix,
      documentPrefix: profile.documentPrefix,
      fingerprint: profile.fingerprint,
      quantized: true,
      cacheSourceBefore: before.source,
      cacheSourceAfter: after.source,
      cacheReady: after.available,
      modelBytes: bytes,
      modelMiB: Number((bytes / (1024 * 1024)).toFixed(2)),
      initializeMs: initializedMs,
      queryAndDocumentMs: embeddingMs,
      chineseQueryEnglishDocumentCosine: Number(crossLanguageCosine.toFixed(6)),
      queryNorm: Number(vectorNorm(queryVector).toFixed(6)),
      documentNorm: Number(vectorNorm(documentVector).toFixed(6)),
      status: service.getStatus().state,
    }));
  } finally {
    await service.dispose();
  }
}
