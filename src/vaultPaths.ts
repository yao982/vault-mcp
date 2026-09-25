import fs from "node:fs";
import path from "node:path";

export const SUPPORTED_EXTS = new Set([
  ".md", ".markdown", ".txt", ".c", ".h", ".cpp", ".py", ".js", ".ts", ".m", ".pdf",
]);
const IGNORED_DIRS = new Set([
  "node_modules", "images", "assets", "_assets", "dist", "build", "slprj", "model",
]);

export function isIgnoredPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some(part =>
    part.startsWith(".") || IGNORED_DIRS.has(part.toLowerCase()));
}

export function isSupportedFile(relativePath: string): boolean {
  return !isIgnoredPath(relativePath) && SUPPORTED_EXTS.has(path.extname(relativePath).toLowerCase());
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("拒绝读取：路径超出知识库目录。");
  }
}

/** Reject traversal first, then verify symlink/junction targets with realpath. */
export function resolveVaultPath(vaultRoot: string, relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || relativePath.includes(":") ||
      path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error("必须提供知识库内的相对路径。");
  }
  const root = fs.realpathSync(vaultRoot);
  const candidate = path.resolve(root, relativePath.replace(/[\\/]/g, path.sep));
  assertInside(root, candidate);
  const resolved = fs.realpathSync(candidate);
  assertInside(root, resolved);
  return resolved;
}

/** The indexer skips links, including links in parent directory components. */
export function hasLinkedComponent(vaultRoot: string, relativePath: string): boolean {
  const root = fs.realpathSync(vaultRoot);
  const candidate = path.resolve(root, relativePath.replace(/[\\/]/g, path.sep));
  assertInside(root, candidate);
  let current = root;
  for (const component of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

export function readVaultFile(vaultRoot: string, relativePath: string, startLine?: number, endLine?: number): string {
  for (const line of [startLine, endLine]) {
    if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) throw new Error("行号必须为正整数。");
  }
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) throw new Error("结束行号不能小于起始行号。");
  const filename = resolveVaultPath(vaultRoot, relativePath);
  if (!fs.statSync(filename).isFile()) throw new Error("指定路径不是普通文件。");
  const lines = fs.readFileSync(filename, "utf8").split(/\r?\n/);
  return lines.slice((startLine ?? 1) - 1, endLine ?? lines.length).join("\n");
}
