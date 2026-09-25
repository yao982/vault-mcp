import { pipeline, env } from "@xenova/transformers";

const MODEL_ID = "Xenova/bge-small-zh-v1.5";
const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const MAX_REASONABLE_TOKEN_LIMIT = 1_000_000;

export interface EmbeddingTokenizer {
  encode(
    text: string,
    textPair?: string | null,
    options?: { add_special_tokens?: boolean }
  ): ArrayLike<number>;
  model_max_length?: unknown;
}

export interface EmbeddingExtractor {
  (
    text: string,
    options: { pooling: "cls"; normalize: true }
  ): Promise<{ data: ArrayLike<number> }>;
}

export interface EmbeddingModelRuntime {
  extractor: EmbeddingExtractor;
  tokenizer: EmbeddingTokenizer;
  model?: { config?: { max_position_embeddings?: unknown } };
}

export interface EmbeddingServiceOptions {
  loader?: () => Promise<EmbeddingModelRuntime>;
  backoffMs?: number;
  now?: () => number;
}

export interface TokenWindow {
  text: string;
  tokenCount: number;
}

/**
 * Divide text by Unicode code points until every original-text window fits the
 * model limit. Counting includes the special tokens the pipeline will add.
 */
export function splitTextIntoTokenWindows(
  text: string,
  tokenizer: EmbeddingTokenizer,
  maxTokens: number
): TokenWindow[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError(`maxTokens must be a positive safe integer; received ${maxTokens}`);
  }

  const windows: TokenWindow[] = [];
  const split = (codePoints: string[]): void => {
    const windowText = codePoints.join("");
    const tokenCount = tokenizer.encode(windowText, null, { add_special_tokens: true }).length;
    if (tokenCount <= maxTokens) {
      windows.push({ text: windowText, tokenCount });
      return;
    }

    if (codePoints.length <= 1) {
      throw new RangeError(
        `A single Unicode code point encodes to ${tokenCount} tokens, exceeding the model limit of ${maxTokens}`
      );
    }

    const midpoint = Math.floor(codePoints.length / 2);
    split(codePoints.slice(0, midpoint));
    split(codePoints.slice(midpoint));
  };

  split([...text]);
  return windows;
}

/**
 * Local lightweight embedding service. A failed model load is retried only
 * after a short backoff so one indexing run does not repeatedly download it.
 */
export class EmbeddingService {
  private static instance: EmbeddingService;

  private readonly loader: () => Promise<EmbeddingModelRuntime>;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private extractor: EmbeddingExtractor | null = null;
  private tokenizer: EmbeddingTokenizer | null = null;
  private maxTokens = DEFAULT_MAX_TOKENS;
  private loadPromise: Promise<void> | null = null;
  private state: "disabled" | "idle" | "loading" | "ready" | "unavailable";
  private retryAt = 0;
  private lastError: string | undefined;

