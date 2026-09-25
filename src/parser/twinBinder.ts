import fs from "fs";
import path from "path";

/**
 * 双生文件关联探测器 (Twin-File Binder)
 * 核心功能：当扫描到一个 Markdown 文件时，自动检查是否存在同名的原版 PDF 文件。
 * 
 * 匹配策略：
 * 1. 同级同名探测：例如 papers/attention.md -> papers/attention.pdf
 * 2. 忽略大小写探测：例如 papers/Attention.md -> papers/attention.pdf
 * 3. MinerU 输出目录探测：例如 papers/attention/attention.md -> papers/attention.pdf
 */
export function findTwinPdf(vaultRoot: string, relativeMdPath: string): string | null {
  const fullMdPath = path.join(vaultRoot, relativeMdPath);
  const dir = path.dirname(fullMdPath);
  const ext = path.extname(relativeMdPath);
  const baseName = path.basename(relativeMdPath, ext);

  // 1. 最常见的同级同名探测: paper.md 同目录下是否存在 paper.pdf
  const directPdfPath = path.join(dir, `${baseName}.pdf`);
  if (fs.existsSync(directPdfPath)) {
    return path.relative(vaultRoot, directPdfPath).replace(/\\/g, "/");
  }

  // 2. 检查 MinerU 常见结构：MinerU 经常会把 paper.pdf 解包成 paper/ 目录并在里面生成同名或 index.md
  const parentDir = path.dirname(dir);
  const parentBase = path.basename(dir);
  const parentPdfPath = path.join(parentDir, `${parentBase}.pdf`);
  if (fs.existsSync(parentPdfPath)) {
    return path.relative(vaultRoot, parentPdfPath).replace(/\\/g, "/");
  }

  // 没有找到关联的 PDF
  return null;
}
