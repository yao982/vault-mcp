/** Reproducible retrieval evaluation. Run after npm run build. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { VaultApp } from '../dist/app.js';
import { extractPdfPages } from '../dist/parser/pdf.js';
const base = path.dirname(fileURLToPath(import.meta.url));
const norm = text => text.replace(/\s+/g, ' ').trim();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const questionBytes = fs.readFileSync(path.join(base, 'questions.json'));
const freeze = JSON.parse(fs.readFileSync(path.join(base, 'corpus/questions-freeze.json')));
if (sha(questionBytes) !== freeze.sha256) throw new Error('Frozen questions changed. Create a new benchmark version with an erratum.');
const { questions } = JSON.parse(questionBytes);
const manifest = JSON.parse(fs.readFileSync(path.join(base, 'corpus/manifest.json')));
const profile = process.argv.includes('--bge') ? 'bge-small-zh' : 'multilingual-e5-small';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-research-benchmark-'));
const resultsDir = path.join(base, 'results');
fs.mkdirSync(resultsDir, { recursive: true });
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 20);
let app;
try {
  for (const directory of ['papers', 'notes', 'code']) {
    const source = path.join(base, 'corpus', directory);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(temp, directory), { recursive: true });
  }
  const extracted = new Map();
  const extractionStart = performance.now();
  for (const document of manifest.documents) {
    const bytes = fs.readFileSync(path.join(temp, document.path));
    if (sha(bytes) !== document.sha256) throw new Error(`Corpus hash mismatch: ${document.path}`);
    extracted.set(document.path, await extractPdfPages(new Uint8Array(bytes)));
  }
  const extractionMs = performance.now() - extractionStart;
  const evidenceChecks = questions.flatMap(q => q.evidence.map(e => ({ question: q.id, path: e.path, page: e.page,
    valid: norm(extracted.get(e.path)?.pages.find(p => p.page === e.page)?.text ?? '').includes(norm(e.quote)) })));
  if (evidenceChecks.some(check => !check.valid)) throw new Error(`Invalid gold evidence: ${JSON.stringify(evidenceChecks.filter(c => !c.valid))}`);
  app = new VaultApp(temp, { writable: true, profile });
  const modelStart = performance.now();
  await app.embedding.init(); // Fail loudly; an embedding benchmark must never silently become BM25.
  const modelLoadMs = performance.now() - modelStart;
  const indexStart = performance.now();
  const indexing = await app.indexer.indexAll();
  const indexMs = performance.now() - indexStart;
  if (indexing.failedFiles) throw new Error(`Indexing failed: ${JSON.stringify(indexing)}`);
  const stats = app.stats();
  if (stats.totalVectors !== stats.totalChunks) throw new Error('Incomplete vectors; semantic evaluation would be misleading.');
  const rows = [];
  let checkedCitations = 0;
  for (const q of questions) {
    const embedStart = performance.now();
    const vector = await app.embedding.getEmbedding(q.question, 'query');
    const embeddingMs = performance.now() - embedStart;
    for (const mode of ['bm25', 'vector', 'hybrid']) {
      const start = performance.now();
      const candidates = mode === 'bm25' ? app.db.searchBM25(q.question, 5)
        : mode === 'vector' ? app.db.searchVector(vector, 5) : app.db.searchHybrid(q.question, vector, 5);
      const retrievalMs = performance.now() - start;
      // A hit requires the annotated passage in the returned candidate, on its actual physical page.
      const rank = candidates.findIndex(c => q.evidence.some(e => c.relativePath === e.path
        && c.pageStart <= e.page && c.pageEnd >= e.page && norm(c.content).includes(norm(e.quote))));
      for (const c of candidates.filter(c => c.sourceType === 'pdf')) {
        const original = extracted.get(c.relativePath)?.pages.filter(p => p.page >= c.pageStart && p.page <= c.pageEnd).map(p => p.text).join(' ');
        if (!original || !norm(original).includes(norm(c.content))) throw new Error(`Citation did not resolve: ${c.citationId}`);
        checkedCitations++;
      }
      rows.push({ id: q.id, split: q.split, question: q.question, answerable: q.answerable, crossLanguage: q.crossLanguage,
        mode, hitAt5: q.answerable ? rank >= 0 : null, reciprocalRank: q.answerable && rank >= 0 ? 1 / (rank + 1) : 0,
        embeddingMs: mode === 'bm25' ? 0 : embeddingMs, retrievalMs,
        humanRelevance: q.answerable ? undefined : 'pending-independent-human-review', candidates });
    }
  }
  const summaries = [];
  for (const split of ['dev', 'test']) for (const mode of ['bm25', 'vector', 'hybrid']) {
    const answerable = rows.filter(r => r.split === split && r.mode === mode && r.answerable);
    const cross = answerable.filter(r => r.crossLanguage);
    summaries.push({ split, mode, answerable: answerable.length, hits: answerable.filter(r => r.hitAt5).length,
      hitAt5: answerable.filter(r => r.hitAt5).length / answerable.length,
      mrrAt5: answerable.reduce((sum, r) => sum + r.reciprocalRank, 0) / answerable.length,
      crossLanguageCount: cross.length, crossLanguageHitAt5: cross.filter(r => r.hitAt5).length / cross.length });
  }
  const result = { timestamp: new Date().toISOString(), questionsSha256: freeze.sha256,
    hardware: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramBytes: os.totalmem(), node: process.version },
    profile: app.embedding.getStatus(), configuration: { topK: 5, hybrid: 'RRF k=60, 2*k candidates per branch', pdfParser: 'pdfjs-dist@6.3.289', pooling: profile === 'multilingual-e5-small' ? 'mean' : 'cls', normalized: true },
    timings: { extractionMs, modelLoadMs, indexMs, peakRssBytes: Math.max(peakRss, process.memoryUsage().rss) },
    stats: { documents: stats.totalDocuments, chunks: stats.totalChunks, vectors: stats.totalVectors },
    citationValidation: { goldEvidence: evidenceChecks.length, validGoldEvidence: evidenceChecks.filter(c => c.valid).length, checkedCandidates: checkedCitations, failed: 0 },
    summaries, rows, limitations: ['10 short JMLR software papers; this is not a benchmark of all research disciplines.', 'No-answer relevance still requires independent human review.', 'Warm model query timing; installation/model download excluded.'] };
  // Local absolute paths are intentionally omitted from the public artifact.
  delete result.profile.cacheDir;
  const output = path.join(resultsDir, `${profile}.json`);
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, summaries, timings: result.timings, citations: result.citationValidation }, null, 2));
} finally {
  clearInterval(sampler);
  await app?.close();
  if (path.dirname(temp) !== fs.realpathSync(os.tmpdir()) && path.dirname(temp) !== path.resolve(os.tmpdir())) throw new Error('Unsafe temp cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
