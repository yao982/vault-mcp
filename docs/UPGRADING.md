# 从 0.1 / 0.2 升级

## 运行环境与安装

使用 Node.js 22.14+ 或 24 LTS。SQLite 依赖使用 Node-API 10，其最低 Node 22 版本为 22.14（[Node 官方版本表](https://nodejs.org/api/n-api.html#node-api-version-matrix)）。

Release 安装保留 `npm install -g --ignore-scripts <压缩包 URL>`；源码安装使用 `npm ci --ignore-scripts` 后显式运行 `npm run build`。此版本的依赖自带预编译文件，跳过安装脚本可避免 Windows 上 npm 错误触发 `better-sqlite3` 的 `node-gyp rebuild`，无需额外安装 Python 或 Visual Studio。上游记录：[better-sqlite3 #1516](https://github.com/WiseLibs/better-sqlite3/issues/1516)、[npm #9837](https://github.com/npm/cli/issues/9837)。CI 与独立安装包测试使用同一命令。不要省略可选依赖，它们包含平台原生组件。

Use Node.js 22.14+ or 24 LTS and retain `--ignore-scripts` when installing this preview. Source installs then run `npm run build` explicitly. Bundled prebuilt dependencies are used; do not omit optional dependencies. This avoids the upstream Windows npm/node-gyp issue linked above.

## 迁移步骤

1. 停止所有指向同一知识库的旧 MCP 服务。0.2 及以前没有新写锁，不能识别 0.3 服务正在写入。
2. 如需回退，停止服务后备份 `.vault_index.db` 及存在的 WAL/SHM 辅助文件。原始论文和笔记不需要移动。
3. 安装预览版，然后运行 `vault-mcp index --path "知识库"`。数据库会增量迁移，旧派生向量会重建。
4. 用 `status` / `doctor` 检查配置和提取状态，再由客户端启动 `vault-mcp serve --path "知识库"`。

旧库沿用记录的模型；未记录模型的旧版库按原 BGE 配置迁移。新库默认 `multilingual-e5-small`。显式切换：

```sh
vault-mcp index --path ./my-vault --profile multilingual-e5-small
```

这会使旧向量失效并重建；不同维度和处理方式的向量不会混合比较。切换期间可使用关键词检索。

同库第二个写入命令会报告占用进程。`status`、`search`、`read` 和诊断可只读运行；它们不会替你升级数据库。

异常退出后使用 `vault-mcp doctor --path "目录"` 检查。仅在锁所属主机一致、原进程确认不存在时，`doctor --recover-lock` 才恢复；不会仅凭锁文件年龄删除。不确定状态保留供人工检查。

0.3 索引不保证能被旧版直接读取。回退时先停止服务，保留新数据库副本，再还原升级前备份。不要删除原始资料。
