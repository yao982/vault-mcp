# 🧠 Vault-MCP

<div align="center">

**Local-First, Privacy-Preserving Knowledge Base MCP Server for ChatGPT, Cursor, VS Code, and Claude Desktop**  
*Native MinerU Academic Workflow · Twin PDF Paper Binding · BM25 + Local Vector RRF Hybrid Search · Sub-second Hot Reloading*

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Protocol-Anthropic%20MCP-purple.svg)](https://modelcontextprotocol.io/)
[![ChatGPT Compatible](https://img.shields.io/badge/AI-ChatGPT%20%7C%20Claude%20%7C%20Cursor-orange.svg)](https://openai.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

**English** | [简体中文](./README.md)

</div>

---

## 🌟 Why Vault-MCP?

1. 🌐 **Universal AI Agent Compatibility**: Works seamlessly with **ChatGPT (Desktop/MCP Bridge)**, **Cursor**, **Claude Desktop**, **VS Code (Cline/Roo)**, **Windsurf**, and any MCP-compatible agent!
2. 🔒 **100% Local & Private**: Zero API keys, zero cloud leaks, zero external telemetry.
3. 📄 **Twin-File Paper Binding**: Read MinerU-converted Markdown with intact LaTeX formulas, while **automatically binding the original PDF paper** for one-click reference.
4. 📐 **Syntax & Math Protection**: Chunker never breaks cross-line `$$...$$` LaTeX equations or ` ``` ` code blocks.
5. 🎯 **Industrial RRF Hybrid Search**: Merges **SQLite FTS5 (BM25)** exact keyword matching with **Local ONNX Vector Embeddings (BGE-small)**.
6. ⚡ **Sub-second Incremental Hot-Reload**: Automatically re-indexes single files in < 100ms when you hit `Ctrl + S` in Obsidian or your editor.

---

## 🚀 Quick Start

### 1. Clone & Build

```bash
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm install
npm run build
```

### 2. Configure in ChatGPT / Cursor / Claude Desktop

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "node",
      "args": [
        "D:/projects/vault-mcp/dist/index.js",
        "--path",
        "D:/Notes/MyObsidianVault"
      ]
    }
  }
}
```

---

## 📄 License

Distributed under the [MIT License](./LICENSE).
