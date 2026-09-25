# Vault-MCP 0.2.0

本地知识库 MCP 服务：SQLite 关键词检索、本地向量、RRF 候选排序、大纲分块和 PDF 路径关联。

[English](./README_EN.md) | 简体中文 | [更新记录](./CHANGELOG.md)

Vault-MCP 将 Markdown 笔记、论文转换文本和源代码提供给支持 MCP 的客户端。索引和向量计算在本机完成，不需要云端 Embedding API。**客户端收到的原文片段可能被发送给其使用的云端 AI；本地检索不等于整个问答流程不出设备。**

## 安装与启动

需要 Node.js **>= 22** 及 npm。

```bash
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm install
npm run build
node dist/index.js --path "你的知识库绝对路径"
```

正常使用时由 MCP 客户端启动上述命令；stdio 中的标准输出用于协议，诊断日志写入标准错误。客户端界面及配置文件位置取决于其版本，下面给出通用命令配置示例：

```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "node",
      "args": ["D:/tools/vault-mcp/dist/index.js", "--path", "D:/notes"],
      "env": {
        "VAULT_OFFLINE": "1"
      }
    }
  }
}
```

将两个路径替换为实际绝对路径。示例启用缓存模式；首次需要下载模型时，请先移除 `VAULT_OFFLINE`，允许模型下载并准备缓存。

| 环境变量 | 行为 |
| :--- | :--- |
| `VAULT_EMBEDDINGS=off` | 仅关键词检索，不加载向量模型 |
| `VAULT_OFFLINE=1` | 模型仅使用本地缓存，不下载；缓存缺失时不能提供向量能力 |

默认模型为 `Xenova/bge-small-zh-v1.5`。模型文件、量化形式及附属文件影响下载体积，不承诺固定大小。下载或模型加载失败时仍可使用关键词检索，状态通过 `get_vault_stats` 查看。

## 四个 MCP 工具

| 工具 | 用途 | 参数 |
| :--- | :--- | :--- |
| `ping_vault` | 检查协议连接 | `message` 可选 |
| `get_vault_stats` | 文档、切片、向量数量及索引和模型状态 | 无 |
| `search_vault` | 返回关键词/向量排序的候选片段 | `query`，`limit` 默认 5 |
| `read_vault_file` | 读取知识库内文件或行范围 | `relative_path`，可选 `start_line`、`end_line`，行号从 1 开始 |

服务先连接 MCP，再在后台扫描。**连接成功并不代表索引完成**；初次扫描中结果可能不完整，请先查看状态。读取工具使用真实路径（`realpath`）检查知识库边界，拒绝越界路径和指向库外的符号链接；它不是任意磁盘文件读取接口。

## 检索如何工作

1. **文本与分块**：按 Markdown 标题维护章节路径，保留代码与数学块的完整原文。PDF 只提供关联路径，不提取其文字；扫描面向 Markdown、文本及支持的源代码格式。
2. **关键词**：SQLite FTS5 保存英文词元，并在 `search_text` 中生成汉字单字和相邻双字。例如“液压控制”生成“液、压、控、制”和“液压、压控、控制”。中文多字查询要求对应双字词元共同出现。这是字符级检索，**不是自然语言分词**；共同出现不证明原文中有相同的连续短语或语义。
3. **向量**：原始切片正文 `chunk.content`（保留切片中原有的本节标题）按实际 tokenizer 长度分窗口，不重复拼接祖先标题路径 `headingPath`；标题路径仍参与关键词检索，并作为结果出处显示。每窗使用 CLS 表示并归一化，再按有效 token 数加权聚合、进行 L2 归一化。长段落、代码和公式的尾部也参与计算，不再只取前 512 字符。聚合覆盖全文，但可能稀释局部主题，不保证每个尾部细节都排在前面。
4. **排序**：查询向量与存储向量做余弦比较；RRF 按关键词和向量候选的名次融合。融合分**不是相关概率**；没有相关资料时仍可能返回向量候选。请用路径、行号和 `read_vault_file` 核对原文，再引用结论。

向量检索目前遍历存储的向量，耗时随切片数、硬件和输入长度增长，未承诺固定延迟。SQLite 主数据库位于知识库的 `.vault_index.db`；运行时可能存在 WAL/SHM 辅助文件，模型缓存另存。

## 更新与一致性

从旧版升级时，先停止使用同一知识库的旧服务，再更新代码、执行 `npm install` 和 `npm run build`，最后重启 MCP 客户端。首次启动会自动迁移派生索引并重建旧版本向量，原始资料无需移动或删除；用 `get_vault_stats` 确认索引状态。避免旧版与新版同时写入同一索引数据库。

启动扫描使用内容 hash 和 `INDEX_VERSION` 判断是否复用；启用向量时，还要求向量完整。内容或索引算法变化会重新处理，停机期间删除的文件会在下次扫描时从索引清理。监听器更新新增、修改和删除；同一文件任务串行，写入前确认文件快照，避免旧计算覆盖新内容。实际可检索时间包含监听等待、文件读取和模型推理时间。

同名 PDF 用于辅助查阅，不代表已经验证其内容或论文真实性。`sample_vault` 中的 **66 字节 PDF 是路径关联测试占位文件，不是真实论文**。

## 验证

```bash
npm test
npm run test:integration
npm run build
```

`npm test` 先检查源码和测试的类型，再执行离线回归（含实际 MCP 关键词模式与文件监听）；`npm run test:integration` 使用真实缓存模型，需要事先准备模型缓存；`npm run build` 检查 TypeScript 构建。未运行某一层验证就不能视为该层通过；本次验收记录见 [PROJECT_PLAN.md](./PROJECT_PLAN.md)。入门原理见 [LEARNING_GUIDE.md](./LEARNING_GUIDE.md)。

## 许可证

[MIT License](./LICENSE)
