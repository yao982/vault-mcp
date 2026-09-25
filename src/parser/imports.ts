import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const IMPORT_MANIFEST_NAME = "vault.imports.json";

export interface ImportedPageRange {
  page: number;
  startLine: number;
  endLine: number;
}

export interface PdfMarkdownImport {
  pdf: string;
  markdown: string;
  pages?: ImportedPageRange[];
  sourceHash?: string;
}

export interface ImportManifest {
  version: 1;
  documents: PdfMarkdownImport[];
}

export interface ImportManifestValidationOptions {
  /** Require referenced PDF and Markdown files to exist as regular files. */
  requireFiles?: boolean;
  /** Verify each supplied sourceHash against the original PDF bytes. */
  verifySourceHash?: boolean;
}

const EMPTY_MANIFEST: ImportManifest = { version: 1, documents: [] };

/** Load the root manifest. Missing manifests mean that no explicit imports exist. */
export function loadImportManifest(vaultRoot: string): ImportManifest {
  const root = fs.realpathSync(vaultRoot);
  const filename = path.join(root, IMPORT_MANIFEST_NAME);
  try {
    if (fs.lstatSync(filename).isSymbolicLink()) throw new Error(`${IMPORT_MANIFEST_NAME} must not be a symbolic link.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, documents: [] };
    throw error;
  }
  if (!fs.statSync(filename).isFile()) throw new Error(`${IMPORT_MANIFEST_NAME} must be a regular file.`);
  const value = JSON.parse(fs.readFileSync(filename, "utf8")) as unknown;
  // Source existence and hashes are checked per PDF during reconciliation so
  // one missing conversion marks only its own previous result stale.
  return validateImportManifest(vaultRoot, value, { requireFiles: false, verifySourceHash: false });
}

/** Validate manifest structure and ensure all referenced paths stay in-vault. */
export function validateImportManifest(
  vaultRoot: string,
  value: unknown,
  options: ImportManifestValidationOptions = {},
): ImportManifest {
  const requireFiles = options.requireFiles ?? true;
  const verifySourceHash = options.verifySourceHash ?? true;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.documents)) {
    throw new Error("vault.imports.json must contain { version: 1, documents: [...] }.");
  }

  const pdfPaths = new Set<string>();
  const markdownPaths = new Set<string>();
  const documents: PdfMarkdownImport[] = [];
  for (let index = 0; index < value.documents.length; index++) {
    const item = value.documents[index];
    if (!isRecord(item) || typeof item.pdf !== "string" || typeof item.markdown !== "string") {
      throw new Error(`vault.imports.json documents[${index}] must contain PDF and Markdown paths.`);
    }
    const pdf = normalizeVaultPath(vaultRoot, item.pdf, ".pdf", requireFiles);
    const markdown = normalizeVaultPath(vaultRoot, item.markdown, undefined, requireFiles);
    const pdfKey = pdf.toLocaleLowerCase("en-US");
    const markdownKey = markdown.toLocaleLowerCase("en-US");
    if (pdfPaths.has(pdfKey)) throw new Error(`Duplicate PDF import mapping: ${pdf}`);
    if (markdownPaths.has(markdownKey)) throw new Error(`Markdown file is mapped more than once: ${markdown}`);
    pdfPaths.add(pdfKey);
    markdownPaths.add(markdownKey);

    let pages: ImportedPageRange[] | undefined;
    if (item.pages !== undefined) {
      if (!Array.isArray(item.pages)) throw new Error(`Import mapping for ${pdf} has an invalid pages field.`);
      pages = item.pages.map((range, pageIndex) => {
        if (!isRecord(range) || !isPositiveInteger(range.page) || !isPositiveInteger(range.startLine) ||
            !isPositiveInteger(range.endLine) || range.endLine < range.startLine) {
          throw new Error(`Import mapping for ${pdf} has an invalid page range at pages[${pageIndex}].`);
        }
        return { page: range.page, startLine: range.startLine, endLine: range.endLine };
      });
      const sortedRanges = [...pages].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
      for (let rangeIndex = 1; rangeIndex < sortedRanges.length; rangeIndex++) {
        if (sortedRanges[rangeIndex].startLine <= sortedRanges[rangeIndex - 1].endLine) {
          throw new Error(`Import mapping for ${pdf} contains overlapping Markdown line ranges.`);
        }
      }
    }

    let sourceHash: string | undefined;
    if (item.sourceHash !== undefined) {
      if (typeof item.sourceHash !== "string" || !/^[a-f0-9]{64}$/i.test(item.sourceHash)) {
        throw new Error(`Import mapping for ${pdf} has an invalid sourceHash.`);
      }
      sourceHash = item.sourceHash.toLowerCase();
    }

    if (requireFiles && sourceHash && verifySourceHash) {
      const actualHash = createHash("sha256").update(fs.readFileSync(resolveManifestPath(vaultRoot, pdf))).digest("hex");
      if (actualHash !== sourceHash) throw new Error(`Import sourceHash does not match the original PDF: ${pdf}`);
    }

    documents.push({ pdf, markdown, ...(pages ? { pages } : {}), ...(sourceHash ? { sourceHash } : {}) });
  }
  return { version: 1, documents };
}

export function findImportForPdf(manifest: ImportManifest, relativePdfPath: string): PdfMarkdownImport | null {
  const normalized = normalizeSeparators(relativePdfPath).toLocaleLowerCase("en-US");
  return manifest.documents.find((item) => item.pdf.toLocaleLowerCase("en-US") === normalized) ?? null;
}

export function findImportForMarkdown(manifest: ImportManifest, relativeMarkdownPath: string): PdfMarkdownImport | null {
  const normalized = normalizeSeparators(relativeMarkdownPath).toLocaleLowerCase("en-US");
  return manifest.documents.find((item) => item.markdown.toLocaleLowerCase("en-US") === normalized) ?? null;
}

function normalizeVaultPath(vaultRoot: string, rawPath: string, requiredExtension?: string, requireFiles = true): string {
  const relative = normalizeSeparators(rawPath);
  if (!relative || relative.includes("\0") || relative.includes(":") || path.posix.isAbsolute(relative) ||
      path.win32.isAbsolute(rawPath)) {
    throw new Error(`Import path must be relative to the vault root: ${rawPath}`);
  }
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.startsWith("."))) {
    throw new Error(`Import path is hidden or escapes the vault root: ${rawPath}`);
  }
  if (parts.some((part) => ["node_modules", "images", "assets", "_assets", "dist", "build", "slprj", "model"].includes(part.toLowerCase()))) {
    throw new Error(`Import path uses an ignored vault directory: ${rawPath}`);
  }
  const extension = path.posix.extname(relative).toLowerCase();
  if (requiredExtension && extension !== requiredExtension) {
    throw new Error(`Import path must use ${requiredExtension}: ${rawPath}`);
  }
  if (!requiredExtension && ![".md", ".markdown"].includes(extension)) {
    throw new Error(`Import Markdown path must use .md or .markdown: ${rawPath}`);
  }
  const candidate = path.resolve(vaultRoot, ...parts);
  const root = fs.realpathSync(vaultRoot);
  const lexicalRelative = path.relative(root, candidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) {
    throw new Error(`Import path escapes the vault root: ${rawPath}`);
  }

  // Reject existing symlink or junction components, while allowing missing
  // files during a scan so the indexer can preserve and mark prior results stale.
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Import path traverses a symbolic link: ${rawPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }

  if (requireFiles) {
    const resolved = fs.realpathSync(candidate);
    const actualRelative = path.relative(root, resolved);
    if (actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
      throw new Error(`Import path resolves outside the vault root: ${rawPath}`);
    }
    if (!fs.statSync(resolved).isFile()) throw new Error(`Import path is not a regular file: ${rawPath}`);
  }
  return relative;
}

function resolveManifestPath(vaultRoot: string, relativePath: string): string {
  return path.resolve(fs.realpathSync(vaultRoot), ...relativePath.split("/"));
}

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
