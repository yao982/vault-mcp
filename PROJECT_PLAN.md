# Vault-MCP: 本地智能知识库 MCP 服务项目规划与进度跟踪

> **项目名称**：`vault-mcp`  
> **定位**：面向 Cursor / VS Code 的轻量级本地知识库检索服务（聚焦 Markdown 笔记与源代码，原生适配 MinerU 学术工作流）  
> **核心协议**：Anthropic Model Context Protocol (MCP)  
> **开发语言**：TypeScript / Node.js (v24+)  
> **存储与检索引擎**：SQLite (FTS5 BM25 全文索引 + 512 维本地向量存储)  
> **AI 语义模型**：`Xenova/bge-small-zh-v1.5` (纯 CPU 本地 ONNX 离线推理，零显存占用)  
> **当前状态**：🎉 **项目研发与开源工程化已全部圆满完成！已具备公开发布至 GitHub 的所有条件。**

---

## 🚦 项目研发全里程碑看板 (All Milestones Completed!)

| 阶段 / 任务模块 | 核心工作内容 | 对应核心代码 | 状态 | 实测验证说明 |
| :--- | :--- | :--- | :---: | :--- |
| **Milestone 1: MCP 基础骨架** | Node.js 与 TS 环境初始化，实现基于 stdio 管道的 MCP 服务握手与基础 Tools | [`src/index.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/index.ts) | ✅ **已完成** | 成功通过 Agent 客户端握手测试，可正常调用 `ping_vault` 和 `get_vault_stats` |
| **Milestone 2: SQLite 存储与大纲切片** | 设计 SQLite 表结构，开发 Markdown 标题感知切片器，保护代码与 LaTeX 公式不被截断 | [`src/storage/db.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/storage/db.ts)<br>[`src/parser/markdown.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/parser/markdown.ts) | ✅ **已完成** | 完成 `sample_vault` 索引，大纲面包屑精准，公式块完好 |
| **Milestone 3: 双生文件智能绑定** | 扫描 Markdown 时自动探测同级同名 `.pdf` 原版论文，并注入关联路径元数据 | [`src/parser/twinBinder.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/parser/twinBinder.ts) | ✅ **已完成** | 检索 MinerU 论文时自动附加原版 PDF 引用路径 |
| **Milestone 4: 本地神经向量引擎** | 引入 `bge-small-zh-v1.5`，切片转 512 维浮点数向量，以二进制 BLOB 存入 SQLite | [`src/storage/embedding.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/storage/embedding.ts) | ✅ **已完成** | 纯 CPU 离线计算，数据库仅 36KB，计算速度毫秒级 |
| **Milestone 5: RRF 工业级混合检索** | 实现倒数排名融合算法（BM25 关键词排名 + 向量余弦相似度排名加权融合） | [`src/storage/db.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/storage/db.ts) | ✅ **已完成** | **通过盲测**：搜索“如何销毁堆中空间”跨越词汇障碍精准定位 `free()` |
| **Milestone 6: 实时文件热重载** | 集成 `chokidar` 监听器，用户保存或新增笔记时 100ms 增量热更新索引，删除文件自动清理 | [`src/watcher/fileWatcher.ts`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/src/watcher/fileWatcher.ts) | ✅ **已完成** | **实测通过**：动态新建量子力学笔记，不到 1 秒内完成热重载并被检索出；删除后自动同步清理 |
| **Milestone 7: 开源工程化与发布** | 编写中英文 README、配置 Git 忽略文件（`.gitignore`）、添加开源 MIT License | [`.gitignore`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/.gitignore)<br>[`LICENSE`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/LICENSE)<br>[`README.md`](file:///D:/yao/scientific%20research%20and%20study/project/vault_mcp/README.md) | ✅ **已完成** | 中英文双语说明、架构拓扑图、快速配置示例齐备 |

---

## 1. 核心架构设计全景图

```
+---------------------------------------------------------------------------------+
|                         AI 客户端 (Cursor / VS Code / Claude Desktop)           |
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

## 2. GitHub 发布前本地自检清单

- [x] TypeScript 代码编译通过，无任何语法与类型警告 (`npm run build`)
- [x] 核心四工具全部通过真实客户端调用测试 (`ping_vault`, `get_vault_stats`, `search_vault`, `read_vault_file`)
- [x] 盲测验证通过（语义向量精准命中无同词笔记）
- [x] 实时文件增量更新与自动清理验证通过
- [x] `.gitignore` 已排查私有数据库与庞大 `node_modules`
- [x] MIT License 已就绪
- [x] 中英文 `README.md` 与 `README_EN.md` 已就绪
