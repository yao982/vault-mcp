# Vault-MCP

<div align="center">

**Lightweight Local-First Knowledge Base MCP Server**  
*SQLite BM25 & Local Vector Hybrid Search · Outline-Aware Chunking · Paired PDF Linking · Incremental File Watcher*

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Protocol-Anthropic%20MCP-purple.svg)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**English** | [简体中文](./README.md)

</div>

---

## 📖 Overview

Vault-MCP is a local knowledge base retrieval server built on Anthropic's **Model Context Protocol (MCP)**.

It connects local Markdown notes, academic paper conversions (such as MinerU output), and source code to MCP-compatible AI clients (Cursor, Claude Desktop, VS Code plugins, etc.), offering local-first, privacy-preserving retrieval without external cloud API dependencies.

---

## ⚙️ Key Features

* **100% Local & Offline**: Uses SQLite (FTS5) and local ONNX runtime (`bge-small-zh-v1.5`) for indexing and retrieval. All data resides in a single local `.vault_index.db` file without external API keys.
* **Hybrid Search Strategy**:
  * **Keyword Search**: SQLite FTS5 with the BM25 algorithm for exact terms, identifiers, and function names;
  * **Dense Semantic Vector Search**: Local 512-dimensional embeddings via ONNX to assist with synonyms and natural language phrasing;
  * **RRF Rank Fusion**: Combines rankings using Reciprocal Rank Fusion.
* **Outline-Aware Chunking**: Chunks text by heading levels (`#` / `##`) to preserve breadcrumb context, avoiding splits inside multiline LaTeX math blocks (`$$...$$`) and code blocks (```` ``` ````).
* **Paired PDF Reference**: For workflows where original PDFs are retained alongside Markdown notes, the scanner detects matching `.pdf` files and includes their relative path in search results for reference.
* **Incremental File Watching**: Uses Chokidar to monitor directory changes, re-indexing individual files upon modification and cleaning up indexes upon file removal.

---

## 🚀 Quick Start

### Requirements
* [Node.js](https://nodejs.org/) >= 20.0.0
* npm >= 9.0.0

### Build & Setup

```bash
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm install
npm run build
```

Executable output will be generated at `dist/index.js`.

### Client Configuration

#### Cursor
Under **Settings** ➔ **Features** ➔ **MCP Servers** ➔ **+ Add New MCP Server**:
* **Name**: `vault-mcp`
* **Type**: `command`
* **Command**: 
  ```bash
  node "/path/to/vault-mcp/dist/index.js" --path "/path/to/your/vault"
  ```

#### Claude Desktop
Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "node",
      "args": [
        "/path/to/vault-mcp/dist/index.js",
        "--path",
        "/path/to/your/vault"
      ]
    }
  }
}
```

---

## 🧰 Available MCP Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `search_vault` | Hybrid search combining BM25 and local vector embeddings | `query` (string), `limit` (number, default: 5) |
| `read_vault_file` | Read full or partial content of a specific file | `relative_path` (string), `start_line`, `end_line` |
| `get_vault_stats` | Inspect vault stats (document count, chunk count, vector count, DB size) | None |
| `ping_vault` | Check server connectivity | `message` (optional string) |

---

## ⚠️ Limitations & Considerations

1. **Initial Model Download**: On first run, the local embedding runtime will download ~90MB of quantized ONNX model weights (`bge-small-zh-v1.5`). Once cached locally, it operates fully offline.
2. **Scale Scope**: Vector similarity currently computes in-memory dot products over SQLite-stored embeddings, optimized for personal-to-medium scale vaults (thousands of chunks, typically < 50ms). For massive enterprise callsets (>100k chunks), dedicated vector indexing (e.g. HNSW) would be preferable.
3. **No Direct PDF Parsing**: Raw `.pdf` files are not parsed directly. They serve as companion references to converted Markdown documents. For academic papers, tools like [MinerU](https://github.com/opendatalab/MinerU) are recommended for preliminary conversion.

---

## 📄 License

Licensed under the [MIT License](./LICENSE).
