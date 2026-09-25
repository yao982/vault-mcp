import { pipeline, env } from "@huggingface/transformers";
import {
  getEmbeddingProfile,
  inspectEmbeddingCache,
  type EmbeddingCacheInspection,
  type EmbeddingPooling,
  type EmbeddingProfile,
  type EmbeddingProfileName,
} from "./profiles.js";

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const MAX_REASONABLE_TOKEN_LIMIT = 1_000_000;

export interface EmbeddingTokenizer {
  encode(
    text: string,
    options?: { text_pair?: string | null; add_special_tokens?: boolean }
  ): ArrayLike<number>;
  model_max_length?: unknown;
}

export interface EmbeddingExtractor {
  (
    text: string,
    options: { pooling: EmbeddingPooling; normalize: true }
  ): Promise<{ data: ArrayLike<number> }>;
  dispose?(): Promise<void>;
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
  profile?: EmbeddingProfileName;
  cacheDir?: string;
}

export interface EmbeddingServiceStatus {
  state: "disabled" | "idle" | "loading" | "ready" | "unavailable";
  profile: EmbeddingProfileName;
  modelId: string;
  dimensions: number;
  fingerprint: string;
  cacheDir: string;
  lastError?: string;
}

export interface TokenWindow {
  /** Original body text, without a profile prefix. */
  text: string;
  /** Token count of prefix + body, including special tokens. */
  tokenCount: number;
}

/**
 * Divide body text by Unicode code points until prefix + body + special tokens
 * fit the model limit. The prefix is repeated for every resulting window.
 */
export function splitTextIntoTokenWindows(
  text: string,
  tokenizer: EmbeddingTokenizer,
  maxTokens: number,
  prefix = "",
): TokenWindow[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new RangeError(`maxTokens must be a positive safe integer; received ${maxTokens}`);
  }

  const windows: TokenWindow[] = [];
  const split = (codePoints: string[]): void => {
    const windowText = codePoints.join("");
    const tokenCount = tokenizer.encode(prefix + windowText, { add_special_tokens: true }).length;
    if (tokenCount <= maxTokens) {
      windows.push({ text: windowText, tokenCount });
      return;
    }

    if (codePoints.length <= 1) {
      throw new RangeError(
        `A single Unicode code point with its prefix encodes to ${tokenCount} tokens, exceeding the model limit of ${maxTokens}`
      );
    }

    const midpoint = Math.floor(codePoints.length / 2);
    split(codePoints.slice(0, midpoint));
    split(codePoints.slice(midpoint));
  };

  split([...text]);
  return windows;
}

/** Local transformer embedding service with per-profile state and cache selection. */
export class EmbeddingService {
  private static readonly instances = new Map<string, EmbeddingService>();

  private readonly loader: () => Promise<EmbeddingModelRuntime>;
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly profile: EmbeddingProfile;
  private readonly cache: EmbeddingCacheInspection;
  private readonly offline: boolean;
  private extractor: EmbeddingExtractor | null = null;
  private tokenizer: EmbeddingTokenizer | null = null;
  private maxTokens = DEFAULT_MAX_TOKENS;
  private loadPromise: Promise<void> | null = null;
  private state: EmbeddingServiceStatus["state"];
  private retryAt = 0;
  private lastError: string | undefined;

