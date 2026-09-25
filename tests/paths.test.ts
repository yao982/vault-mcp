import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readVaultFile, resolveVaultPath } from "../src/vaultPaths.js";

const TEMP_PREFIX = "vault-mcp-paths-test-";

function createTempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  t.after(() => removeTempRoot(root));
  return root;
}

function removeTempRoot(root: string): void {
  const absolute = path.resolve(root);
  if (
    path.dirname(absolute) !== path.resolve(os.tmpdir()) ||
    !path.basename(absolute).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Refusing to remove a path outside this test's generated temp directory: ${absolute}`);
  }
  fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("reads the whole file or the requested inclusive 1-based line range", (t) => {
  const base = createTempRoot(t);
  const vault = path.join(base, "vault");
  fs.mkdirSync(vault);
  fs.writeFileSync(path.join(vault, "notes.md"), "one\r\ntwo\nthree\n", "utf8");

  assert.equal(readVaultFile(vault, "notes.md"), "one\ntwo\nthree\n");
  assert.equal(readVaultFile(vault, "notes.md", 2, 3), "two\nthree");
  assert.equal(readVaultFile(vault, "notes.md", 3), "three\n");
  assert.equal(readVaultFile(vault, "notes.md", undefined, 1), "one");
});

test("rejects parent traversal, including Windows-style backslashes", (t) => {
  const base = createTempRoot(t);
  const vault = path.join(base, "vault");
  fs.mkdirSync(vault);

  assert.throws(() => resolveVaultPath(vault, "../outside.txt"), /相对路径|超出知识库/);
  assert.throws(() => resolveVaultPath(vault, "..\\outside.txt"), /相对路径|超出知识库/);
  assert.throws(() => readVaultFile(vault, "sub/../../outside.txt"), /相对路径|超出知识库/);
});

test("rejects native absolute paths and Windows drive or UNC paths", (t) => {
  const base = createTempRoot(t);
  const vault = path.join(base, "vault");
  fs.mkdirSync(vault);

  assert.throws(() => resolveVaultPath(vault, path.join(base, "outside.md")), /相对路径/);
  assert.throws(() => resolveVaultPath(vault, "C:\\outside\\secret.md"), /相对路径/);
  assert.throws(() => resolveVaultPath(vault, "\\\\server\\share\\secret.md"), /相对路径/);
});

test("rejects a Windows junction whose target is outside the vault", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows junction boundary check");
    return;
  }

  const base = createTempRoot(t);
  const vault = path.join(base, "vault");
  const outside = path.join(base, "outside");
  fs.mkdirSync(vault);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.md"), "do not read", "utf8");
  fs.symlinkSync(outside, path.join(vault, "escape"), "junction");

  assert.throws(() => resolveVaultPath(vault, "escape/secret.md"), /超出知识库/);
  assert.throws(() => readVaultFile(vault, "escape\\secret.md"), /超出知识库/);
});

test("rejects invalid line ranges and directories", (t) => {
  const base = createTempRoot(t);
  const vault = path.join(base, "vault");
  fs.mkdirSync(path.join(vault, "folder"), { recursive: true });
  fs.writeFileSync(path.join(vault, "notes.md"), "one\ntwo\n", "utf8");

  assert.throws(() => readVaultFile(vault, "notes.md", 0), /行号必须为正整数/);
  assert.throws(() => readVaultFile(vault, "notes.md", 1.5, 2), /行号必须为正整数/);
  assert.throws(() => readVaultFile(vault, "notes.md", 3, 2), /结束行号不能小于起始行号/);
  assert.throws(() => readVaultFile(vault, "folder"), /不是普通文件/);
});
