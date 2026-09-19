import * as vscode from "vscode";
import { LineageNodeJson } from "./lineageGraph";

const ICON_BY_REASON: Record<string, string> = {
  "raw-source": "database",
  "cycle-detected": "sync-ignored",
};
const ISSUE_REASONS = new Set([
  "no-compiled-sql (run `dbt compile`)",
  "relation-not-in-manifest",
  "max-depth-exceeded",
  "non-table-expression (literal/computed)",
  "terminal-select (no upstream columns found)",
]);

class LineageTreeItem extends vscode.TreeItem {
  constructor(public readonly data: LineageNodeJson) {
    const hasChildren = !!data.children?.length;
    super(
      `${data.display}.${data.column}`,
      hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    this.description = data.reason;
    this.tooltip = data.reason ? `${data.display}.${data.column}\n${data.reason}` : `${data.display}.${data.column}`;
    this.iconPath = new vscode.ThemeIcon(this.iconId());
    if (data.file_path) {
      this.command = {
        command: "vscode.open",
        title: "Open",
        arguments: [vscode.Uri.file(data.file_path)],
      };
      this.contextValue = "hasFile";
    }
  }

  private iconId(): string {
    const reason = this.data.reason;
    if (reason && ICON_BY_REASON[reason]) return ICON_BY_REASON[reason];
    if (reason && (ISSUE_REASONS.has(reason) || reason.startsWith("sqlglot-parse-error"))) return "warning";
    return "symbol-field";
  }
}

export class LineageTreeProvider implements vscode.TreeDataProvider<LineageTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private roots: LineageNodeJson[] = [];

  setRoots(roots: LineageNodeJson[]): void {
    this.roots = roots;
    this._onDidChangeTreeData.fire();
  }

  clear(): void {
    this.setRoots([]);
  }

  getTreeItem(element: LineageTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: LineageTreeItem): LineageTreeItem[] {
    const children = element ? element.data.children ?? [] : this.roots;
    return children.map((c) => new LineageTreeItem(c));
  }
}
