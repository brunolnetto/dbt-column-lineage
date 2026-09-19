import * as fs from "fs";
import * as path from "path";

interface ModelEntry {
  uniqueId: string;
  name: string;
}

/** Maps an open .sql file back to its dbt model name by reading manifest.json
 * directly (no subprocess) — this only needs original_file_path, so it's
 * cheap enough to do inline for cursor-based defaults, and is resolved via
 * the manifest's own alias (correct even when the file name doesn't match
 * the model name), not a filename guess. */
export class ModelIndex {
  private byFilePath = new Map<string, ModelEntry>();
  private mtimeMs = -1;

  constructor(private manifestPath: string) {}

  private refresh(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.manifestPath);
    } catch {
      this.byFilePath.clear();
      this.mtimeMs = -1;
      return;
    }
    if (stat.mtimeMs === this.mtimeMs) return;

    this.byFilePath.clear();
    this.mtimeMs = stat.mtimeMs;
    try {
      const manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      const projectRoot = path.dirname(path.dirname(this.manifestPath));
      for (const [uid, node] of Object.entries<any>(manifest.nodes ?? {})) {
        if (node.resource_type !== "model" || !node.original_file_path) continue;
        const abs = path.resolve(projectRoot, node.original_file_path);
        this.byFilePath.set(abs, { uniqueId: uid, name: node.name });
      }
    } catch {
      // Malformed manifest: fail soft here too, same as the Python side —
      // this index is a convenience default, not required for a trace to run.
      this.byFilePath.clear();
    }
  }

  modelForFile(absFilePath: string): ModelEntry | undefined {
    this.refresh();
    return this.byFilePath.get(absFilePath);
  }
}
