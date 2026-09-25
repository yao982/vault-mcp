# 一分钟真实演示

演示使用未修改的 GPflow 官方论文（CC BY 4.0）和项目编写的中文阅读笔记，不使用私人资料。模型缓存预先准备；安装与首次模型下载不计入这一分钟。

- [打开自带播放器](demo/index.html)：将仓库下载后在浏览器打开此 HTML；GitHub 文件页面本身不会执行它。
- [直接下载单文件播放器](https://github.com/yao982/vault-mcp/releases/download/v0.3.0-preview.1/research-demo.html)：下载后打开即可播放，不依赖网络脚本。
- [终端录制 research.cast](demo/research.cast)：asciicast v2，保留实际输出和时间戳。
- [所有命令、退出码与原始输出](demo/commands.json)：没有剪裁或改写搜索结果。

三个固定案例：

1. **中文检索英文论文**：先仅索引 `papers/gpflow.pdf`，查询“GPflow 与 GPy 的核心计算依赖有什么不同？”。
2. **原文页码核对**：读取 PDF 物理第 2 页；在 PDF 阅读器中打开同一页核对 TensorFlow 与 numeric Python 的原话。
3. **论文与笔记联合查找**：加入 `notes/gpflow_reading.md`，重新索引，再查询“GPflow 变分推断”。论文与笔记作为独立来源返回。

复现录制：

```sh
npm ci --ignore-scripts
npm run models:prepare
node scripts/record-demo.mjs
```

脚本在系统临时目录创建独立示例库，并在完成后清理；不会写入个人知识库。录制包含为阅读输出保留的停顿，运行耗时可查看 `commands.json`。这是一条具体成功流程，其他问题可能失败；参见[完整评测与失败案例](BENCHMARK_RESULTS.md)。

English: the recording uses a licensed real paper and a project-authored reading note. It records actual CLI output, includes reading pauses, and excludes first-time model download. Open the standalone HTML player locally or replay the asciicast v2 file. No private vault is used.
