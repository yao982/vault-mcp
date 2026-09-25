import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type EmbeddingProfileName = "bge-small-zh" | "multilingual-e5-small";
export type EmbeddingPooling = "cls" | "mean";

export interface EmbeddingProfile {
  readonly name: EmbeddingProfileName;
  readonly modelId: string;
  readonly pooling: EmbeddingPooling;
  readonly dimensions: number;
  readonly queryPrefix: string;
  readonly documentPrefix: string;
  readonly fingerprint: string;
}

export type EmbeddingCacheSource = "configured" | "legacy-transformers" | "missing";

export interface EmbeddingCacheInspection {
  profile: EmbeddingProfileName;
  modelId: string;
  preferredCacheDir: string;
  cacheDir: string;
  available: boolean;
  source: EmbeddingCacheSource;
}

const profiles: Record<EmbeddingProfileName, EmbeddingProfile> = {
  "bge-small-zh": {
    name: "bge-small-zh",
    modelId: "Xenova/bge-small-zh-v1.5",
    pooling: "cls",
    dimensions: 512,
    queryPrefix: "",
    documentPrefix: "",
    fingerprint: "bge-small-zh|Xenova/bge-small-zh-v1.5|cls|512||norm=l2-weighted|window=unicode-codepoint-recursive|weight=body-effective-tokens|dtype=q8|device=cpu|runtime=@huggingface/transformers@4.3.0|onnxruntime-node@1.30.0",
  },
  "multilingual-e5-small": {
    name: "multilingual-e5-small",
    modelId: "Xenova/multilingual-e5-small",
    pooling: "mean",
    dimensions: 384,
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    fingerprint: "multilingual-e5-small|Xenova/multilingual-e5-small|mean|384|query: |passage: |norm=l2-weighted|window=unicode-codepoint-recursive|weight=body-effective-tokens|dtype=q8|device=cpu|runtime=@huggingface/transformers@4.3.0|onnxruntime-node@1.30.0",
  },
};

export const EMBEDDING_PROFILES: Readonly<Record<EmbeddingProfileName, EmbeddingProfile>> =
  Object.freeze(profiles);

export function getEmbeddingProfile(name: EmbeddingProfileName): EmbeddingProfile {
  const profile = EMBEDDING_PROFILES[name];
  if (!profile) throw new Error(`Unknown embedding profile: ${String(name)}`);
  return profile;
}

/** Stable per-user cache location, overridden by an explicit path or VAULT_MODEL_CACHE. */
export function resolveEmbeddingCacheDir(cacheDir?: string): string {
  return path.resolve(
    cacheDir ??
      process.env.VAULT_MODEL_CACHE ??
      path.join(os.homedir(), ".cache", "vault-mcp", "transformers")
  );
}

/** Read-only check for complete model files in the configured or legacy package cache. */
export function inspectEmbeddingCache(
  profileName: EmbeddingProfileName,
  cacheDir?: string,
): EmbeddingCacheInspection {
  const profile = getEmbeddingProfile(profileName);
  const preferredCacheDir = resolveEmbeddingCacheDir(cacheDir);
  if (hasCachedModel(preferredCacheDir, profile.modelId)) {
    return {
      profile: profile.name,
      modelId: profile.modelId,
      preferredCacheDir,
      cacheDir: preferredCacheDir,
      available: true,
      source: "configured",
    };
  }

  const legacyCacheDir = getLegacyTransformersCacheDirs().find(
    (candidate) => path.resolve(candidate) !== preferredCacheDir && hasCachedModel(candidate, profile.modelId)
  );
  if (legacyCacheDir) {
    return {
      profile: profile.name,
      modelId: profile.modelId,
      preferredCacheDir,
      cacheDir: path.resolve(legacyCacheDir),
      available: true,
      source: "legacy-transformers",
    };
  }

  return {
    profile: profile.name,
    modelId: profile.modelId,
    preferredCacheDir,
    cacheDir: preferredCacheDir,
    available: false,
    source: "missing",
  };
}

function hasCachedModel(cacheDir: string, modelId: string): boolean {
  const modelDir = path.join(cacheDir, ...modelId.split("/"));
  const onnxDir = path.join(modelDir, "onnx");
  return (
    fs.existsSync(path.join(modelDir, "config.json")) &&
    fs.existsSync(path.join(modelDir, "tokenizer.json")) &&
    fs.existsSync(path.join(onnxDir, "model_quantized.onnx"))
  );
}

function getLegacyTransformersCacheDirs(): string[] {
  const candidates = new Set<string>();

  // Prefer the path from an installed v2 package when it is still resolvable.
  // The package may be absent after upgrading, while its old cache directory
  // can still exist, so also derive the old locations from this package root.
  try {
    const modulePath = fileURLToPath(import.meta.resolve("@xenova/transformers"));
    candidates.add(path.resolve(path.dirname(path.dirname(modulePath)), ".cache"));
  } catch {
    // Missing @xenova/transformers is expected after upgrading to v4.
  }

  const startDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findVaultPackageRoot(startDir);
  if (packageRoot) {
    candidates.add(path.join(packageRoot, "node_modules", "@xenova", "transformers", ".cache"));
  }

  // npm can hoist the old runtime to an ancestor node_modules directory.
  let currentDir = startDir;
  while (true) {
    if (path.basename(currentDir) === "node_modules") {
      candidates.add(path.join(currentDir, "@xenova", "transformers", ".cache"));
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  return [...candidates];
}

function findVaultPackageRoot(startDir: string): string | undefined {
  let currentDir = startDir;
  while (true) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(currentDir, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name === "vault-mcp") return currentDir;
    } catch {
      // Keep walking through source/output directories.
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}
