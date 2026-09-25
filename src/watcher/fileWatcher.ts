import { watch, type FSWatcher } from "chokidar";
import path from "path";
import { VaultIndexer } from "../indexer.js";
import { VaultDatabase } from "../storage/db.js";

const SUPPORTED_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".c",
  ".h",
  ".cpp",
  ".py",
  ".js",
  ".ts",
  ".m"
]);

/**
 * 知识库实时增量监听器 (Vault File Watcher)
 * 
 * 核心特性：
 * 1. 毫秒级感知：监听知识库目录下的文件新增、保存修改与删除事件。
 * 2. 智能防抖 (awaitWriteFinish)：等待编辑器（如 Obsidian / VS Code）完全写入磁盘后再触发，防止读取到锁定或半截文件。
 * 3. 极速增量：单个文件修改只重算该文件的切片与向量，耗时 < 100ms，绝不重复扫描全局。
 * 4. 自动过滤：自动忽略 .pdf 二进制、图片目录（images/）与版本控制目录。
 */
export class VaultFileWatcher {
  private watcher: FSWatcher | null = null;
  private vaultRoot: string;
  private indexer: VaultIndexer;
  private db: VaultDatabase;

  constructor(vaultRoot: string, indexer: VaultIndexer, db: VaultDatabase) {
    this.vaultRoot = vaultRoot;
    this.indexer = indexer;
    this.db = db;
  }

  public start(): void {
    this.watcher = watch(this.vaultRoot, {
      ignored: (filePath: string) => {
        const basename = path.basename(filePath);
        if (basename.startsWith(".") && basename !== ".vault_index.db") return true;
        const ignoredDirs = ["node_modules", ".git", ".obsidian", "images", "assets", "_assets", "dist", "build"];
        if (ignoredDirs.includes(basename.toLowerCase())) return true;
        if (basename.endsWith(".pdf") || basename.endsWith(".png") || basename.endsWith(".jpg") || basename.endsWith(".zip")) {
          return true;
        }
        return false;
      },
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50
      }
    });

    this.watcher.on("add", async (fullPath: string) => {
      const ext = path.extname(fullPath).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) return;
      const relPath = path.relative(this.vaultRoot, fullPath).replace(/\\/g, "/");
      console.error(`>>> [实时监听] 捕获到新增文件: ${relPath}，正在后台计算增量切片与向量...`);
      await this.indexer.indexSingleFile(relPath);
      console.error(`>>> [实时监听] 新文件索引完成: ${relPath}`);
    });

    this.watcher.on("change", async (fullPath: string) => {
      const ext = path.extname(fullPath).toLowerCase();
      if (!SUPPORTED_EXTS.has(ext)) return;
      const relPath = path.relative(this.vaultRoot, fullPath).replace(/\\/g, "/");
      console.error(`>>> [实时监听] 捕获到文件保存修改: ${relPath}，正在执行毫秒级热更新...`);
      await this.indexer.indexSingleFile(relPath);
      console.error(`>>> [实时监听] 热更新完成: ${relPath}`);
    });

    this.watcher.on("unlink", (fullPath: string) => {
      const relPath = path.relative(this.vaultRoot, fullPath).replace(/\\/g, "/");
      console.error(`>>> [实时监听] 捕获到文件移除: ${relPath}，正在同步清理 SQLite 索引...`);
      this.db.deleteDocument(relPath);
      console.error(`>>> [实时监听] 索引同步清理完毕: ${relPath}`);
    });

    console.error(">>> [Vault-MCP] 实时文件增量热重载监听器已激活！");
  }

  public async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
    }
  }
}
