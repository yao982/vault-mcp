# Vault-MCP

**让中文问题找到中英文论文、笔记和代码中的证据，并回到原文核对。** 本地运行，MCP + 命令行，面向科研学习者。

[![CI](https://github.com/yao982/vault-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/yao982/vault-mcp/actions/workflows/ci.yml) ![Node](https://img.shields.io/badge/Node-22.14%2B%20%7C%2024-green) ![Platforms](https://img.shields.io/badge/Windows%20%7C%20Linux%20%7C%20macOS-CI-blue)

简体中文 · [English](README_EN.md) · [一分钟真实演示](docs/DEMO.md) · [实测与失败案例](docs/BENCHMARK_RESULTS.md) · [参与试用](docs/TRYOUT.md)

[![真实 CLI 记录：中文提问，返回英文论文第 2 页](docs/demo/preview.svg)](docs/DEMO.md)

**当前为 v0.3.0-preview.1。** 正在公开征集首批 5 名试用者；正式版需达到检索、出处、平台安装和真实试用门槛。Star 是反馈，能否找到可靠证据才是验收标准。

## 一分钟上手

需要 Node.js 22.14+ 或 24 LTS；日常使用不需要 Python、Docker 或 GPU。预览版从 GitHub Release 安装，不依赖 npm 账号：

```sh
npm install -g --ignore-scripts https://github.com/yao982/vault-mcp/releases/download/v0.3.0-preview.1/vault-mcp-0.3.0-preview.1.tgz
vault-mcp index --path "你的资料目录"
vault-mcp search "GPflow 与 GPy 的核心计算依赖有什么不同？" --path "你的资料目录"
```

首次索引会下载本地模型；下载时间单独计算。没有模型也可先用 `index --no-embeddings` 和 `search --mode bm25` 验证安装，但中文问题检索英文资料需要多语言向量能力。

安装命令中的 `--ignore-scripts` 使用依赖自带的预编译文件，避开 npm 在 Windows 上错误触发 SQLite 源码构建的问题；请保留此参数。[安装说明](docs/UPGRADING.md)

还没有适合的资料？仓库附带带许可的真实 GPflow 论文、中文阅读笔记和代码：

```sh
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm ci --ignore-scripts
npm run build
node dist/index.js index --path ./sample_vault
node dist/index.js search "GPflow 与 GPy 的核心计算依赖有什么不同？" --path ./sample_vault
node dist/index.js read papers/gpflow.pdf --start-page 2 --end-page 2 --path ./sample_vault
```

最后一条命令读取 **PDF 物理第 2 页**，其中包含可核对的原文：

> An important difference between GPflow and GPy is that GPflow uses TensorFlow for its core computations rather than numeric Python.

出处：[GPflow 官方论文](https://jmlr.org/papers/volume18/16-537/16-537.pdf)，物理第 2 页，[CC BY 4.0 与署名](sample_vault/ATTRIBUTION.md)。实际搜索结果还包含 `sourceVersion`（源文件 SHA-256）、`citationId`、`pageStart`/`pageEnd`；笔记和代码保留行号。排序分是候选排序依据，不是答案正确率。

## 适合什么场景

- 用中文问题查英文论文，再按页核对原文。
- 同时查论文、自己的中文阅读笔记和实验代码。
- 给 MCP 客户端提供本地证据，也可以直接在终端搜索并输出 JSON。

普通 PDF 直接提取文字。扫描件需先用外部 OCR 转换，再[显式导入 Markdown 和页映射](docs/IMPORTS.md)；没有可靠映射时显示“页码未知”。不会因为同名就把阅读笔记当成论文副本。

## 命令和 MCP

| 命令 | 用途 |
|---|---|
| `serve --path <目录>` | 启动 stdio MCP 服务；省略命令时保持旧启动方式 |
| `index --path <目录>` | 扫描、提取 PDF、增量更新索引 |
| `search "问题" --path <目录>` | 混合检索；支持 `--mode bm25\|vector\|hybrid`、`--limit 5` |
| `read <相对文件> --path <目录>` | 文本用 `--start-line`/`--end-line`；PDF 用 `--start-page`/`--end-page` |
| `status --path <目录>` | 只读统计、PDF 状态和模型配置 |
| `doctor --path <目录>` | 检查环境、权限、缓存、索引和占用，并给出修复指引 |
| `import --pdf … --markdown … --path <目录>` | 显式关联外部转换结果，可加 `--page-map pages.json` |

除 `serve` 外可加 `--json`。MCP 保留四工具及原文本行范围参数，搜索/读取新增结构化结果与 PDF 页码。参见[客户端配置与重启](docs/CLIENTS.md)。

## 本地模型与离线使用

新库默认 **multilingual-e5-small**：384 维，mean pooling，`query: ` / `passage: ` 前缀，归一化。旧库保留 BGE-small-zh：512 维、CLS。长输入按实际 tokenizer 计数分窗，正文 token 加权聚合，窗口包含前缀和特殊 token；不把字符数当 token 数。

```sh
vault-mcp index --path ./my-vault --profile multilingual-e5-small
vault-mcp search "你的问题" --path ./my-vault --offline
vault-mcp doctor --path ./my-vault
```

切换模型使旧向量失效并重建，禁止混合不兼容向量。缓存默认在用户目录 `.cache/vault-mcp/transformers`，可用 `VAULT_MODEL_CACHE` 指定可写目录；兼容读取旧 transformers 缓存。`VAULT_OFFLINE=1` / `--offline` 禁止模型下载；`VAULT_EMBEDDINGS=off` / `--no-embeddings` 使用纯关键词模式。

下载或加载失败会保留关键词候选，并在状态中报告。缓存缺失时离线模式无法凭空提供语义检索。首次下载、缓存状态和环境问题请运行 `doctor`。

## 一致性与边界

每个知识库只有一个写入实例；锁在数据库迁移之前获取。只读命令可与服务并行。崩溃残留锁需 `doctor --recover-lock` 确認原进程已不存在，不按文件年龄删除。[旧版升级步骤](docs/UPGRADING.md)。

PDF 逐页处理，记录等待、处理、完成、无文字和失败。失败保留上次有效结果并标记过期；文件 hash/解析版本控制缓存复用。源文件不被改写，派生数据库位于知识库 `.vault_index.db`。

检索是 SQLite FTS5 关键词 + 本地向量 + RRF。中文关键词使用字/双字词元；向量检索目前全量遍历，规模和延迟见实测。表格、多栏、公式和扫描件都有解析限制；无答案问题仍可能返回候选，不能把提示措辞当作拒答能力。

不默认收集遥测或上传资料。本地检索返回给 MCP 客户端的片段可能被其发送给云模型，取决于客户端配置。

## 评测、贡献和路线

[公开评测](https://github.com/yao982/vault-mcp/blob/main/benchmarks/README.md)：10 篇许可核实的真实论文，50 个冻结中文问题，开发集/留出集按论文分离；关键词、向量、混合与 QMD 使用相同提取文本比较。PDF 页码/段落核验独立于检索评分。[结果、配置、硬件、范围与失败](docs/BENCHMARK_RESULTS.md)。

```sh
npm test
npm run test:package
npm run models:prepare
npm run test:integration
npm run benchmark
npm run benchmark:bge
```

CI 覆盖 Windows、Linux、macOS 的 Node 22/24 构建、回归和安装包；真实模型单独执行，以实际 Actions 结果为准。加入[公开试用](docs/TRYOUT.md)或从[贡献指南](CONTRIBUTING.md)中的小任务开始。

下一步由真实问题驱动：至少 3 位试用者独立遇到 CLI 难以解决的导入状态或出处预览问题，才启动轻量界面；OCR、重排序和共享服务分别依据解析失败、检索失误和多客户端需求决定。

代码 [MIT](LICENSE)；示例论文与评测论文遵循各自 [CC BY 4.0 署名](https://github.com/yao982/vault-mcp/blob/main/benchmarks/corpus/ATTRIBUTION.md)。[更新记录](CHANGELOG.md)保留 0.1、0.2 历史。
