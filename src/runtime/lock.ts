import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

export const VAULT_LOCK_FILENAME = ".vault-mcp.lock";

const RECOVERY_SUFFIX = ".recovery";

export type VaultLockState =
  | "unlocked"
  | "active"
  | "stale"
  | "unverifiable"
  | "corrupt"
  | "unsafe"
  | "recovery-in-progress"
  | "recovered";

export interface VaultLockOwner {
  pid: number;
  host: string;
  token: string;
  createdAt: string;
}

export interface VaultLockInspection {
  state: VaultLockState;
  vaultRoot: string;
  lockPath: string;
  owner?: VaultLockOwner;
  message?: string;
}

export interface VaultLockHandle {
  release(): void;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface LockSnapshot {
  owner: VaultLockOwner;
  identity: FileIdentity;
}

function canonicalVaultRoot(vaultRoot: string): string {
  const root = fs.realpathSync(vaultRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error("Vault lock requires a directory root.");
  return root;
}

function lockPathFor(root: string): string {
  return path.join(root, VAULT_LOCK_FILENAME);
}

function recoveryPathFor(lockPath: string): string {
  return `${lockPath}${RECOVERY_SUFFIX}`;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function identity(stat: fs.Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
}

function parseOwner(raw: string): VaultLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<VaultLockOwner>;
    if (
      !Number.isSafeInteger(value.pid) || value.pid === undefined || value.pid < 1 ||
      typeof value.host !== "string" || value.host.length === 0 ||
      typeof value.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.token) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    ) return null;
    return {
      pid: value.pid,
      host: value.host,
      token: value.token,
      createdAt: value.createdAt,
    };
  } catch {
    return null;
  }
}

