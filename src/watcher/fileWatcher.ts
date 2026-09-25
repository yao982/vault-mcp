import { watch, type FSWatcher } from "chokidar";
import path from "node:path";
import { VaultIndexer } from "../indexer.js";
import { isIgnoredPath, isSupportedFile } from "../vaultPaths.js";

/** Start watching before scanning, to capture edits during startup. */
export class VaultFileWatcher {
  private watcher: FSWatcher | null = null;
  constructor(private vaultRoot: string, private indexer: VaultIndexer) {}

  public start(): Promise<void> {
    this.watcher = watch(this.vaultRoot, {
      ignored: filename => isIgnoredPath(path.relative(this.vaultRoot, filename)),
      followSymlinks: false,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const update = (filename: string) => {
      const relativePath = path.relative(this.vaultRoot, filename).replace(/\\/g, "/");
      const operation = isSupportedFile(relativePath)
        ? this.indexer.indexSingleFile(relativePath)
        : path.extname(relativePath).toLowerCase() === ".pdf" ? this.indexer.indexAll() : null;
      if (operation) void operation.catch(error => this.indexer.recordError(error));
    };
    this.watcher.on("add", update).on("change", update).on("unlink", update);
    this.watcher.on("error", error => this.indexer.recordError(error));
    return new Promise((resolve, reject) => {
      this.watcher!.once("ready", resolve);
      this.watcher!.once("error", reject);
    });
  }

  public async close(): Promise<void> {
    await this.watcher?.close();
    await this.indexer.drain();
  }
}