  public constructor(options: EmbeddingServiceOptions = {}) {
    const isDisabled = EmbeddingService.isDisabledByEnvironment();
    this.offline = process.env.VAULT_OFFLINE === "1";
    this.profile = getEmbeddingProfile(options.profile ?? "bge-small-zh");
    this.cache = inspectEmbeddingCache(this.profile.name, options.cacheDir);
    this.state = isDisabled ? "disabled" : "idle";
    this.backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_RETRY_BACKOFF_MS);
    this.now = options.now ?? Date.now;
    this.loader = options.loader ?? (() => this.loadProductionModel());

  }

  /** Default callers keep using BGE; profile/cache combinations never share state. */
  public static getInstance(options: EmbeddingServiceOptions = {}): EmbeddingService {
    const profileName = options.profile ?? "bge-small-zh";
    const cache = inspectEmbeddingCache(profileName, options.cacheDir);
    const offline = process.env.VAULT_OFFLINE === "1";
    const disabled = EmbeddingService.isDisabledByEnvironment();
    const key = `${profileName}\0${cache.cacheDir}\0offline=${offline}\0disabled=${disabled}`;
    let instance = EmbeddingService.instances.get(key);
    if (!instance) {
      instance = new EmbeddingService(options);
      EmbeddingService.instances.set(key, instance);
    }
    return instance;
  }

  public getStatus(): EmbeddingServiceStatus {
    return {
      state: this.state,
      profile: this.profile.name,
      modelId: this.profile.modelId,
      dimensions: this.profile.dimensions,
      fingerprint: this.profile.fingerprint,
      cacheDir: this.cache.cacheDir,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
  }

  /** Return a frozen copy of the profile used by this service. */
  public getProfile(): Readonly<EmbeddingProfile> {
    return Object.freeze({ ...this.profile });
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
    const pending = Promise.resolve().then(() => this.loadModel());
    this.loadPromise = pending;
    return pending;
  }

  /** Convert profile-prefixed windows to one effective-token-weighted unit vector. */
  public async getEmbedding(text: string, kind: "query" | "document" = "document"): Promise<Float32Array> {
    await this.init();

    const tokenizer = this.tokenizer;
    const extractor = this.extractor;
    if (!tokenizer || !extractor) {
      throw new Error("Embedding model initialization completed without a tokenizer and extractor.");
    }

    const prefix = kind === "query" ? this.profile.queryPrefix : this.profile.documentPrefix;
    const windows = splitTextIntoTokenWindows(text, tokenizer, this.maxTokens, prefix);
    const weighted: number[] = [];
    let totalWeight = 0;

    for (const window of windows) {
      const output = await extractor(prefix + window.text, {
        pooling: this.profile.pooling,
        normalize: true,
      });
      const vector = output.data;
      if (weighted.length === 0) {
        for (let i = 0; i < vector.length; i++) weighted.push(0);
      } else if (vector.length !== weighted.length) {
        throw new Error("Embedding model returned vectors with inconsistent dimensions.");
      }

      const effectiveTokens = tokenizer.encode(window.text, { add_special_tokens: false }).length;
      const weight = Math.max(1, effectiveTokens);
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

  /** Release the transformer pipeline so profile benchmarks can unload it. */
  public async dispose(): Promise<void> {
    if (this.loadPromise) await this.loadPromise.catch(() => {});
    const extractor = this.extractor;
    this.extractor = null;
    this.tokenizer = null;
    this.maxTokens = DEFAULT_MAX_TOKENS;
    this.lastError = undefined;
    this.retryAt = 0;
    if (this.state !== "disabled") this.state = "idle";
    await extractor?.dispose?.();
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
      `Embedding model ${this.profile.name} is unavailable; retry is delayed for ${remainingMs} ms.${reason}`
    );
  }

  private async loadProductionModel(): Promise<EmbeddingModelRuntime> {
    // Set shared transformer defaults only as models load. Offline calls also
    // pass local_files_only=true, which remains authoritative if loads overlap.
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
    const loaded = await pipeline(
      "feature-extraction",
      this.profile.modelId,
      {
        cache_dir: this.cache.cacheDir,
        local_files_only: this.offline,
        dtype: "q8",
        device: "cpu",
      }
    );
    const runtime = loaded as unknown as {
      (text: string, options: { pooling: EmbeddingPooling; normalize: true }): Promise<{ data: ArrayLike<number> }>;
      tokenizer: EmbeddingTokenizer;
      model: { config?: { max_position_embeddings?: unknown } };
    } & { dispose?: () => Promise<void> };
    const extractor = runtime as EmbeddingExtractor;
    extractor.dispose = runtime.dispose?.bind(runtime);
    return {
      extractor,
      tokenizer: runtime.tokenizer,
      model: runtime.model,
    };
  }

  private static isDisabledByEnvironment(): boolean {
    return process.env.VAULT_EMBEDDINGS?.toLowerCase() === "off";
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
