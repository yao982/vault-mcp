/** Record actual CLI stdout/stderr as asciicast v2, plus a dependency-free player. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('..', import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-demo-'));
const output = path.join(root, 'docs/demo');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.join(temp, 'papers'));
fs.copyFileSync(path.join(root, 'sample_vault/papers/gpflow.pdf'), path.join(temp, 'papers/gpflow.pdf'));
const events = [];
const commands = [];
const start = performance.now();
const elapsed = () => (performance.now() - start) / 1000;
const clean = text => {
  for (const [original, replacement] of [[temp, './demo-vault'], [root, '<project>/'], [os.homedir(), '<user-home>']]) {
    text = text.replaceAll(JSON.stringify(original).slice(1, -1), replacement).replaceAll(original, replacement).replaceAll(original.replaceAll('\\', '/'), replacement);
  }
  return text.replace(/\r?\n/g, '\r\n');
};
const emit = text => events.push([Number(elapsed().toFixed(3)), 'o', clean(text)]);
async function command(args) {
  const display = `vault-mcp ${args.map(a => /[\s？]/u.test(a) ? JSON.stringify(a) : a).join(' ')} --path ./demo-vault --offline`;
  emit(`\n$ ${display}\n`);
  const before = elapsed();
  let stdout = '', stderr = '';
  const child = spawn(process.execPath, [path.join(root, 'dist/index.js'), ...args, '--path', temp, '--offline'], {
    cwd: root, env: { ...process.env, VAULT_OFFLINE: '1', VAULT_EMBEDDINGS: 'on' }, windowsHide: true,
  });
  child.stdout.on('data', bytes => { stdout += bytes; emit(bytes.toString()); });
  child.stderr.on('data', bytes => { stderr += bytes; emit(bytes.toString()); });
  const exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  commands.push({ command: display, exitCode, durationSeconds: elapsed() - before, stdout: clean(stdout), stderr: clean(stderr) });
  assert.equal(exitCode, 0, stderr);
  if (args[0] === 'search' && args[1].includes('核心计算')) assert.match(stdout, /papers\/gpflow\.pdf \| 第 2 页/);
  if (args[0] === 'search' && args[1] === 'GPflow 变分推断') {
    assert.match(stdout, /notes\/gpflow_reading\.md/);
    assert.match(stdout, /papers\/gpflow\.pdf/);
  }
}
const pauseUntil = async seconds => {
  const delay = seconds * 1000 - (performance.now() - start);
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
};
try {
  emit('Vault-MCP preview | Real CLI recording | GPflow paper (CC BY 4.0)\nModel cache already prepared; download time is excluded.\n');
  await command(['index']);
  await pauseUntil(10);
  await command(['search', 'GPflow 与 GPy 的核心计算依赖有什么不同？', '--limit', '2']);
  await pauseUntil(25);
  await command(['read', 'papers/gpflow.pdf', '--start-page', '2', '--end-page', '2']);
  await pauseUntil(40);
  fs.mkdirSync(path.join(temp, 'notes'));
  fs.copyFileSync(path.join(root, 'sample_vault/notes/gpflow_reading.md'), path.join(temp, 'notes/gpflow_reading.md'));
  emit('\n[Added the project-authored Chinese reading note; PDF and personal note remain independent sources.]\n');
  await command(['index']);
  await command(['search', 'GPflow 变分推断', '--limit', '5']);
  await pauseUntil(60);
  emit('\nDone. Check the cited physical page in the original PDF. Candidates are not guaranteed answers.\n');
  const header = { version: 2, width: 110, height: 32, timestamp: Math.floor(Date.now() / 1000), title: 'Vault-MCP real research demo', env: { TERM: 'xterm-256color', SHELL: 'node' } };
  fs.writeFileSync(path.join(output, 'research.cast'), [header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n');
  fs.writeFileSync(path.join(output, 'commands.json'), JSON.stringify({ recordedAt: new Date().toISOString(), note: 'Actual process output and wall time. Deliberate reading pauses; model cache prepared. Generated local paths are redacted. Search candidates and scores are unchanged.', commands }, null, 2) + '\n');
  const encoded = JSON.stringify(events).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vault-MCP · recorded CLI demo</title><style>body{margin:0;background:#101820;color:#e2efef;font:16px system-ui}main{max-width:1100px;margin:36px auto;padding:24px}button{background:#bce5c1;border:0;border-radius:6px;padding:12px 24px;font:inherit;cursor:pointer}pre{height:68vh;overflow:auto;background:#071116;padding:22px;white-space:pre-wrap;font:14px/1.55 Consolas,monospace;border:1px solid #33505b;border-radius:8px}a{color:#bce5c1}small{color:#b0c4c8}</style><main><h1>Vault-MCP · 真实命令行记录</h1><p>中文查英文论文 → 核对物理页码 → 联合查找中文笔记</p><p><button id="play">播放 / Replay</button> <button id="all">查看完整输出 / Full output</button> <small>60 秒，缓存模型；安装与首次下载不计入。</small></p><pre id="terminal" aria-live="polite"></pre><p><a href="https://github.com/yao982/vault-mcp/blob/main/docs/DEMO.md">复现步骤</a> · <a href="https://github.com/yao982/vault-mcp/blob/main/docs/demo/research.cast">asciicast v2</a> · <a href="https://github.com/yao982/vault-mcp/blob/main/docs/demo/commands.json">完整原始输出</a></p></main><script>const events=${encoded};let timer;const terminal=document.querySelector('#terminal');document.querySelector('#play').onclick=()=>{clearInterval(timer);terminal.textContent='';const start=performance.now();let i=0;timer=setInterval(()=>{while(i<events.length&&events[i][0]<=(performance.now()-start)/1000){terminal.textContent+=events[i++][2];terminal.scrollTop=terminal.scrollHeight}if(i===events.length)clearInterval(timer)},40)};document.querySelector('#all').onclick=()=>{clearInterval(timer);terminal.textContent=events.map(e=>e[2]).join('')};terminal.textContent='点击播放，或查看未删减的真实输出。';</script></html>`;
  fs.writeFileSync(path.join(output, 'index.html'), html);
  console.log(`Recorded ${commands.length} actual CLI commands to docs/demo/`);
} finally {
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
