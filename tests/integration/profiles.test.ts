import assert from "node:assert/strict";
import test from "node:test";
import { env } from "@xenova/transformers";
import { EmbeddingService } from "../../src/storage/embedding.js";
import { EMBEDDING_PROFILES, inspectEmbeddingCache } from "../../src/storage/profiles.js";

function dot(left: Float32Array, right: Float32Array): number {
  assert.equal(left.length, right.length);
  let value = 0;
  for (let i = 0; i < left.length; i++) value += left[i] * right[i];
  return value;
}

function norm(vector: Float32Array): number {
  return Math.sqrt(dot(vector, vector));
}

for (const profile of Object.values(EMBEDDING_PROFILES)) {
  const cache = inspectEmbeddingCache(profile.name);
  test(`real ${profile.name} model emits normalized ${profile.dimensions}-D query and document vectors`, {
    timeout: 120_000,
    skip: cache.available ? false : "Model cache is not prepared; run the prepare-models script first.",
  }, async () => {
    const previousOffline = process.env.VAULT_OFFLINE;
    const previousAllowRemote = env.allowRemoteModels;
    const previousAllowLocal = env.allowLocalModels;
    process.env.VAULT_OFFLINE = "1";
    const service = new EmbeddingService({ profile: profile.name });
    try {
      const query = await service.getEmbedding("如何释放动态分配的堆内存？", "query");
      const englishPassage = await service.getEmbedding(
        "Use free() to release heap memory allocated with malloc.",
        "document",
      );

      assert.equal(query.length, profile.dimensions);
      assert.equal(englishPassage.length, profile.dimensions);
      assert.ok(Math.abs(norm(query) - 1) < 1e-4);
      assert.ok(Math.abs(norm(englishPassage) - 1) < 1e-4);
      assert.ok(Number.isFinite(dot(query, englishPassage)));
      if (profile.name === "multilingual-e5-small") {
        assert.ok(dot(query, englishPassage) > 0.35, "cross-language query/passage similarity should be positive and meaningful");
      }
    } finally {
      await service.dispose();
      if (previousOffline === undefined) delete process.env.VAULT_OFFLINE;
      else process.env.VAULT_OFFLINE = previousOffline;
      env.allowRemoteModels = previousAllowRemote;
      env.allowLocalModels = previousAllowLocal;
    }
  });
}