function readLockSnapshot(root: string): LockSnapshot | null {
  const lockPath = lockPathFor(root);
  let before: fs.Stats;
  try {
    before = fs.lstatSync(lockPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Vault lock path is not a regular file; refusing to follow or remove it.");
  }

  let fd: number | undefined;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) {
      throw new Error("Vault lock changed while it was being inspected.");
    }
    const raw = fs.readFileSync(fd, "utf8");
    const after = fs.lstatSync(lockPath);
    if (after.isSymbolicLink() || !sameIdentity(identity(opened), identity(after))) {
      throw new Error("Vault lock changed while it was being inspected.");
    }
    const owner = parseOwner(raw);
    if (!owner) throw new Error("Vault lock metadata is damaged or invalid.");
    return { owner, identity: identity(after) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inspectAtRoot(root: string): VaultLockInspection {
  const lockPath = lockPathFor(root);
  const base = { vaultRoot: root, lockPath };
  try {
    const snapshot = readLockSnapshot(root);
    if (!snapshot) return { state: "unlocked", ...base };
    const { owner } = snapshot;
    if (owner.host !== os.hostname()) {
      return {
        state: "unverifiable",
        ...base,
        owner,
        message: `Lock belongs to host ${owner.host}; this host cannot verify its process.`,
      };
    }
    try {
      process.kill(owner.pid, 0);
      return {
        state: "active",
        ...base,
        owner,
        message: `Vault is held by PID ${owner.pid} on ${owner.host}.`,
      };
    } catch (error) {
      if (isErrno(error, "ESRCH")) {
        return {
          state: "stale",
          ...base,
          owner,
          message: `Lock PID ${owner.pid} is absent on this host; explicit recovery is required.`,
        };
      }
      return {
        state: "unverifiable",
        ...base,
        owner,
        message: `Cannot confirm whether PID ${owner.pid} is absent (${(error as Error).message}).`,
      };
    }
  } catch (error) {
    const unsafe = (error as Error).message.includes("regular file") ||
      (error as Error).message.includes("changed while");
    return {
      state: unsafe ? "unsafe" : "corrupt",
      ...base,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read-only status inspection; it never follows a lock symlink or removes a lock. */
export function inspectVaultLock(vaultRoot: string): VaultLockInspection {
  const root = canonicalVaultRoot(vaultRoot);
  const status = inspectAtRoot(root);
  const recoveryPath = recoveryPathFor(lockPathFor(root));
  try {
    const recoveryStat = fs.lstatSync(recoveryPath);
    if (recoveryStat.isSymbolicLink() || !recoveryStat.isFile()) {
      return {
        ...status,
        state: "unsafe",
        message: "Vault lock recovery marker is not a regular file; refusing to follow or remove it.",
      };
    }
    return {
      ...status,
      state: "recovery-in-progress",
      message: "A recovery marker exists; it may be active or may require manual inspection.",
    };
  } catch (error) {
    if (isErrno(error, "ENOENT")) return status;
    return {
      ...status,
      state: "unsafe",
      message: `Could not safely inspect the recovery marker: ${error instanceof Error ? error.message : error}`,
    };
  }
}

/** Atomically claim a vault. A live or ambiguous lock is never replaced. */
export function acquireVaultLock(vaultRoot: string): VaultLockHandle {
  const root = canonicalVaultRoot(vaultRoot);
  const lockPath = lockPathFor(root);
  const recoveryPath = recoveryPathFor(lockPath);
  try {
    fs.lstatSync(recoveryPath);
    throw new Error("Vault lock recovery is in progress; retry after it finishes.");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }

  const owner: VaultLockOwner = {
    pid: process.pid,
    host: os.hostname(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let fd: number | undefined;
  try {
    fd = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      const status = inspectAtRoot(root);
      const detail = status.message ?? `Lock state is ${status.state}.`;
      throw new Error(`Vault is already locked or has an unresolved lock: ${detail}`);
    }
    throw error;
  }

  try {
    fs.writeFileSync(fd, JSON.stringify(owner), "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* preserve the write error */ }
    fd = undefined;
    throw new Error(`Could not write vault lock metadata: ${error instanceof Error ? error.message : error}`);
  }
  fs.closeSync(fd);
  fd = undefined;

  let released = false;
  const releaseOwnLock = (): void => {
    if (released) return;
    if (canonicalVaultRoot(vaultRoot) !== root) {
      throw new Error("Vault root changed after lock acquisition; refusing to remove a lock through a different path.");
    }
    const current = readLockSnapshot(root);
    if (!current) {
      released = true;
      return;
    }
    if (current.owner.token !== owner.token) {
      throw new Error("Vault lock token no longer matches this process; refusing to remove another owner's lock.");
    }
    const finalCheck = readLockSnapshot(root);
    if (!finalCheck || finalCheck.owner.token !== owner.token ||
        !sameIdentity(current.identity, finalCheck.identity)) {
      throw new Error("Vault lock changed during release; refusing to remove a replacement lock.");
    }
    fs.unlinkSync(lockPath);
    released = true;
  };
  const exitHandler = () => {
    try { releaseOwnLock(); } catch { /* never turn process exit into an uncaught exception */ }
  };
  process.once("exit", exitHandler);

  return {
    release() {
      try {
        releaseOwnLock();
      } finally {
        process.removeListener("exit", exitHandler);
      }
    },
  };
}

/** Explicitly recover only a valid same-host lock whose recorded PID is absent. */
export function recoverVaultLock(vaultRoot: string): VaultLockInspection {
  const root = canonicalVaultRoot(vaultRoot);
  const lockPath = lockPathFor(root);
  const recoveryPath = recoveryPathFor(lockPath);
  const claim: VaultLockOwner = {
    pid: process.pid,
    host: os.hostname(),
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  let claimFd: number;
  try {
    claimFd = fs.openSync(recoveryPath, "wx", 0o600);
  } catch (error) {
    if (isErrno(error, "EEXIST")) {
      return {
        state: "recovery-in-progress",
        vaultRoot: root,
        lockPath,
        message: "Another lock recovery is active or its recovery marker needs manual inspection.",
      };
    }
    throw error;
  }
  try {
    fs.writeFileSync(claimFd, JSON.stringify(claim), "utf8");
    fs.fsyncSync(claimFd);
  } finally {
    fs.closeSync(claimFd);
  }

  try {
    const initial = inspectAtRoot(root);
    if (initial.state !== "stale" || !initial.owner) return initial;

    const firstSnapshot = readLockSnapshot(root);
    if (!firstSnapshot || firstSnapshot.owner.token !== initial.owner.token) {
      return { ...inspectAtRoot(root), message: "Lock changed before recovery; no lock was removed." };
    }
    const firstClassification = inspectAtRoot(root);
    if (firstClassification.state !== "stale" || firstClassification.owner?.token !== initial.owner.token) {
      return { ...firstClassification, message: "Lock owner could not be reconfirmed; no lock was removed." };
    }

    const finalSnapshot = readLockSnapshot(root);
    if (!finalSnapshot || finalSnapshot.owner.token !== initial.owner.token ||
        !sameIdentity(firstSnapshot.identity, finalSnapshot.identity)) {
      return { ...inspectAtRoot(root), message: "Lock token or file identity changed; no lock was removed." };
    }
    const finalClassification = inspectAtRoot(root);
    if (finalClassification.state !== "stale" || finalClassification.owner?.token !== initial.owner.token) {
      return { ...finalClassification, message: "PID absence could not be reconfirmed; no lock was removed." };
    }

    fs.unlinkSync(lockPath);
    return {
      state: "recovered",
      vaultRoot: root,
      lockPath,
      owner: initial.owner,
      message: `Removed the stale lock for absent PID ${initial.owner.pid} on ${initial.owner.host}.`,
    };
  } finally {
    removeOwnRecoveryClaim(recoveryPath, claim.token);
  }
}

function removeOwnRecoveryClaim(recoveryPath: string, token: string): void {
  let fd: number | undefined;
  try {
    const before = fs.lstatSync(recoveryPath);
    if (before.isSymbolicLink() || !before.isFile()) return;
    fd = fs.openSync(recoveryPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || !sameIdentity(identity(before), identity(opened))) return;
    const value = JSON.parse(fs.readFileSync(fd, "utf8")) as Partial<VaultLockOwner>;
    const after = fs.lstatSync(recoveryPath);
    if (after.isSymbolicLink() || !sameIdentity(identity(opened), identity(after)) || value.token !== token) return;
    fs.closeSync(fd);
    fd = undefined;
    const final = fs.lstatSync(recoveryPath);
    if (!final.isSymbolicLink() && sameIdentity(identity(after), identity(final))) fs.unlinkSync(recoveryPath);
  } catch {
    // Leave an ambiguous marker for an operator rather than deleting it.
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* leave the marker if cleanup is ambiguous */ }
    }
  }
}
