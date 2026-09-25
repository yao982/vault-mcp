# 更新记录 / Changelog

## 0.5.0 — 2026-09-25

本次版本集中修复读取边界、索引一致性和检索可靠性，保留四个 MCP 工具。GitHub 原发布标签为 `v0.4.0`，但其代码版本为 `0.1.0`；本次统一 package、MCP 服务与文档版本为 `0.5.0`，原有标签保持不变。

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
