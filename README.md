# Vault-MCP

<div align="center">

**轻量级本地私有知识库 MCP 服务**  
*支持 SQLite BM25 关键词与本地向量混合检索 · 大纲感知分块 · 同名 PDF 路径关联 · 文件增量监听*

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Protocol-Anthropic%20MCP-purple.svg)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[English](./README_EN.md) | **简体中文**

</div>

---

## 📖 项目简介

Vault-MCP 是一个基于 Anthropic **Model Context Protocol (MCP)** 协议构建的本地知识库检索服务。

它旨在帮助开发者和科研工作者将本地的 Markdown 笔记、学术论文整理（如 MinerU 转换产物）和代码文件接入到支持 MCP 协议的 AI 客户端中（如 Cursor、Claude Desktop、VS Code 插件等），实现本地优先、离线可用的私有资料检索。

---

## ⚙️ 核心特性

* **本地离线运行**：利用 SQLite (FTS5) 与本地 ONNX 运行时（`bge-small-zh-v1.5`）完成索引与检索，数据保存在本地单个 `.vault_index.db` 文件中，不依赖第三方云端 Embedding API。
* **混合检索策略 (Hybrid Search)**：
  * **关键词检索**：基于 SQLite FTS5 的 BM25 算法，针对代码函数名、专有名词与精确术语进行匹配；
  * **语义向量检索**：基于 512 维本地向量计算余弦相似度，辅助处理同义词与自然语言提问；
  * **RRF 排序融合**：采用倒数排名融合（Reciprocal Rank Fusion）算法综合两路检索结果。
* **Markdown 大纲感知分块**：按标题层级（`#` / `##`）划分文本切片，维护章节面包屑路径；在切片过程中避免打断多行 LaTeX 数学公式（`$$...$$`）与代码块（```` ``` ````）。
* **同名 PDF 关联引用**：针对习惯保留原版 PDF、同时使用 Markdown 记录笔记或阅读论文的用户，扫描时会自动探测同级同名的 `.pdf` 文件。在返回检索切片时，一并提供原版 PDF 的本地相对路径，便于跳转查阅。
* **增量文件监听**：基于 Chokidar 监听知识库目录。保存或修改文件时执行单文件增量更新，删除文件时同步清理对应索引。

---

## 🛠️ 架构说明

```
+---------------------------------------------------------------------------------+
|                         AI 客户端 (Cursor / Claude Desktop / VS Code 等)        |
+---------------------------------------------------------------------------------+
                                        |  stdio 管道 (JSON-RPC 2.0)
+---------------------------------------v-----------------------------------------+
|                                   Vault-MCP                                     |
|                                                                                 |
|  [MCP 工具层]                                                                   |
|      - search_vault (返回相关切片、大纲路径及关联 PDF 引用)                       |
|      - read_vault_file (查看文件全文或指定行范围)                                 |
|      - get_vault_stats (查看当前知识库索引统计)                                  |
|      - ping_vault (连通性自检)                                                  |
|                                                                                 |
|  [检索模块]                                                                     |
|      - SQLite FTS5 (BM25)  +  本地向量 (bge-small-zh-v1.5 ONNX)                 |
|      - RRF (Reciprocal Rank Fusion) 排名加权融合                                 |
|                                                                                 |
|  [解析与存储]                                                                   |
|      - Markdown 大纲切片器 (保留公式与代码块)                                    |
|      - 同名 PDF 路径探测器                                                      |
|      - 本地持久化: 单一 SQLite 文件 (.vault_index.db)                           |
|      - 文件监听器: Chokidar (增量更新/清理)                                     |
+---------------------------------------------------------------------------------+
```

---

## 🚀 快速上手

### 1. 环境要求
* [Node.js](https://nodejs.org/) >= 20.0.0
* npm >= 9.0.0

### 2. 克隆与构建

```bash
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm install
npm run build
```

构建完成后将在 `dist/` 目录下生成可执行入口 `dist/index.js`。

### 3. 配置到 AI 客户端

将以下配置加入对应客户端的 MCP 配置文件中，并替换 `--path` 为你的本地知识库实际路径：

#### 在 Cursor 中使用
进入 **Settings** ➔ **Features** ➔ **MCP Servers** ➔ **+ Add New MCP Server**：
* **Name**: `vault-mcp`
* **Type**: `command`
* **Command**: 
  ```bash
  node "你的项目路径/dist/index.js" --path "你的知识库目录路径"
  ```

#### 在 Claude Desktop 中使用
在配置文件（Windows: `%APPDATA%\Claude\claude_desktop_config.json`，macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`）中添加：

```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "node",
      "args": [
        "你的项目路径/dist/index.js",
        "--path",
        "你的知识库目录路径"
      ]
    }
  }
}
```

---

## 🧰 提供的 MCP 工具清单

| 工具名称 | 功能描述 | 核心参数 |
| :--- | :--- | :--- |
| `search_vault` | 基于 BM25 与本地向量混合检索相关内容切片 | `query` (检索语句), `limit` (返回数量，默认 5) |
| `read_vault_file` | 查看指定文件的完整原文或指定行范围 | `relative_path` (文件相对路径), `start_line`, `end_line` |
| `get_vault_stats` | 获取知识库当前状态（文档数、切片数、向量数、数据库体积） | 无 |
| `ping_vault` | 服务连接状态自检 | `message` (可选测试文本) |

---

## ⚠️ 局限性与设计边界说明

在选择使用本项目前，请注意以下技术考量：

1. **模型冷启动下载**：首次启动并计算向量时，会从 Hugging Face / 镜像源下载约 90MB 的 ONNX 模型文件（`bge-small-zh-v1.5`），下载完成后保存在本地缓存，之后完全离线运行。
2. **适用数据规模**：当前向量检索是在 SQLite 读取后进行内存余弦点积计算，适合个人及小型团队的中小规模知识库（数千个切片，耗时一般在几十毫秒内）。若知识库规模达到数十万量级以上，建议改用专门的向量索引库（如 HNSW 扩展）。
3. **PDF 不直接解析**：本项目不对 `.pdf` 进行文本提取，主要面向以 Markdown 笔记为主、原版 PDF 作为对照引用的工作流。如果需要解析 PDF，建议配合 [MinerU](https://github.com/opendatalab/MinerU) 等工具先转为 Markdown。

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 开源。
