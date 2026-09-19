import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { execFile, ExecFileException } from "child_process";
import { LineageNodeJson } from "./lineageGraph";
import { LineageTreeProvider } from "./treeView";
import { buildWebviewHtml, DiagramFormat } from "./webview";
import { ModelIndex } from "./modelIndex";

let currentPanel: vscode.WebviewPanel | undefined;
let currentExtensionUri: vscode.Uri;
const treeProvider = new LineageTreeProvider();
let modelIndex: ModelIndex | undefined;

export function activate(context: vscode.ExtensionContext): void {
  currentExtensionUri = context.extensionUri;
  context.subscriptions.push(
    vscode.commands.registerCommand("dbtLineage.traceColumn", () => traceColumn(context)),
    vscode.window.registerTreeDataProvider("dbtLineageView", treeProvider)
  );
}

export function deactivate(): void {
  // no-op: the traced subprocess is short-lived and always exits on its own.
}

async function traceColumn(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("dbt Lineage: open a folder (your dbt project) before tracing a column.");
    return;
  }
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const config = vscode.workspace.getConfiguration("dbtLineage");
  const manifestPath = resolveMaybeRelative(config.get<string>("manifestPath", "target/manifest.json"), workspaceRoot);

  const guess = guessModelAndColumn(manifestPath);

  const model = await vscode.window.showInputBox({
    title: "Trace Column Lineage — model",
    prompt: "dbt model name, as declared in the manifest (e.g. mart_api_health)",
    value: guess.model,
    ignoreFocusOut: true,
  });
  if (!model) return;

  const column = await vscode.window.showInputBox({
    title: "Trace Column Lineage — column",
    prompt: `Column of ${model} to trace back to its raw sources`,
    value: model === guess.model ? guess.column : undefined,
    ignoreFocusOut: true,
  });
  if (!column) return;

  await runTrace(context, workspaceFolder, model, column);
}

/** Resolves the active editor's model via the manifest (correct even when
 * the file name doesn't match the model's declared name), falling back to
 * the bare file name if the manifest lookup misses. Column defaults to
 * whatever word the cursor is sitting on — a real but approximate heuristic:
 * it doesn't understand aliasing in the raw (uncompiled) SQL, just the token
 * under the caret. */
function guessModelAndColumn(manifestPath: string): { model?: string; column?: string } {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!doc || doc.languageId !== "sql") return {};

  if (!modelIndex || (modelIndex as any).manifestPath !== manifestPath) {
    modelIndex = new ModelIndex(manifestPath);
  }
  const entry = modelIndex.modelForFile(doc.fileName);
  const model = entry?.name ?? path.basename(doc.fileName, path.extname(doc.fileName));

  const wordRange = editor && doc.getWordRangeAtPosition(editor.selection.active);
  const column = wordRange ? doc.getText(wordRange) : undefined;
  return { model, column };
}

async function runTrace(
  context: vscode.ExtensionContext,
  workspaceFolder: vscode.WorkspaceFolder,
  model: string,
  column: string
): Promise<void> {
  const config = vscode.workspace.getConfiguration("dbtLineage");
  const workspaceRoot = workspaceFolder.uri.fsPath;

  const pythonPath = config.get<string>("pythonPath", "python3");
  const scriptPathSetting = config.get<string>("scriptPath", "");
  const scriptPath = scriptPathSetting
    ? resolveMaybeRelative(scriptPathSetting, workspaceRoot)
    : path.join(context.extensionPath, "scripts", "column_lineage.py");
  const manifestPath = resolveMaybeRelative(config.get<string>("manifestPath", "target/manifest.json"), workspaceRoot);
  const catalogPathSetting = config.get<string>("catalogPath", "");
  const dialect = config.get<string>("dialect", "");
  const diagramFormat = config.get<DiagramFormat>("diagramFormat", "mermaid");

  if (!fs.existsSync(scriptPath)) {
    vscode.window.showErrorMessage(
      `dbt Lineage: column_lineage.py not found at ${scriptPath}. Set dbtLineage.scriptPath, or leave it empty ` +
        `to use the copy bundled with this extension.`
    );
    return;
  }
  if (!fs.existsSync(manifestPath)) {
    vscode.window.showErrorMessage(
      `dbt Lineage: manifest.json not found at ${manifestPath}. Run \`dbt compile\` first, or check ` +
        `dbtLineage.manifestPath.`
    );
    return;
  }

  const args = [scriptPath, model, column, "--manifest", manifestPath, "--format", "json"];
  if (catalogPathSetting) args.push("--catalog", resolveMaybeRelative(catalogPathSetting, workspaceRoot));
  if (dialect) args.push("--dialect", dialect);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Tracing ${model}.${column}…` },
    () =>
      new Promise<void>((resolve) => {
        execFile(
          pythonPath,
          args,
          { cwd: workspaceRoot, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              handleTraceError(error, stderr, pythonPath);
              resolve();
              return;
            }
            if (stderr.trim()) {
              vscode.window.showWarningMessage(`dbt Lineage: ${stderr.trim().split("\n")[0]}`);
            }
            let root: LineageNodeJson;
            try {
              root = JSON.parse(stdout);
            } catch (e) {
              vscode.window.showErrorMessage(`dbt Lineage: couldn't parse the tracer's output: ${e}`);
              resolve();
              return;
            }
            treeProvider.setRoots([root]);
            showLineageDiagram(context, `${model}.${column}`, root, diagramFormat);
            resolve();
          }
        );
      })
  );
}

function handleTraceError(error: ExecFileException, stderr: string, pythonPath: string): void {
  if (error.code === "ENOENT") {
    vscode.window.showErrorMessage(
      `dbt Lineage: couldn't run "${pythonPath}". Check dbtLineage.pythonPath, and that sqlglot is installed ` +
        `(see the bundled scripts/requirements.txt).`
    );
    return;
  }
  const message = stderr.trim() || error.message;
  vscode.window.showErrorMessage(`dbt Lineage: ${message.split("\n")[0]}`);
}

function resolveMaybeRelative(p: string, workspaceRoot: string): string {
  return path.isAbsolute(p) ? p : path.join(workspaceRoot, p);
}

function showLineageDiagram(
  context: vscode.ExtensionContext,
  title: string,
  root: LineageNodeJson,
  format: DiagramFormat
): void {
  if (!currentPanel) {
    currentPanel = vscode.window.createWebviewPanel("dbtLineage", `Lineage: ${title}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      retainContextWhenHidden: true,
    });
    currentPanel.onDidDispose(() => (currentPanel = undefined), null, context.subscriptions);
    currentPanel.webview.onDidReceiveMessage((msg) => {
      if (msg?.command === "openFile" && typeof msg.filePath === "string") {
        vscode.workspace.openTextDocument(msg.filePath).then(
          (doc) => vscode.window.showTextDocument(doc, vscode.ViewColumn.One),
          (err) => vscode.window.showErrorMessage(`dbt Lineage: couldn't open ${msg.filePath}: ${err.message}`)
        );
      }
    });
  } else {
    currentPanel.title = `Lineage: ${title}`;
    currentPanel.reveal(vscode.ViewColumn.Beside);
  }

  currentPanel.webview.html = buildWebviewHtml(currentPanel.webview, currentExtensionUri, title, root, format);
}
