import assert from "node:assert/strict";
import test from "node:test";
import {
  EmbeddingService,
  type EmbeddingModelRuntime,
  type EmbeddingTokenizer,
  splitTextIntoTokenWindows,
} from "../src/storage/embedding.js";

function makeRuntime(options: {
  tokenizerLimit?: unknown;
  modelLimit?: unknown;
  onExtract?: (text: string, callOptions: { pooling: "cls"; normalize: true }) => ArrayLike<number>;
} = {}): EmbeddingModelRuntime {
  const tokenizer: EmbeddingTokenizer = {
    model_max_length: options.tokenizerLimit ?? 8,
    encode(text, _pair, encodeOptions) {
      const contentTokens = [...text].length;
      const specialTokens = encodeOptions?.add_special_tokens === false ? 0 : 2;
      return Array.from({ length: contentTokens + specialTokens }, (_, index) => index);
    },
  };

  return {
    tokenizer,
    model: { config: { max_position_embeddings: options.modelLimit ?? 5 } },
    async extractor(text, callOptions) {
      return { data: options.onExtract?.(text, callOptions) ?? [3, 4] };
    },
  };
}

test("coalesces concurrent model initialization into one load", { timeout: 5_000 }, async () => {
  let loadCount = 0;
  let resolveLoad!: (runtime: EmbeddingModelRuntime) => void;
  const loader = () => {
    loadCount++;
    return new Promise<EmbeddingModelRuntime>((resolve) => {
      resolveLoad = resolve;
    });
  };
  const service = new EmbeddingService({ loader });

  const first = service.getEmbedding("first");
  const second = service.getEmbedding("second");
  await Promise.resolve();
  assert.equal(loadCount, 1);
  assert.equal(service.getStatus().state, "loading");

  resolveLoad(makeRuntime());
  const [firstVector, secondVector] = await Promise.all([first, second]);
  assert.equal(firstVector.length, 2);
  assert.equal(secondVector.length, 2);
  assert.equal(service.getStatus().state, "ready");
  assert.equal(loadCount, 1);
});

test("backs off after load failure and retries after the delay", { timeout: 5_000 }, async () => {
  let now = 100;
  let loadCount = 0;
  const service = new EmbeddingService({
    now: () => now,
    backoffMs: 30_000,
    loader: async () => {
      loadCount++;
      if (loadCount === 1) throw new Error("temporary network failure");
      return makeRuntime();
    },
  });

  await assert.rejects(service.getEmbedding("text"), /temporary network failure/);
  assert.deepEqual(service.getStatus(), {
    state: "unavailable",
    lastError: "temporary network failure",
  });
  await assert.rejects(service.getEmbedding("text"), /retry is delayed/);
  assert.equal(loadCount, 1);

  now += 30_000;
  const vector = await service.getEmbedding("text");
  assert.equal(vector.length, 2);
  assert.equal(loadCount, 2);
  assert.equal(service.getStatus().state, "ready");
});

test("clears a shared initialization promise after a synchronous loader throw", { timeout: 5_000 }, async () => {
  let loadCount = 0;
  const service = new EmbeddingService({
    backoffMs: 0,
    loader: () => {
      loadCount++;
      if (loadCount === 1) throw new Error("synchronous loader failure");
      return Promise.resolve(makeRuntime());
    },
  });

  await assert.rejects(service.getEmbedding("first attempt"), /synchronous loader failure/);
  assert.equal(service.getStatus().state, "unavailable");
  const vector = await service.getEmbedding("second attempt");

  assert.equal(vector.length, 2);
  assert.equal(loadCount, 2);
  assert.equal(service.getStatus().state, "ready");
});

test("reports disabled mode and rejects embedding requests with a clear message", { timeout: 5_000 }, async () => {
  const previous = process.env.VAULT_EMBEDDINGS;
  process.env.VAULT_EMBEDDINGS = "off";
  try {
    const service = new EmbeddingService({
      loader: async () => {
        throw new Error("disabled service must not load a model");
      },
    });
    assert.deepEqual(service.getStatus(), { state: "disabled" });
    await assert.rejects(service.getEmbedding("text"), /VAULT_EMBEDDINGS=off/);
  } finally {
    if (previous === undefined) delete process.env.VAULT_EMBEDDINGS;
    else process.env.VAULT_EMBEDDINGS = previous;
  }
});

test("splits on Unicode code points, keeps the tail, and never exceeds the token limit", { timeout: 5_000 }, async () => {
  const runtime = makeRuntime({ tokenizerLimit: 20, modelLimit: 5 });
  const submitted: string[] = [];
  const service = new EmbeddingService({
    loader: async () => ({
      ...runtime,
      extractor: async (text, _options) => {
        submitted.push(text);
        return { data: [1, 0] };
      },
    }),
  });
  const text = "A😀BCDE-tail-保留";

  await service.getEmbedding(text);

  assert.equal(submitted.join(""), text);
  assert.ok(submitted.some((window) => window.endsWith("保留")));
  assert.ok(submitted.every((window) => runtime.tokenizer.encode(window, null, {
    add_special_tokens: true,
  }).length <= 5));
  assert.ok(submitted.every((window) => !window.includes("\uFFFD")));
  assert.equal(service.getStatus().state, "ready");
});

test("pure windowing counts added special tokens and applies the model's smaller valid limit", () => {
  const tokenizer = makeRuntime({ tokenizerLimit: 7, modelLimit: 4 }).tokenizer;
  const windows = splitTextIntoTokenWindows("abcdefgh", tokenizer, 4);

  assert.equal(windows.map((window) => window.text).join(""), "abcdefgh");
  assert.ok(windows.every((window) => window.tokenCount <= 4));
  assert.ok(windows.every((window) => tokenizer.encode(window.text, null, {
    add_special_tokens: true,
  }).length === window.tokenCount));
  assert.throws(() => splitTextIntoTokenWindows("x", tokenizer, 2), /single Unicode code point/);
});

test("uses CLS pooling, requests normalized window vectors, and normalizes the weighted result", { timeout: 5_000 }, async () => {
  const seenOptions: Array<{ pooling: "cls"; normalize: true }> = [];
  const service = new EmbeddingService({
    loader: async () => makeRuntime({
      tokenizerLimit: 4,
      modelLimit: 4,
      onExtract(text, callOptions) {
        seenOptions.push(callOptions);
        return text === "a" ? [1, 0] : [0, 1];
      },
    }),
  });

  const vector = await service.getEmbedding("abc");
  assert.deepEqual(seenOptions, [
    { pooling: "cls", normalize: true },
    { pooling: "cls", normalize: true },
  ]);
  assert.ok(Math.abs(vector[0] - 1 / Math.sqrt(5)) < 1e-6);
  assert.ok(Math.abs(vector[1] - 2 / Math.sqrt(5)) < 1e-6);
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6);
});
