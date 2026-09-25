# 🧠 Vault-MCP

<div align="center">

**面向 ChatGPT / Cursor / VS Code / Claude Desktop 的本地隐私优先知识库 MCP 服务器**  
*原生适配 MinerU 学术工作流 · 双生 PDF 论文自动绑定 · BM25 + 本地向量 RRF 混合检索 · 毫秒级热重载*

[![TypeScript](https://img.shields.io/badge/Language-TypeScript-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Protocol-Anthropic%20MCP-purple.svg)](https://modelcontextprotocol.io/)
[![ChatGPT Compatible](https://img.shields.io/badge/AI-ChatGPT%20%7C%20Claude%20%7C%20Cursor-orange.svg)](https://openai.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

[English](./README_EN.md) | **简体中文**

</div>

---

## 🌟 为什么选择 Vault-MCP？

在日常科研学习与软件开发中，我们积累了海量的私有笔记、学术论文与代码仓库。现有的知识库方案往往面临三大痛点：
1. **云端泄露隐患**：商业 SaaS 知识库需要把未发表的论文草稿与私人笔记上传至云端；
2. **部署过于笨重**：传统本地 RAG 工具动辄需要 Docker 启动 PostgreSQL、Milvus 等全家桶，占用大量内存；
3. **传统 PDF 提取惨不忍睹**：普通程序直接读取 PDF 会导致双栏文字错乱、数学公式变成乱码。

**Vault-MCP 专为解决上述痛点而生：**
* 🌐 **全生态 Agent 通用**：遵循通用 MCP 标准协议，**ChatGPT (Desktop/MCP Bridge)**、**Cursor**、**Claude Desktop**、**VS Code (Cline/Roo)**、**Windsurf** 等全生态 AI 助手随插即用！
* 🔒 **100% 纯本地离线**：零 API Key 需求，零云端调用，单文件 SQLite 持久化，保护隐私。
* 📖 **首创“双生文件智能绑定 (Twin-File Binding)”**：针对科研人员阅读原版 PDF、同时使用 MinerU 转换高质量 Markdown 的习惯，AI 在检索笔记切片的同时，**自动提供原版论文 PDF 的本地直达路径**！
* 📐 **数学公式与代码块保护**：智能切片器严格保护 `$$...$$` 跨行 LaTeX 公式与 ` ``` ` 代码块，绝不在核心逻辑处横腰截断。
* 🎯 **工业级 RRF 混合检索**：结合 **SQLite FTS5 (BM25 算法)** 的精准关键词匹配与 **纯本地神经向量模型 (BGE-small)** 的语义理解，跨越自然语言与专业术语的鸿沟。
* ⚡ **实时增量热重载**：内置文件变动监听，在 Obsidian / 编辑器中按 `Ctrl + S` 保存后，**100 毫秒内自动完成增量向量计算**，无须重启服务。

---

## 🛠️ 核心架构

```
+---------------------------------------------------------------------------------+
|                   AI 客户端 (ChatGPT / Cursor / VS Code / Claude Desktop)       |
+---------------------------------------------------------------------------------+
                                        |  标准输入输出 (stdio 管道)
                                        |  JSON-RPC 2.0 (MCP 规范)
+---------------------------------------v-----------------------------------------+
|                                   Vault-MCP                                     |
|                                                                                 |
|  [1. MCP 工具交互层]                                                            |
|      - search_vault (混合检索学术论文、笔记与代码，附带 PDF 链接)                 |
|      - read_vault_file (读取文件指定行上下文)                                    |
|      - get_vault_stats (查看文档数、切片数、向量数统计)                          |
|      - ping_vault (连通性自检)                                                  |
|                                                                                 |
|  [2. 工业级 RRF 混合检索路由]                                                   |
|      ├── 关键词引擎: SQLite FTS5 (BM25 算法) ───────┐                           |
|      │                                              ├──> RRF 倒数排名加权融合    |
|      └── 语义向量引擎: bge-small-zh 本地余弦相似度 ─┘                           |
|                                                                                 |
|  [3. 文本解析与双生绑定管道]                                                    |
|      ├── Markdown Chunker (识别 #/## 大纲层级，保护 $$...$$ 公式与 ``` 代码块)  |
|      └── Twin-File Binder (自动检测匹配同名原版 .pdf 论文)                       |
|                                                                                 |
|  [4. 存储与动态更新层]                                                          |
|      ├── SQLite (.vault_index.db: 仅数十 KB 单文件持久化)                       |
|      └── Chokidar File Watcher (监听文件保存与删除，毫秒级热更)                  |
+---------------------------------------------------------------------------------+
```

---

## 🚀 极速配置指南

### 1. 克隆与构建

```bash
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm install
npm run build
```

### 2. 客户端配置

#### 🤖 在 ChatGPT / OpenAI Agent 中使用
通过标准 MCP 适配网关（如 `mcp-proxy` 或 ChatGPT 桌面客户端开发者模式）：
```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "node",
      "args": ["D:/projects/vault-mcp/dist/index.js", "--path", "D:/Notes/MyVault"]
    }
  }
}
```

#### 💻 在 Cursor / VS Code (Cline 插件) 中使用
打开设置 ➔ **Features** ➔ **MCP Servers**，添加命令：
```bash
node "D:/projects/vault-mcp/dist/index.js" --path "D:/Notes/MyVault"
```

#### 💬 在 Claude Desktop 中使用
在 `%APPDATA%\Claude\claude_desktop_config.json` 中添加配置即可随插即用。

---

## 💬 实际使用效果

在 ChatGPT 或 Cursor 中提问，AI 会自动按需调用你的本地知识库：

> **用户**：*“我那篇 Transformer 论文里提到的 Multi-Head Attention 计算公式是怎样的？”*
>
> **AI（自动调用 search_vault）**：  
> 根据你的笔记《Attention Is All You Need》：  
> Multi-Head Attention 是通过投影把查询、键和值映射到不同的子空间中：
> $$ \text{MultiHead}(Q, K, V) = \text{Concat}(\text{head}_1, \dots, \text{head}_h)W^O $$  
> 📌 **来源切片**：`papers/attention_is_all_you_need.md` (L19-L25)  
> 📖 **原始论文 PDF**：`papers/attention_is_all_you_need.pdf`（点击在本地阅读器一键打开）

---

## 🧰 提供的 MCP 工具清单

| 工具名称 | 功能描述 | 核心参数 |
| :--- | :--- | :--- |
| `search_vault` | 基于 BM25 + 向量语义的混合检索，返回匹配切片、大纲面包屑与双生 PDF 路径 | `query` (搜索问题), `limit` (默认 5) |
| `read_vault_file` | 查看指定文件的完整原文或指定行范围 | `relative_path` (文件路径), `start_line`, `end_line` |
| `get_vault_stats` | 获取知识库当前状态（文档数、切片数、向量数、数据库体积） | 无 |
| `ping_vault` | 服务连接状态自检问候 | `message` (可选问候语) |

---

## 📄 开源许可证

本项目采用 [MIT License](./LICENSE) 协议开源。
