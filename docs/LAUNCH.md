# 预览版发布文案

## 中文

我做了一个面向科研学习者的本地资料检索工具 Vault-MCP：用中文问题查中英文 PDF、阅读笔记和代码，结果保留物理页码或行号，可以回到原文核对。支持 MCP 和命令行，不需要 Python、Docker 或 GPU。

现在发布 v0.3.0-preview.1，欢迎参与首批公开试用。重点想知道：能否照文档独立安装、第一次检索是否找到有用证据、页码是否准确，以及在哪一步卡住。

我提供了真实论文示例、冻结的 50 问评测、可复现命令和失败案例；现阶段还没有可靠的无答案拒答能力，扫描件需要外部 OCR。试用反馈会决定下一步做什么。

项目：https://github.com/yao982/vault-mcp

演示：[一分钟记录](DEMO.md) · 结果：[范围与失败](BENCHMARK_RESULTS.md) · [试用说明](TRYOUT.md)

## English

Vault-MCP is a local research retrieval tool for Chinese questions over Chinese and English papers, personal notes and code. It returns physical PDF pages or text line ranges so you can verify the source. Use it through MCP or the CLI; normal use needs no Python, Docker or GPU.

The v0.3.0-preview.1 release is open for early feedback. Can you install it from the docs, find useful evidence without help, and confirm the cited page? Where does the workflow break?

The repository includes a real-paper sample, a frozen 50-question evaluation, reproduction commands and failure cases. This preview does not offer calibrated no-answer rejection; scans need external OCR. Real trial results will determine the next features.

Repository: https://github.com/yao982/vault-mcp

These drafts are prepared for the maintainer to post in relevant communities. No private messages have been sent on the maintainer's behalf.
