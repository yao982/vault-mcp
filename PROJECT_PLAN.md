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
| **Milestone 1: MCP 基础骨架** | Node.js 与 TS 环境初始化，实现基于 stdio 管道的 MCP 服务握手与基础 Tools | [`src/index.ts`](./src/index.ts) | ✅ **已完成** | 成功通过 Agent 客户端握手测试，可正常调用 `ping_vault` 和 `get_vault_stats` |
| **Milestone 2: SQLite 存储与大纲切片** | 设计 SQLite 表结构，开发 Markdown 标题感知切片器，保护代码与 LaTeX 公式不被截断 | [`src/storage/db.ts`](./src/storage/db.ts)<br>[`src/parser/markdown.ts`](./src/parser/markdown.ts) | ✅ **已完成** | 完成 `sample_vault` 索引，大纲面包屑精准，公式块完好 |
| **Milestone 3: 双生文件智能绑定** | 扫描 Markdown 时自动探测同级同名 `.pdf` 原版论文，并注入关联路径元数据 | [`src/parser/twinBinder.ts`](./src/parser/twinBinder.ts) | ✅ **已完成** | 检索 MinerU 论文时自动附加原版 PDF 引用路径 |
| **Milestone 4: 本地神经向量引擎** | 引入 `bge-small-zh-v1.5`，切片转 512 维浮点数向量，以二进制 BLOB 存入 SQLite | [`src/storage/embedding.ts`](./src/storage/embedding.ts) | ✅ **已完成** | 纯 CPU 离线计算，数据库仅 36KB，计算速度毫秒级 |
| **Milestone 5: RRF 工业级混合检索** | 实现倒数排名融合算法（BM25 关键词排名 + 向量余弦相似度排名加权融合） | [`src/storage/db.ts`](./src/storage/db.ts) | ✅ **已完成** | **通过盲测**：搜索“如何销毁堆中空间”跨越词汇障碍精准定位 `free()` |
| **Milestone 6: 实时文件热重载** | 集成 `chokidar` 监听器，用户保存或新增笔记时 100ms 增量热更新索引，删除文件自动清理 | [`src/watcher/fileWatcher.ts`](./src/watcher/fileWatcher.ts) | ✅ **已完成** | **实测通过**：动态新建量子力学笔记，不到 1 秒内完成热重载并被检索出；删除后自动同步清理 |
| **Milestone 7: 开源工程化与发布** | 编写中英文 README、配置 Git 忽略文件（`.gitignore`）、添加开源 MIT License | [`.gitignore`](./.gitignore)<br>[`LICENSE`](./LICENSE)<br>[`README.md`](./README.md) | ✅ **已完成** | 中英文双语说明、架构拓扑图、快速配置示例齐备 |

---

## 1. 核心架构设计分层表

| 架构层级 | 核心模块 / 技术 | 职责说明 |
| :--- | :--- | :--- |
| **1. 协议交互层**<br>*(MCP Interface)* | `@modelcontextprotocol/sdk`<br>(stdio 管道 / JSON-RPC 2.0) | 统一对接各类 AI 客户端（Cursor、Claude、VS Code 等），暴露 `search_vault`、`read_vault_file` 等标准接口 |
| **2. 混合检索层**<br>*(Hybrid Search)* | • 关键词：SQLite FTS5 (BM25)<br>• 语义向量：`bge-small-zh-v1.5` (ONNX)<br>• 排序融合：RRF 算法 | 结合精准词频倒排匹配与 512 维向量余弦相似度，避免单一检索方式漏查或不准，加权计算综合排名 |
| **3. 解析与关联层**<br>*(Parser & Binding)* | • Markdown 大纲感知切片器<br>• 双生文件探测器 (`twinBinder`) | 按 `#` 标题层级维护面包屑路径；保护 LaTeX 公式与代码块不被截断；自动检测同名原版 `.pdf` 并附带路径引用 |
| **4. 存储与监听层**<br>*(Storage & Watcher)* | • SQLite (`.vault_index.db`)<br>• Chokidar 文件监听器 | 单文件本地持久化（文本切片 + 二进制 BLOB 向量）；监听文件保存修改与删除事件，实现增量热更新 |

---

## 2. GitHub 发布前本地自检清单

- [x] TypeScript 代码编译通过，无任何语法与类型警告 (`npm run build`)
- [x] 核心四工具全部通过真实客户端调用测试 (`ping_vault`, `get_vault_stats`, `search_vault`, `read_vault_file`)
- [x] 盲测验证通过（语义向量精准命中无同词笔记）
- [x] 实时文件增量更新与自动清理验证通过
- [x] `.gitignore` 已排查私有数据库与庞大 `node_modules`
- [x] MIT License 已就绪
- [x] 中英文 `README.md` 与 `README_EN.md` 已就绪
