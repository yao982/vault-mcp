# MCP 客户端配置

先在终端完成安装与一次 `index`，再让支持 stdio MCP 的客户端启动服务。以下是通用 JSON 形状；具体设置入口取决于客户端版本。

```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "vault-mcp",
      "args": ["serve", "--path", "/absolute/path/to/your/vault", "--offline"]
    }
  }
}
```

如果桌面应用找不到全局 npm 命令，使用 Node 和安装后 `dist/index.js` 的绝对路径。Windows 的 JSON 路径可以用 `/`：

```json
{
  "mcpServers": {
    "vault-mcp": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["D:/tools/vault-mcp/dist/index.js", "serve", "--path", "D:/research", "--offline"]
    }
  }
}
```

以上路径是示例，替换为实际路径。源码安装和 Release 包安装后的目录不同；可用 `npm root -g` 查全局包目录。首次模型缓存尚未准备时先运行不带 `--offline` 的 `index`；仅需关键词检索时改用 `--no-embeddings`。

同一知识库只允许一个写入服务；不要同时在多个客户端启动。同一服务运行期间可以用 CLI `status`、`search`、`read` 查看。标准输出只用于 MCP 协议，日志在标准错误；不要用包装脚本向标准输出打印启动横幅。

重启方法：在客户端停用该 MCP 连接（或完全退出对应客户端），确认旧服务已退出，再重新启用。更新程序后需重启进程，不能仅重新发起一次工具调用。被异常终止留下的锁先用 `doctor` 检查，不要按文件年龄手动删除。

保留的四工具：`ping_vault`、`get_vault_stats`、`search_vault`、`read_vault_file`。搜索与读取同时提供 `structuredContent` 和可读文本；PDF 使用 `start_page`/`end_page`，文本继续使用 `start_line`/`end_line`。