  public constructor(options: EmbeddingServiceOptions = {}) {
    const isOffline = process.env.VAULT_OFFLINE === "1";
    const isDisabled = process.env.VAULT_EMBEDDINGS?.toLowerCase() === "off";
    this.state = isDisabled ? "disabled" : "idle";
    this.backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    this.now = options.now ?? Date.now;
    this.loader = options.loader ?? (() => this.loadProductionModel(isOffline));

    // Permit cache use. In offline mode the package-level flag and pipeline
    // option both prevent a remote request.
    env.allowLocalModels = true;
    if (isOffline) env.allowRemoteModels = false;
  }

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
    }
    return EmbeddingService.instance;
  }

  public getStatus(): {
    state: "disabled" | "idle" | "loading" | "ready" | "unavailable";
    lastError?: string;
  } {
    return this.lastError === undefined
      ? { state: this.state }
      : { state: this.state, lastError: this.lastError };
  }

  public async init(): Promise<void> {
    if (this.state === "disabled") {
      throw new Error("Embeddings are disabled (VAULT_EMBEDDINGS=off).");
    }
    if (this.state === "ready") return;
    if (this.loadPromise) return this.loadPromise;

    const now = this.now();
    if (this.state === "unavailable" && now < this.retryAt) {
      throw this.unavailableError();
    }

    this.state = "loading";
    // Schedule the loader after assigning the shared promise. This also makes
    // synchronous loader throws follow the same cleanup/backoff path as rejects.
    const pending = Promise.resolve().then(() => this.loadModel());
    this.loadPromise = pending;
    return pending;
  }

  /** Convert all token-bounded windows to one token-weighted unit vector. */
  public async getEmbedding(text: string): Promise<Float32Array> {
    await this.init();

    const tokenizer = this.tokenizer;
    const extractor = this.extractor;
    if (!tokenizer || !extractor) {
      throw new Error("Embedding model initialization completed without a tokenizer and extractor.");
    }

    const windows = splitTextIntoTokenWindows(text, tokenizer, this.maxTokens);
    const weighted: number[] = [];
    let totalWeight = 0;

    for (const window of windows) {
      const output = await extractor(window.text, { pooling: "cls", normalize: true });
      const vector = output.data;
      if (weighted.length === 0) {
        for (let i = 0; i < vector.length; i++) weighted.push(0);
      } else if (vector.length !== weighted.length) {
        throw new Error("Embedding model returned vectors with inconsistent dimensions.");
      }

      const weight = Math.max(
        1,
        tokenizer.encode(window.text, null, { add_special_tokens: false }).length
      );
      for (let i = 0; i < vector.length; i++) {
        weighted[i] += Number(vector[i]) * weight;
      }
      totalWeight += weight;
    }

    if (weighted.length === 0 || totalWeight === 0) {
      throw new Error("Embedding model returned an empty vector.");
    }

    let squaredNorm = 0;
    for (let i = 0; i < weighted.length; i++) {
      weighted[i] /= totalWeight;
      squaredNorm += weighted[i] * weighted[i];
    }
    const norm = Math.sqrt(squaredNorm);
    if (!Number.isFinite(norm) || norm === 0) {
      throw new Error("Embedding model returned a vector that cannot be normalized.");
    }

    return Float32Array.from(weighted, (value) => value / norm);
  }

  private async loadModel(): Promise<void> {
    try {
      const runtime = await this.loader();
      if (!runtime?.extractor || !runtime.tokenizer) {
        throw new Error("Embedding model loader did not provide an extractor and tokenizer.");
      }

      this.extractor = runtime.extractor;
      this.tokenizer = runtime.tokenizer;
      this.maxTokens = chooseMaxTokens(
        runtime.tokenizer.model_max_length,
        runtime.model?.config?.max_position_embeddings
      );
      this.lastError = undefined;
      this.retryAt = 0;
      this.state = "ready";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.retryAt = this.now() + this.backoffMs;
      this.state = "unavailable";
      throw error;
    } finally {
      this.loadPromise = null;
    }
  }

  private unavailableError(): Error {
    const remainingMs = Math.max(0, this.retryAt - this.now());
    const reason = this.lastError ? ` Last error: ${this.lastError}` : "";
    return new Error(
      `Embedding model is unavailable; retry is delayed for ${remainingMs} ms.${reason}`
    );
  }

  private async loadProductionModel(isOffline: boolean): Promise<EmbeddingModelRuntime> {
    const loaded = await pipeline(
      "feature-extraction",
      MODEL_ID,
      isOffline ? { local_files_only: true } : undefined
    );
    // The v2 pipeline object exposes tokenizer and model at runtime, while its
    // callable type does not describe those properties consistently.
    const runtime = loaded as unknown as {
      (text: string, options: { pooling: "cls"; normalize: true }): Promise<{ data: ArrayLike<number> }>;
      tokenizer: EmbeddingTokenizer;
      model: { config?: { max_position_embeddings?: unknown } };
    };
    return {
      extractor: runtime,
      tokenizer: runtime.tokenizer,
      model: runtime.model,
    };
  }
}

function chooseMaxTokens(tokenizerLimit: unknown, modelLimit: unknown): number {
  const validLimits = [tokenizerLimit, modelLimit].filter(isReasonableTokenLimit);
  return validLimits.length > 0 ? Math.min(...validLimits) : DEFAULT_MAX_TOKENS;
}

function isReasonableTokenLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_REASONABLE_TOKEN_LIMIT
  );
}
