# v0.3.0 preview：公开试用 / Public preview

正在征集首批 5 名科研学习者。目标：至少 4 人仅依据文档独立完成安装和第一次有效检索。**目前没有真实试用结果，不把维护者或自动测试计为真实用户。**

## 十分钟试用

1. 安装 README 指定的 Node.js 和 Release 压缩包，记录系统及 Node 版本。
2. 在自选资料目录运行 `vault-mcp index --path "目录"`；首次会下载模型。分别记录安装用时、模型下载用时、索引用时。
3. 用中文提出一个确实能在某篇英文 PDF 中找到答案的问题，运行 `vault-mcp search "问题" --path "目录"`。
4. 根据结果的物理页码运行 `vault-mcp read "相对路径.pdf" --start-page 2 --end-page 2 --path "目录"`，同时打开 PDF 核对。
5. 尝试联合查找自己的阅读笔记；遇到问题先运行 `doctor`。
6. 到仓库 [New issue](https://github.com/yao982/vault-mcp/issues/new/choose) 选择 **Preview trial / 试用反馈**。可只报告是否成功，不必提交资料原文。

## 反馈字段

- 系统、Node 版本、安装方式；是否需要维护者帮助。
- 安装 / 模型下载 / 索引用时，资料数量和大致切片量。
- 首次有效检索是否成功，页码是否准确；使用普通 PDF 还是扫描件。
- 哪一步卡住；复制报错时删除个人路径、密钥和私有原文。
- 导入状态或出处预览是否存在命令行难以解决的问题；具体任务是什么。
- 可选：你有权公开的样例、问题、期望证据。

## 记录与发布门槛

| 指标 | 当前状态 |
|---|---|
| 真实试用者 | 0 / 5，等待自愿反馈 |
| 独立安装和有效检索 | 0 / 4，尚无结果 |
| 无答案候选人工相关性审阅 | 待独立人工审阅 |
| 正式版 | 未发布；保持预览版 |

不默认采集遥测或上传资料。MCP 客户端可能把检索片段交给它所配置的模型，是否发送到云端由客户端决定。

Only voluntary public feedback is collected. Please report your OS, Node version, installation/model-download/indexing times, whether you found a useful result without help, and whether the cited PDF page was correct. Do not post private documents or secrets. Automated checks are not counted as user trials. The stable release requires at least five real trials and four independent successes, in addition to the published quality gates.
