#!/usr/bin/env node
// Download only the explicitly licensed, checksum-pinned publisher PDFs.
// --verify performs no network requests and never rewrites annotations.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const directory = path.dirname(fileURLToPath(import.meta.url));
const corpus = path.join(directory, 'corpus');
const run = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = text => text.replace(/\s+/gu, ' ').trim();
const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify');
let proxy;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--verify') continue;
  if (args[i] === '--proxy' && args[i + 1]) {
    proxy = new URL(args[++i]);
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Proxy must use HTTP or HTTPS.');
    continue;
  }
  throw new Error('Usage: node benchmarks/fetch-corpus.mjs [--verify] [--proxy URL]');
}

const manifest = JSON.parse(await fs.readFile(path.join(corpus, 'manifest.json'), 'utf8'));
const freeze = JSON.parse(await fs.readFile(path.join(corpus, 'questions-freeze.json'), 'utf8'));
const questionBytes = await fs.readFile(path.join(directory, 'questions.json'));
if (digest(questionBytes) !== freeze.sha256) throw new Error('Frozen questions.json SHA-256 mismatch. Do not repair this by silently changing the freeze record.');
const annotations = JSON.parse(questionBytes.toString('utf8'));
const ids = new Set();
const knownPaths = new Set();
const resolved = new Map();

async function download(url) {
  if (proxy) {
    // curl is an optional transport only for users who explicitly request a
    // proxy. No proxy address or credential is saved in this repository.
    const { stdout } = await run('curl', ['--fail', '--location', '--silent', '--show-error',
      '--proto', '=https', '--proto-redir', '=https', '--max-time', '90',
      '--proxy', proxy.href, url], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, windowsHide: true });
    return stdout;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

let totalBytes = 0;
for (const document of manifest.documents) {
  if (!/^papers\/[a-z0-9-]+\.pdf$/.test(document.path)) throw new Error(`Invalid manifest path: ${document.path}`);
  if (ids.has(document.id) || knownPaths.has(document.path)) throw new Error('Duplicate document identity or path.');
  ids.add(document.id);
  knownPaths.add(document.path);
  if (document.license !== 'CC-BY-4.0' || document.licenseUrl !== 'https://creativecommons.org/licenses/by/4.0/') {
    throw new Error(`Unexpected license metadata for ${document.id}`);
  }
  const url = new URL(document.url);
  if (url.protocol !== 'https:' || !['jmlr.org', 'www.jmlr.org'].includes(url.hostname)) throw new Error('Only manifest-pinned official publisher URLs are accepted.');
  const filename = path.join(corpus, document.path);
  let bytes;
  try { bytes = await fs.readFile(filename); }
  catch (error) {
    if (error.code !== 'ENOENT' || verifyOnly) throw error;
    bytes = await download(document.url);
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`Not a PDF: ${document.id}`);
    if (digest(bytes) !== document.sha256) throw new Error(`Publisher PDF changed: ${document.id}; investigate rather than changing the pinned hash.`);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, bytes, { flag: 'wx' });
  }
  if (digest(bytes) !== document.sha256) throw new Error(`Checksum mismatch: ${document.path}; existing files are never overwritten.`);
  totalBytes += bytes.byteLength;
  resolved.set(document.path, bytes);
  console.log(`SHA-256 OK ${document.path}`);
}

// PDF.js is the same extractor family used by the application. The verifier
// accepts whitespace folding only: no fuzzy match, translation or dehyphenation.
const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
const texts = new Map();
let totalPages = 0;
for (const document of manifest.documents) {
  const task = getDocument({ data: new Uint8Array(resolved.get(document.path)), useSystemFonts: true, isEvalSupported: false });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      pages.push(normalize(content.items.filter(item => 'str' in item).map(item => item.str).join(' ')));
    }
    if (!pages[0].includes('License: CC-BY 4.0')) throw new Error(`Missing first-page license declaration: ${document.id}`);
    totalPages += pdf.numPages;
    texts.set(document.path, pages);
  } finally { await task.destroy(); }
}

const seen = new Set();
const owners = new Map();
const counts = { dev: { answerable: 0, unanswerable: 0 }, test: { answerable: 0, unanswerable: 0 } };
let crossLanguage = 0;
for (const question of annotations.questions) {
  if (seen.has(question.id)) throw new Error(`Duplicate question id: ${question.id}`);
  seen.add(question.id);
  if (!(question.split in counts)) throw new Error(`Invalid split: ${question.id}`);
  counts[question.split][question.answerable ? 'answerable' : 'unanswerable']++;
  if (question.answerable && question.crossLanguage) crossLanguage++;
  if (question.answerable !== (question.evidence.length > 0)) throw new Error(`Evidence/answerability mismatch: ${question.id}`);
  for (const evidence of question.evidence) {
    const pages = texts.get(evidence.path);
    if (!pages || !Number.isInteger(evidence.page) || evidence.page < 1 || evidence.page > pages.length) throw new Error(`Invalid evidence page: ${question.id}`);
    const quote = normalize(evidence.quote);
    if (!quote || !pages[evidence.page - 1].includes(quote)) throw new Error(`Quote not found verbatim on annotated physical page: ${question.id}`);
    const owner = owners.get(evidence.path);
    if (owner && owner !== question.split) throw new Error(`Paper leaks across dev/test: ${evidence.path}`);
    owners.set(evidence.path, question.split);
  }
}
if (annotations.version !== 1 || annotations.frozenAt !== freeze.frozenAt ||
    annotations.questions.length !== 50 || owners.size !== 10 || crossLanguage !== 40 ||
    counts.dev.answerable !== 20 || counts.test.answerable !== 20 ||
    counts.dev.unanswerable !== 5 || counts.test.unanswerable !== 5) throw new Error('Frozen benchmark count/split mismatch.');
console.log(JSON.stringify({ documents: ids.size, pages: totalPages, bytes: totalBytes,
  questionSha256: freeze.sha256, questions: 50, verbatimEvidenceChecks: 40,
  crossLanguageAnswerable: crossLanguage, split: counts }, null, 2));
