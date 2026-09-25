# 普通 PDF 与外部转换文本

普通 PDF 由 PDF.js 在后台逐页提取。状态为 `pending`、`extracting`、`ready`、`empty` 或 `failed`；空白页保留物理页序。表格、多栏阅读顺序和公式还原有局限；扫描件不会自动安装或调用 OCR。

页码是从 1 开始的 PDF 物理页，可能和论文印刷页码不同。文件 hash、解析器版本及转换输入未变时复用缓存。提取失败不会覆盖上一份有效文字；保留结果标记 `stale`，需要重新索引并核对当前原文。

已有 MinerU 或其他转换结果时，将 PDF 与 Markdown 放在同一知识库内，显式关联：

```sh
vault-mcp import --path ./my-vault --pdf papers/paper.pdf --markdown converted/paper.md
```

没有页映射时显示“页码未知”，整文可读，按 PDF 页读取会被拒绝。不要从 Markdown 行数推算 PDF 页码。

若转换过程保留了可靠页码，创建 `pages.json`，行号和物理页都从 1 开始：

```json
[
  { "page": 1, "startLine": 1, "endLine": 25 },
  { "page": 2, "startLine": 26, "endLine": 58 }
]
```

```sh
vault-mcp import --path ./my-vault --pdf papers/paper.pdf --markdown converted/paper.md --page-map ./pages.json
```

这些范围应由转换器输出或逐页核对得到。范围不允许重叠；未覆盖的文字保留“页码未知”。CLI 写入根目录 `vault.imports.json`，记录 PDF SHA-256。也可手动管理相同结构：

```json
{
  "version": 1,
  "documents": [{
    "pdf": "papers/paper.pdf",
    "markdown": "converted/paper.md",
    "pages": [{ "page": 1, "startLine": 1, "endLine": 25 }]
  }]
}
```

显式映射使转换 Markdown 成为这一篇论文唯一的索引正文，原 PDF 保留为出处。普通阅读笔记独立索引；同名文件不自动去重。源 PDF 更新后应重新转换并重新执行 `import`。删除映射后运行 `index` 可恢复原生 PDF 提取。

此版本接收经过整理的 Markdown 和页映射，不承诺兼容每个 MinerU 版本的内部 JSON 格式，不会自动运行 MinerU。
