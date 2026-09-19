import * as vscode from "vscode";
import { LineageNodeJson, flattenGraph, fileByNid, toMermaid, toDot } from "./lineageGraph";

export type DiagramFormat = "mermaid" | "dot";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  title: string,
  root: LineageNodeJson,
  format: DiagramFormat
): string {
  const graph = flattenGraph([root]);
  const files = fileByNid(graph);
  const nonce = getNonce();

  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "mermaid.min.js"));
  const graphvizUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "graphviz.mjs"));

  let diagramScript: string;
  if (format === "dot") {
    const dot = toDot(graph, title);
    diagramScript = `
      import { Graphviz } from ${JSON.stringify(graphvizUri.toString())};
      const dotSource = ${JSON.stringify(dot)};
      const filesByNid = ${JSON.stringify(files)};
      const target = document.getElementById("diagram-target");
      Graphviz.load()
        .then((gv) => {
          target.innerHTML = gv.layout(dotSource, "svg", "dot");
          target.querySelectorAll("g.node").forEach((g) => {
            const nid = g.querySelector("title")?.textContent;
            const filePath = nid && filesByNid[nid];
            if (filePath) {
              g.style.cursor = "pointer";
              g.addEventListener("click", () => vscodeApi.postMessage({ command: "openFile", filePath }));
            }
          });
          autoFitZoom();
        })
        .catch((err) => showError(String(err && err.message ? err.message : err)));
    `;
  } else {
    const { diagram, aliasToNid } = toMermaid(graph);
    diagramScript = `
      const diagramSource = ${JSON.stringify(diagram)};
      const aliasToNid = ${JSON.stringify(aliasToNid)};
      const filesByNid = ${JSON.stringify(files)};
      window.lineageNodeClick = function (alias) {
        const nid = aliasToNid[alias];
        const filePath = nid && filesByNid[nid];
        if (filePath) vscodeApi.postMessage({ command: "openFile", filePath });
      };
      document.getElementById("diagram-target").innerHTML = '<pre class="mermaid"></pre>';
      document.querySelector(".mermaid").textContent = diagramSource;
      const vscodeTheme =
        document.body.className.includes("vscode-dark") || document.body.className.includes("vscode-high-contrast")
          ? "dark"
          : "default";
      mermaid.initialize({ startOnLoad: false, theme: vscodeTheme, securityLevel: "loose" });
      mermaid.run({ querySelector: ".mermaid" }).then(autoFitZoom).catch((err) => showError(String(err && err.message ? err.message : err)));
    `;
  }

  const scriptTags =
    format === "dot"
      ? `<script nonce="${nonce}" type="module">${diagramScript}</script>`
      : `<script nonce="${nonce}" src="${mermaidUri}"></script>\n  <script nonce="${nonce}">${diagramScript}</script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval';" />
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    header { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border, transparent); position: sticky; top: 0; background: var(--vscode-editor-background); z-index: 1; }
    header h1 { font-size: 12px; font-weight: 600; margin: 0; font-family: var(--vscode-editor-font-family, monospace); opacity: 0.85; }
    .zoom-controls button { background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-panel-border, #8888); border-radius: 3px; width: 24px; height: 24px; cursor: pointer; font-size: 13px; margin-left: 4px; }
    #diagram-scroll { overflow: auto; height: calc(100vh - 41px); padding: 20px; box-sizing: border-box; }
    #diagram-zoom { transform-origin: top left; transition: transform 0.1s ease-out; width: fit-content; }
    .error-box { margin: 20px; padding: 12px 14px; border-left: 3px solid var(--vscode-errorForeground, #f14c4c); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)} (${format})</h1>
    <div class="zoom-controls">
      <button id="zoom-out" title="Zoom out">−</button>
      <button id="zoom-reset" title="Reset zoom">⟲</button>
      <button id="zoom-in" title="Zoom in">+</button>
    </div>
  </header>
  <div id="diagram-scroll"><div id="diagram-zoom"><div id="diagram-target"></div></div></div>

  <script nonce="${nonce}">
    var vscodeApi = acquireVsCodeApi(); // var (not const): must be visible from the dot path's <script type="module">, which only sees window-attached globals, not classic-script lexical scope
    function showError(msg) {
      document.getElementById("diagram-scroll").innerHTML = '<div class="error-box"></div>';
      document.querySelector(".error-box").textContent = "Could not render the lineage diagram: " + msg;
    }
    let scale = 1;
    let fitScale = 1;
    function applyZoom() { document.getElementById("diagram-zoom").style.transform = "scale(" + scale + ")"; }
    document.getElementById("zoom-in").addEventListener("click", () => { scale = Math.min(scale + 0.15, 3); applyZoom(); });
    document.getElementById("zoom-out").addEventListener("click", () => { scale = Math.max(scale - 0.15, 0.3); applyZoom(); });
    document.getElementById("zoom-reset").addEventListener("click", () => { scale = fitScale; applyZoom(); });
    // Both renderers size their SVG tightly around the diagram's own content,
    // so a small graph (a handful of nodes) renders at a genuinely small
    // pixel size — nothing to do with our zoom control, which started at a
    // flat scale=1 (i.e. exactly that small natural size). Auto-fit once
    // after render so the diagram fills a sensible chunk of the panel by
    // default; the user's own zoom clicks still work normally from there,
    // and "reset" returns to this fitted scale rather than a flat 1.
    function autoFitZoom() {
      const svg = document.querySelector("#diagram-target svg");
      const scroll = document.getElementById("diagram-scroll");
      if (!svg || !scroll) return;
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.maxWidth = "none";
      const box = svg.getBBox ? svg.getBBox() : null;
      const naturalWidth = (box && box.width) || svg.getBoundingClientRect().width || 1;
      const availableWidth = scroll.clientWidth - 40;
      fitScale = Math.min(Math.max(availableWidth / naturalWidth, 0.5), 2.5);
      scale = fitScale;
      applyZoom();
    }
  </script>
  ${scriptTags}
</body>
</html>`;
}
