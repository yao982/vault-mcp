# Contributing

欢迎提供可复现的安装失败、页码错误和检索失败案例。请先搜索已有 issue；公开样例必须有再分发许可，不要上传私人知识库或本地索引。

```sh
npm ci
npm test
npm run test:package
npm run models:prepare
npm run test:integration
```

普通回归不下载模型。真实模型测试单独执行，不能把 mock 测试当作模型效果验证。PR 说明具体触发条件、修复后的行为与实际运行的验证。

适合第一次贡献的工作：补充一种 PDF 版式的失败样例及许可说明；改进一个已复现的 doctor 修复提示；记录在 macOS/Linux/Windows 上的真实安装体验；改进中英文文档中无法按步骤完成的地方。

评测题已在运行前冻结。不能为提高分数修改留出题；标注错误需要新版本与勘误。对比必须使用同一批提取文本，并说明模型、硬件、失败及无法运行的部分。

Architecture: `cli.ts` and `server.ts` share `app.ts`; write operations acquire the per-vault lock before opening/migrating SQLite. Parsers retain source coordinates; embedding profiles carry model and preprocessing metadata. Keep these boundaries when adding features. UI, automatic OCR, reranking and shared services require evidence from actual user needs before expanding scope.
