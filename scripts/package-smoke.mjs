import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const project = fileURLToPath(new URL('..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-package-smoke-'));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run via npm run test:package so the current npm executable is used.');
function run(executable, args, options = {}) {
  const r = spawnSync(executable, args, { cwd: project, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024, ...options });
  assert.equal(r.status, 0, r.error?.message ?? `${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
try {
  run(process.execPath, [npmCli, 'run', 'build']);
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', scratch]))[0];
  assert.ok(packed.files.some(f => f.path === 'dist/index.js'));
  assert.ok(!packed.files.some(f => /\.db(?:-|$)|\.env|\.lock$|\.cache/.test(f.path)), 'Package must not contain private/runtime data');
  assert.ok(packed.files.some(f => f.path === 'npm-shrinkwrap.json'), 'Published dependency fixes must be carried by npm shrinkwrap');
  const prefix = path.join(scratch, 'install');
  run(process.execPath, [npmCli, 'install', '--prefix', prefix, '--no-audit', '--no-fund', path.join(scratch, packed.filename)]);
  const entry = path.join(prefix, 'node_modules/vault-mcp/dist/index.js');
  const expected = JSON.parse(fs.readFileSync(path.join(project, 'package.json'))).version;
  assert.equal(run(process.execPath, [entry, '--version']).trim(), expected);
  const vault = path.join(scratch, 'vault');
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, 'note.md'), '# Package verification\ninstallcanary 本地科研知识库');
  const env = { ...process.env, VAULT_OFFLINE: '1', VAULT_EMBEDDINGS: 'off' };
  const call = args => JSON.parse(run(process.execPath, [entry, ...args, '--path', vault, '--json'], { env }));
  assert.equal(call(['index']).totalDocuments, 1);
  assert.equal(call(['search', 'installcanary']).results[0].relativePath, 'note.md');
  assert.match(call(['read', 'note.md']).text, /installcanary/);
  assert.equal(call(['status']).embedding.profile, 'multilingual-e5-small');
  // npm's platform-specific executable shim must be present too.
  const bin = path.join(prefix, 'node_modules/.bin', process.platform === 'win32' ? 'vault-mcp.cmd' : 'vault-mcp');
  assert.ok(fs.existsSync(bin));
  console.log(JSON.stringify({ installed: packed.filename, version: expected, platform: process.platform, node: process.version, files: packed.files.length, checks: ['tarball privacy', 'executable shim', 'index', 'search', 'read', 'status'] }, null, 2));
} finally {
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()));
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
