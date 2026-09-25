import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireVaultLock,
  inspectVaultLock,
  recoverVaultLock,
  VAULT_LOCK_FILENAME,
} from "../src/runtime/lock.js";

const TEMP_PREFIX = "vault-mcp-lock-test-";

function createTempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  t.after(() => {
    const absolute = path.resolve(root);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
        !path.basename(absolute).startsWith(TEMP_PREFIX)) {
      throw new Error(`Refusing to remove a path outside this test's generated temp directory: ${absolute}`);
    }
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

function staleOwner(overrides: Partial<{ pid: number; host: string; token: string; createdAt: string }> = {}) {
  return {
    pid: 2_000_000_000,
    host: os.hostname(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

test("acquires exclusively, reports the owner, and releases only its own token", (t) => {
  const root = createTempRoot(t);
  const handle = acquireVaultLock(root);
  try {
    const status = inspectVaultLock(root);
    assert.equal(status.state, "active");
    assert.equal(status.owner?.pid, process.pid);
    assert.equal(status.owner?.host, os.hostname());
    assert.match(status.owner?.token ?? "", /^[0-9a-f-]{36}$/i);
    assert.ok(status.owner?.createdAt);
    assert.throws(() => acquireVaultLock(root), /already locked/);
  } finally {
    handle.release();
  }
  handle.release();
  assert.equal(inspectVaultLock(root).state, "unlocked");
});

test("mutual exclusion works across processes and normal process exit releases the lock", { timeout: 5_000 }, (t) => {
  const root = createTempRoot(t);
  const held = acquireVaultLock(root);
  const moduleUrl = new URL("../src/runtime/lock.ts", import.meta.url).href;
  try {
    const competingScript = `
      const { acquireVaultLock } = await import(${JSON.stringify(moduleUrl)});
      try { acquireVaultLock(${JSON.stringify(root)}); process.exitCode = 2; }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    `;
    const competing = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", competingScript], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 4_000,
      windowsHide: true,
    });
    assert.equal(competing.status, 1, competing.stderr || competing.error?.message);
    assert.match(competing.stderr, /already locked/);
  } finally {
    held.release();
  }

  const exitScript = `
    const { acquireVaultLock } = await import(${JSON.stringify(moduleUrl)});
    acquireVaultLock(${JSON.stringify(root)});
    process.stdout.write("child acquired lock\\n");
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", exitScript], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 4_000,
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.match(child.stdout, /child acquired lock/);
  assert.equal(inspectVaultLock(root).state, "unlocked");
  const afterExit = acquireVaultLock(root);
  afterExit.release();
});

test("explicit recovery removes a valid same-host orphan and does not use age alone", (t) => {
  const root = createTempRoot(t);
  const lockPath = path.join(root, VAULT_LOCK_FILENAME);
  const owner = staleOwner({ createdAt: "2001-01-01T00:00:00.000Z" });
  fs.writeFileSync(lockPath, JSON.stringify(owner), { encoding: "utf8", flag: "wx" });

  assert.equal(inspectVaultLock(root).state, "stale");
  const result = recoverVaultLock(root);
  assert.equal(result.state, "recovered");
  assert.equal(result.owner?.token, owner.token);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(inspectVaultLock(root).state, "unlocked");
});

test("recovery refuses active, foreign-host, or corrupt lock metadata", (t) => {
  const root = createTempRoot(t);
  const lockPath = path.join(root, VAULT_LOCK_FILENAME);
  const activeOwner = staleOwner({
    pid: process.pid,
    host: os.hostname(),
    createdAt: "2001-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(lockPath, JSON.stringify(activeOwner), { encoding: "utf8", flag: "wx" });
  assert.equal(inspectVaultLock(root).state, "active");
  assert.equal(recoverVaultLock(root).state, "active");
  assert.equal(fs.existsSync(lockPath), true);

  fs.rmSync(lockPath);
  const foreignOwner = staleOwner({ host: "another-host.invalid" });
  fs.writeFileSync(lockPath, JSON.stringify(foreignOwner), { encoding: "utf8", flag: "wx" });
  assert.equal(inspectVaultLock(root).state, "unverifiable");
  assert.equal(recoverVaultLock(root).state, "unverifiable");
  assert.equal(fs.existsSync(lockPath), true);

  fs.writeFileSync(lockPath, "{ damaged", "utf8");
  assert.equal(inspectVaultLock(root).state, "corrupt");
  assert.equal(recoverVaultLock(root).state, "corrupt");
  assert.throws(() => acquireVaultLock(root), /damaged|invalid|unresolved/i);
  assert.equal(fs.readFileSync(lockPath, "utf8"), "{ damaged");
});

test("reports an existing recovery marker without removing or following it", (t) => {
  const root = createTempRoot(t);
  const recoveryPath = `${path.join(root, VAULT_LOCK_FILENAME)}.recovery`;
  fs.writeFileSync(recoveryPath, "operator review needed", { encoding: "utf8", flag: "wx" });

  assert.equal(inspectVaultLock(root).state, "recovery-in-progress");
  assert.throws(() => acquireVaultLock(root), /recovery is in progress/);
  assert.equal(recoverVaultLock(root).state, "recovery-in-progress");
  assert.equal(fs.readFileSync(recoveryPath, "utf8"), "operator review needed");
});

test("canonicalizes a symlinked vault root so aliases share the same lock boundary", (t) => {
  const base = createTempRoot(t);
  const root = path.join(base, "vault");
  const alias = path.join(base, "vault-alias");
  fs.mkdirSync(root);
  fs.symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");

  const handle = acquireVaultLock(root);
  try {
    assert.equal(inspectVaultLock(alias).state, "active");
    assert.throws(() => acquireVaultLock(alias), /already locked/);
  } finally {
    handle.release();
  }
  assert.equal(inspectVaultLock(alias).state, "unlocked");
});

test("refuses a lock symlink that points outside the canonical vault", (t) => {
  const base = createTempRoot(t);
  const root = path.join(base, "vault");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, "sentinel.txt");
  fs.writeFileSync(sentinel, "outside data", "utf8");
  const lockPath = path.join(root, VAULT_LOCK_FILENAME);
  fs.symlinkSync(outside, lockPath, process.platform === "win32" ? "junction" : "dir");

  assert.equal(inspectVaultLock(root).state, "unsafe");
  assert.throws(() => acquireVaultLock(root), /regular file|unresolved/);
  assert.equal(recoverVaultLock(root).state, "unsafe");
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside data");
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
});
