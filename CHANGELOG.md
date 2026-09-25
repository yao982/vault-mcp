# 更新记录 / Changelog

## 0.3.0-preview.1 — 2026-09-25

面向科研学习者的预览版：中文问题检索中英文论文、笔记和代码，返回可核对的原文出处。正式版仍受留出集评测和真实试用门槛约束。

- 统一 CLI：serve、index、search、read、status、doctor；保留旧 `node dist/index.js --path ...` 启动方式，CLI 与四个 MCP 工具共用检索/读取服务。
- 普通 PDF 逐页提取、物理页码、内容版本与引用标识；后台状态、缓存复用、失败保留旧有效结果并标记过期。
- 显式转换 Markdown/页映射导入；同一论文只索引一种正文，个人笔记独立保留；缺少可靠映射时页码未知。
- 新库默认 multilingual-e5-small（384 维、mean、query/passage 前缀），旧库保留 BGE（512 维、CLS）；切换模型重建向量。
- 数据库增量迁移、同库写锁、只读诊断与保守的孤儿锁恢复。
- npm 安装包、依赖 shrinkwrap、Windows/Linux/macOS × Node 22/24 CI、独立真实模型验证。
- 10 篇 CC BY 4.0 真实论文、50 个冻结中文问题、可复现检索和性能评测、公开试用反馈模板。实际运行结果见 [评测报告](docs/BENCHMARK_RESULTS.md)，不把候选措辞作为可靠拒答能力。

升级前停止旧服务。新库推荐 Node 22.13+ 或 24。原始资料保持不变；详见 [升级说明](docs/UPGRADING.md)。

Research preview with a shared CLI/MCP service, native PDF page citations, explicit converted-text imports, multilingual E5 profiles, writer locking, reproducible evaluation and installable release tarballs. Human trials are still pending; this is not the stable 0.3.0 release.

## 0.2.0 — 2026-09-25

本次版本集中修复读取边界、索引一致性和检索可靠性，保留四个 MCP 工具。初版为 `v0.1.0`，本次修复版为 `v0.2.0`；GitHub Release、标签、package、MCP 服务及文档采用一致的版本编号。

### 主要改动

- 读取文件时校验真实路径与行范围，拒绝越界路径和指向库外的链接；索引跳过链接目录。
- 串行处理同一文件的索引任务并复核内容快照，防止旧计算覆盖新内容；清理停机期间删除的记录。
- 使用内容 hash、索引算法版本和向量完整性复用索引，自动迁移旧数据库与重建旧向量。
- 为中文关键词增加汉字单字/双字索引，保留原文与出处。
- 按 tokenizer 实际长度分窗，使用 CLS 表示并按有效 token 数聚合；修复只编码前 512 字符和向量错位问题。
- 共享模型初始化，加入加载失败退避、关键词降级、缓存模式及状态查询。
- MCP 先连接、后台索引；明确区分检索候选、相关概率和是否存在答案。
- 补充回归测试、真实缓存模型集成测试，并修订中英说明及学习指南。

### 升级步骤

1. 使用 Node.js **>= 22**，停止正在使用同一知识库的旧版服务。
2. 更新代码后运行 `npm install` 和 `npm run build`，再重启 MCP 客户端。
3. 首次启动自动迁移派生索引并重建旧向量；通过 `get_vault_stats` 查看进度。原始资料无需移动或删除。
4. 首次下载模型时不设置 `VAULT_OFFLINE=1`；已有缓存可使用该选项。仅需关键词检索时设置 `VAULT_EMBEDDINGS=off`。

### 验证与范围

Windows、Node.js v24.15.0：`npm test` 34/34 通过；`npm run test:integration` 2/2 通过，使用真实本地模型缓存并禁止下载。小型测试集 19/19 正向查询在前 3 条候选中含目标文档，不代表通用准确率。详细证据与未验证范围见 [PROJECT_PLAN.md](./PROJECT_PLAN.md)。

PDF 仍仅关联路径；向量检索仍遍历存储向量；无关查询可能返回候选。完整个人知识库、大规模性能、首次联网下载和其他操作系统尚未验证。

### English summary

This release fixes vault path enforcement, stale indexing writes, offline deletions, vector/chunk alignment, Chinese keyword retrieval, and long-text embedding coverage. It adds index reuse and migration, shared model initialization with retry backoff, keyword-only and cached-model modes, background indexing status, and regression coverage. The four MCP tools remain available.

Stop older servers before upgrading, use Node.js >= 22, install dependencies, rebuild, and restart the client. The derived index migrates automatically. Validation was performed on Windows with Node.js v24.15.0: 34 regression tests and 2 real cached-model integration tests passed. Small-fixture retrieval results are not a general accuracy guarantee. PDFs remain path references; returned passages may be sent to a cloud model by the consuming client.

## 0.1.0 — 2026-09-25

初始版本，提供本地关键词与向量混合检索、Markdown 分块、PDF 路径关联及文件监听。本节记录原始版本；后续安全、一致性和检索修复见 0.2.0。

Initial release with local hybrid retrieval, Markdown chunking, PDF path references, and file watching. See 0.2.0 for subsequent safety, consistency, and retrieval fixes.
