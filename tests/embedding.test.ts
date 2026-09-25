import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env as transformersEnv } from "@huggingface/transformers";
import {
  EmbeddingService,
  type EmbeddingModelRuntime,
  type EmbeddingTokenizer,
  splitTextIntoTokenWindows,
} from "../src/storage/embedding.js";
import { getEmbeddingProfile, inspectEmbeddingCache } from "../src/storage/profiles.js";

function makeRuntime(options: {
  tokenizerLimit?: unknown;
  modelLimit?: unknown;
  onExtract?: (text: string, callOptions: { pooling: "cls" | "mean"; normalize: true }) => ArrayLike<number>;
} = {}): EmbeddingModelRuntime {
  const tokenizer: EmbeddingTokenizer = {
    model_max_length: options.tokenizerLimit ?? 8,
    encode(text, encodeOptions) {
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
  assert.equal(service.getStatus().state, "unavailable");
  assert.equal(service.getStatus().lastError, "temporary network failure");
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
    assert.equal(service.getStatus().state, "disabled");
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
  assert.ok(submitted.every((window) => runtime.tokenizer.encode(window, {
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
  assert.ok(windows.every((window) => tokenizer.encode(window.text, {
    add_special_tokens: true,
  }).length === window.tokenCount));
  assert.throws(() => splitTextIntoTokenWindows("x", tokenizer, 2), /single Unicode code point/);
});

test("uses CLS pooling, requests normalized window vectors, and normalizes the weighted result", { timeout: 5_000 }, async () => {
  const seenOptions: Array<{ pooling: "cls" | "mean"; normalize: true }> = [];
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

test("keeps the BGE default and exposes the multilingual E5 profile metadata", () => {
  const bge = new EmbeddingService({ loader: async () => makeRuntime() }).getStatus();
  const e5Profile = getEmbeddingProfile("multilingual-e5-small");
  const e5 = new EmbeddingService({
    profile: "multilingual-e5-small",
    loader: async () => makeRuntime(),
  }).getStatus();

  assert.equal(bge.profile, "bge-small-zh");
  assert.equal(bge.modelId, "Xenova/bge-small-zh-v1.5");
  assert.equal(bge.dimensions, 512);
  assert.equal(e5.profile, "multilingual-e5-small");
  assert.equal(e5.modelId, "Xenova/multilingual-e5-small");
  assert.equal(e5.dimensions, 384);
  assert.equal(e5Profile.pooling, "mean");
  assert.equal(e5Profile.queryPrefix, "query: ");
  assert.equal(e5Profile.documentPrefix, "passage: ");
  assert.ok(e5.fingerprint.length > 0);

  const serviceProfile = new EmbeddingService({ loader: async () => makeRuntime() }).getProfile();
  assert.equal(serviceProfile.name, "bge-small-zh");
  assert.equal(Reflect.set(serviceProfile, "dimensions", 1), false);
  assert.equal(serviceProfile.dimensions, 512);
});

test("singleton identity includes offline/disabled modes without constructor global side effects", () => {
  const previousOffline = process.env.VAULT_OFFLINE;
  const previousDisabled = process.env.VAULT_EMBEDDINGS;
  const previousCache = process.env.VAULT_MODEL_CACHE;
  const previousRemote = transformersEnv.allowRemoteModels;
  try {
    process.env.VAULT_MODEL_CACHE = path.join(os.tmpdir(), `vault-mcp-singleton-${process.pid}-${Date.now()}`);
    delete process.env.VAULT_OFFLINE;
    delete process.env.VAULT_EMBEDDINGS;
    transformersEnv.allowRemoteModels = false;
    const online = EmbeddingService.getInstance({ profile: "multilingual-e5-small" });
    assert.equal(transformersEnv.allowRemoteModels, false);

    process.env.VAULT_OFFLINE = "1";
    const offline = EmbeddingService.getInstance({ profile: "multilingual-e5-small" });
    assert.notEqual(offline, online);
    assert.equal(transformersEnv.allowRemoteModels, false);

    process.env.VAULT_EMBEDDINGS = "off";
    const disabled = EmbeddingService.getInstance({ profile: "multilingual-e5-small" });
    assert.notEqual(disabled, offline);
    assert.equal(disabled.getStatus().state, "disabled");
    assert.equal(transformersEnv.allowRemoteModels, false);
  } finally {
    if (previousOffline === undefined) delete process.env.VAULT_OFFLINE;
    else process.env.VAULT_OFFLINE = previousOffline;
    if (previousDisabled === undefined) delete process.env.VAULT_EMBEDDINGS;
    else process.env.VAULT_EMBEDDINGS = previousDisabled;
    if (previousCache === undefined) delete process.env.VAULT_MODEL_CACHE;
    else process.env.VAULT_MODEL_CACHE = previousCache;
    transformersEnv.allowRemoteModels = previousRemote;
  }
});

test("applies E5 query/document prefixes and mean pooling", { timeout: 5_000 }, async () => {
  const calls: Array<{ text: string; pooling: "cls" | "mean" }> = [];
  const service = new EmbeddingService({
    profile: "multilingual-e5-small",
    loader: async () => makeRuntime({
      tokenizerLimit: 50,
      modelLimit: 50,
      onExtract(text, options) {
        calls.push({ text, pooling: options.pooling });
        return [3, 4];
      },
    }),
  });

  await service.getEmbedding("查找问题", "query");
  await service.getEmbedding("文档内容");

  assert.deepEqual(calls, [
    { text: "query: 查找问题", pooling: "mean" },
    { text: "passage: 文档内容", pooling: "mean" },
  ]);
  assert.equal(service.getStatus().dimensions, 384);
});

test("counts E5 prefixes in every window limit but weights only body tokens", { timeout: 5_000 }, async () => {
  const runtime = makeRuntime({ tokenizerLimit: 14, modelLimit: 14 });
  const windows = splitTextIntoTokenWindows("abcdefg", runtime.tokenizer, 14, "passage: ");
  assert.equal(windows.map((window) => window.text).join(""), "abcdefg");
  assert.ok(windows.every((window) => window.tokenCount <= 14));
  assert.ok(windows.every((window) => runtime.tokenizer.encode(`passage: ${window.text}`, {
    add_special_tokens: true,
  }).length === window.tokenCount));

  const submitted: string[] = [];
  const service = new EmbeddingService({
    profile: "multilingual-e5-small",
    loader: async () => ({
      ...runtime,
      extractor: async (text) => {
        submitted.push(text);
        return { data: text.endsWith("abc") ? [1, 0] : [0, 1] };
      },
    }),
  });
  const vector = await service.getEmbedding("abcdefg");

  assert.ok(submitted.length > 1);
  assert.ok(submitted.every((text) => text.startsWith("passage: ")));
  assert.equal(submitted.map((text) => text.slice("passage: ".length)).join(""), "abcdefg");
  assert.ok(submitted.every((text) => runtime.tokenizer.encode(text, {
    add_special_tokens: true,
  }).length <= 14));
  assert.ok(Math.abs(vector[0] - 3 / 5) < 1e-6);
  assert.ok(Math.abs(vector[1] - 4 / 5) < 1e-6);
});

test("cache inspection is read-only and selects a configured model directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-model-cache-test-"));
  try {
    const modelDir = path.join(root, "Xenova", "multilingual-e5-small");
    const onnxDir = path.join(modelDir, "onnx");
    fs.mkdirSync(onnxDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "config.json"), "{}", "utf8");
    fs.writeFileSync(path.join(modelDir, "tokenizer.json"), "{}", "utf8");
    fs.writeFileSync(path.join(onnxDir, "model_quantized.onnx"), "cached", "utf8");
    const before = fs.readdirSync(root).sort();

    const inspection = inspectEmbeddingCache("multilingual-e5-small", root);

    assert.equal(inspection.available, true);
    assert.equal(inspection.source, "configured");
    assert.equal(inspection.cacheDir, path.resolve(root));
    assert.deepEqual(fs.readdirSync(root).sort(), before);
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
        !path.basename(absolute).startsWith("vault-mcp-model-cache-test-")) {
      throw new Error(`Refusing to remove non-test cache path: ${absolute}`);
    }
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("cache inspection does not require the removed @xenova runtime to resolve", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-v4-cache-test-"));
  try {
    const inspection = inspectEmbeddingCache("bge-small-zh", root);
    assert.equal(inspection.available, false);
    assert.equal(inspection.cacheDir, path.resolve(root));
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
        !path.basename(absolute).startsWith("vault-mcp-v4-cache-test-")) {
      throw new Error(`Refusing to remove non-test cache path: ${absolute}`);
    }
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("does not treat a full-precision-only model as a ready quantized cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-full-model-cache-test-"));
  try {
    const modelDir = path.join(root, "Xenova", "multilingual-e5-small");
    const onnxDir = path.join(modelDir, "onnx");
    fs.mkdirSync(onnxDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "config.json"), "{}", "utf8");
    fs.writeFileSync(path.join(modelDir, "tokenizer.json"), "{}", "utf8");
    fs.writeFileSync(path.join(onnxDir, "model.onnx"), "full precision only", "utf8");

    const inspection = inspectEmbeddingCache("multilingual-e5-small", root);

    assert.equal(inspection.available, false);
    assert.equal(inspection.source, "missing");
    assert.equal(inspection.cacheDir, path.resolve(root));
  } finally {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
        !path.basename(absolute).startsWith("vault-mcp-full-model-cache-test-")) {
      throw new Error(`Refusing to remove non-test cache path: ${absolute}`);
    }
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("dispose releases an injected pipeline and permits a clean reinitialization", { timeout: 5_000 }, async () => {
  let loads = 0;
  let disposals = 0;
  const service = new EmbeddingService({
    loader: async () => {
      loads++;
      const runtime = makeRuntime();
      runtime.extractor.dispose = async () => { disposals++; };
      return runtime;
    },
  });

  await service.getEmbedding("one");
  await service.dispose();
  assert.equal(service.getStatus().state, "idle");
  await service.getEmbedding("two");
  assert.equal(loads, 2);
  await service.dispose();
  assert.equal(disposals, 2);
});
