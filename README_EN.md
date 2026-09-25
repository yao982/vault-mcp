# Vault-MCP 0.2.0

A local knowledge base MCP server with SQLite keyword retrieval, local embeddings, RRF candidate ranking, outline-aware chunks, and PDF path references.

English | [简体中文](./README.md) | [Changelog](./CHANGELOG.md)

Vault-MCP exposes Markdown notes, converted paper text, and source code to MCP clients. Indexing and embeddings run locally without a cloud embedding API. **Your client may send returned passages to its cloud AI provider; local retrieval does not make the entire conversation local.**

## Install and start

Requires Node.js **>= 22** and npm.

```bash
git clone https://github.com/yao982/vault-mcp.git
cd vault-mcp
npm install
npm run build
node dist/index.js --path "/absolute/path/to/vault"
```

Normally the MCP client starts this command. Standard output carries the stdio protocol; diagnostics use standard error. Configuration locations and client interfaces vary by client version. A generic command configuration is:

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

Replace both paths with real absolute paths. This example uses cached models only. Remove `VAULT_OFFLINE` when preparing a model cache for the first time so downloading is allowed.

| Environment variable | Behavior |
| :--- | :--- |
| `VAULT_EMBEDDINGS=off` | Keyword retrieval only; no embedding model load |
| `VAULT_OFFLINE=1` | Use local model cache without downloading; missing cache prevents vector functionality |

The default model is `Xenova/bge-small-zh-v1.5`. Download size depends on model files, quantization, and supporting files; no fixed size is promised. Keyword retrieval remains available when downloading or loading fails. Inspect model status through `get_vault_stats`.

## Four MCP tools

| Tool | Purpose | Parameters |
| :--- | :--- | :--- |
| `ping_vault` | Check the protocol connection | Optional `message` |
| `get_vault_stats` | Document/chunk/vector counts and indexing/model status | None |
| `search_vault` | Return keyword/vector retrieval candidates | `query`, `limit` (default 5) |
| `read_vault_file` | Read a vault file or line range | `relative_path`, optional `start_line` and `end_line` (1-based) |

The server connects MCP before scanning in the background. **A successful connection does not mean indexing has finished.** Results may be incomplete during the initial scan; check status first. File reads enforce the vault boundary using resolved real paths (`realpath`), rejecting escapes and symlinks targeting files outside the vault.

## Retrieval behavior

1. **Text and chunks:** Markdown heading paths provide context, while code and math blocks retain their original text. PDFs are references only; their text is not extracted. Scanning covers Markdown, plain text, and supported source code formats.
2. **Keywords:** SQLite FTS5 retains English tokens and adds individual Han characters and adjacent character pairs in `search_text`. For example, “液压控制” produces “液、压、控、制” and “液压、压控、控制”. Multi-character Chinese queries require the corresponding pair tokens together. This is character-based retrieval, **not linguistic word segmentation**. Pair co-occurrence does not establish an exact contiguous phrase or its meaning.
3. **Embeddings:** Original chunk content (`chunk.content`, retaining any section heading already in the chunk) is split into windows using actual tokenizer lengths. Ancestor heading paths (`headingPath`) are not prepended again; they remain part of keyword retrieval and source attribution. Each window uses normalized CLS pooling; vectors are averaged with effective token-count weights and L2-normalized again. The tails of long paragraphs, code, and equations participate instead of stopping at 512 characters. Averaging can dilute local details, so complete input coverage does not guarantee high retrieval rank for every detail.
4. **Ranking:** Query and stored vectors are compared by cosine similarity, then RRF merges keyword and vector ranks. The fusion score **is not a relevance probability**. Vector candidates may appear even when the vault has no relevant answer. Verify their paths, line numbers, and original text with `read_vault_file` before citing conclusions.

Vector retrieval currently scans stored vectors. Latency grows with chunk count and depends on hardware and input length; there is no fixed latency promise. The primary database is `.vault_index.db` inside the vault. WAL/SHM files may exist while it runs, and model caches are stored separately.

## Updates and consistency

To upgrade, stop older servers using the same vault, update the source, run `npm install` and `npm run build`, then restart your MCP client. The first startup migrates the derived index and rebuilds older vectors automatically; source documents do not need to be moved or deleted. Check progress with `get_vault_stats`. Avoid running old and new servers against the same index database at once.

Startup scans use content hashes and `INDEX_VERSION` to decide reuse; when embeddings are enabled, vectors must also be complete. Changed content or index algorithms trigger processing. Files deleted while the server was stopped are removed from the index on the next scan. The watcher handles additions, changes, and deletions; tasks for the same file are serialized and the file snapshot is checked before saving, preventing stale work from overwriting newer content. Update latency includes watcher delays, reads, and inference.

A paired PDF path is a navigation aid, not evidence that its content or authenticity was verified. The **66-byte PDF in `sample_vault` is a path-binding placeholder, not a real paper**.

## Validation

```bash
npm test
npm run test:integration
npm run build
```

`npm test` type-checks source and tests, then runs offline regressions, including actual MCP keyword-mode calls and filesystem watching. `npm run test:integration` uses the real cached model and requires a prepared cache. `npm run build` checks the TypeScript build. An unrun validation layer must not be reported as passed. See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for acceptance records and the Chinese [LEARNING_GUIDE.md](./LEARNING_GUIDE.md) for introductory explanations.

## License

[MIT License](./LICENSE)
