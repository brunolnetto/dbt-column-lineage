/**
 * Ports column_lineage.py's build_graph/to_mermaid/to_dot into TypeScript so
 * the webview can attach click handlers per node. The JSON tree from the
 * script already carries a ready-to-render `display` label and `file_path`
 * per node (computed against the manifest in Python), so this module is a
 * pure renderer — it never re-reads the manifest itself.
 */

export interface LineageNodeJson {
  node: string;
  column: string;
  display: string;
  reason?: string;
  file_path?: string;
  children?: LineageNodeJson[];
}

export type NodeCategory = "source" | "model" | "issue" | "cycle";

export interface FlatNode {
  nid: string;
  display: string;
  column: string;
  reason?: string;
  filePath?: string;
  category: NodeCategory;
}

export interface FlatGraph {
  nodes: Map<string, FlatNode>;
  edges: Array<[string, string]>;
  rootIds: Set<string>;
}

const ISSUE_REASONS = new Set([
  "no-compiled-sql (run `dbt compile`)",
  "relation-not-in-manifest",
  "max-depth-exceeded",
  "non-table-expression (literal/computed)",
  "terminal-select (no upstream columns found)",
]);

function nodeId(n: LineageNodeJson): string {
  return `${n.node}\u241f${n.column}`;
}

function categoryOf(n: LineageNodeJson): NodeCategory {
  if (n.reason === "raw-source") return "source";
  if (n.reason === "cycle-detected") return "cycle";
  if (n.reason && (ISSUE_REASONS.has(n.reason) || n.reason.startsWith("sqlglot-parse-error"))) return "issue";
  return "model";
}

/** Same dedup-by-id walk as Python's build_graph: a node reached via two
 * branches (the diamond case) collapses into one graph node with two
 * incoming edges; a real cycle renders as an edge back onto an
 * already-drawn node instead of recursing forever. */
export function flattenGraph(roots: LineageNodeJson[]): FlatGraph {
  const nodes = new Map<string, FlatNode>();
  const edges: Array<[string, string]> = [];
  const edgeSet = new Set<string>();
  const expanded = new Set<string>();
  const rootIds = new Set<string>();

  function walk(n: LineageNodeJson): void {
    const nid = nodeId(n);
    if (!nodes.has(nid)) {
      nodes.set(nid, {
        nid,
        display: n.display,
        column: n.column,
        reason: n.reason,
        filePath: n.file_path,
        category: categoryOf(n),
      });
    }
    if (expanded.has(nid)) return;
    expanded.add(nid);
    for (const child of n.children ?? []) {
      const cid = nodeId(child);
      const key = `${nid}\u0000${cid}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push([nid, cid]);
      }
      walk(child);
    }
  }

  for (const root of roots) {
    rootIds.add(nodeId(root));
    walk(root);
  }
  return { nodes, edges, rootIds };
}

/** Builds every unique file the flattened graph references, for the
 * webview's click-to-open handler (keyed by nid, the same id used in the
 * dot output's node ids and, indirectly via aliasToNid, in mermaid's). */
export function fileByNid(graph: FlatGraph): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [nid, node] of graph.nodes) {
    if (node.filePath) map[nid] = node.filePath;
  }
  return map;
}

const SHAPE_BY_CATEGORY: Record<NodeCategory, [string, string]> = {
  source: ["([", "])"],
  issue: ["{{", "}}"],
  cycle: ["{{", "}}"],
  model: ["[", "]"],
};
const CLASS_BY_CATEGORY: Record<NodeCategory, string> = { source: "src", issue: "issue", cycle: "cyc", model: "mdl" };

export function toMermaid(graph: FlatGraph): { diagram: string; aliasToNid: Record<string, string> } {
  const aliasToNid: Record<string, string> = {};
  const nidToAlias = new Map<string, string>();
  let i = 0;
  for (const nid of graph.nodes.keys()) {
    const alias = `n${i++}`;
    aliasToNid[alias] = nid;
    nidToAlias.set(nid, alias);
  }

  const lines: string[] = ["flowchart LR"];
  const byClass: Record<string, string[]> = {};

  for (const [nid, node] of graph.nodes) {
    const alias = nidToAlias.get(nid)!;
    const [open, close] = SHAPE_BY_CATEGORY[node.category];
    const label = (`${node.display}.${node.column}` + (node.reason ? `<br/>[${node.reason}]` : "")).replace(
      /"/g,
      "'"
    );
    lines.push(`  ${alias}${open}"${label}"${close}`);
    if (node.filePath) {
      lines.push(`  click ${alias} call lineageNodeClick("${alias}")`);
    }
    (byClass[CLASS_BY_CATEGORY[node.category]] ??= []).push(alias);
    if (graph.rootIds.has(nid)) {
      (byClass["root"] ??= []).push(alias);
    }
  }
  for (const [src, dst] of graph.edges) {
    // Reversed vs. internal edge order (target depends-on ancestor): draw
    // ancestor -> descendant so flowchart LR reads source-on-the-left,
    // matching how a data pipeline is conventionally drawn.
    lines.push(`  ${nidToAlias.get(dst)} --> ${nidToAlias.get(src)}`);
  }
  lines.push("  classDef src fill:#cfe8ff,stroke:#5b9bd5,color:#0b3550");
  lines.push("  classDef issue fill:#fff3cd,stroke:#d4a017,color:#4a3800");
  lines.push("  classDef cyc fill:#ffd6d6,stroke:#cc4444,color:#5a1010");
  lines.push("  classDef mdl fill:#f2f2f2,stroke:#999999,color:#1a1a1a");
  lines.push("  classDef root stroke-width:3px");
  for (const [cls, ids] of Object.entries(byClass)) {
    lines.push(`  class ${ids.join(",")} ${cls}`);
  }

  return { diagram: lines.join("\n"), aliasToNid };
}

function dotEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const DOT_STYLE_BY_CATEGORY: Record<NodeCategory, string> = {
  source: 'style=filled, fillcolor="#cfe8ff"',
  issue: 'style=filled, fillcolor="#fff3cd"',
  cycle: 'style=filled, fillcolor="#ffd6d6", peripheries=2',
  model: 'style=filled, fillcolor="#f2f2f2"',
};

/** dot node ids ARE the nid (unlike mermaid's synthetic n0,n1,...) since dot
 * has no character-set restriction on quoted ids — Graphviz preserves them
 * verbatim in the rendered SVG's <title>, which is how the webview recovers
 * which file a clicked node belongs to without a side-channel map. */
export function toDot(graph: FlatGraph, title = "lineage"): string {
  const lines = [
    `digraph "${dotEscape(title)}" {`,
    "  rankdir=LR;",
    '  node [shape=box, fontname="Helvetica", fontsize=10];',
  ];
  for (const [nid, node] of graph.nodes) {
    let style = DOT_STYLE_BY_CATEGORY[node.category];
    if (graph.rootIds.has(nid)) style += ", penwidth=2";
    let label = dotEscape(`${node.display}.${node.column}`);
    if (node.reason) label += `\\n[${dotEscape(node.reason)}]`;
    lines.push(`  "${dotEscape(nid)}" [label="${label}", ${style}];`);
  }
  for (const [src, dst] of graph.edges) {
    // Same reversal as toMermaid: ancestor -> descendant for a left-to-right,
    // source-on-the-left reading order.
    lines.push(`  "${dotEscape(dst)}" -> "${dotEscape(src)}";`);
  }
  lines.push("}");
  return lines.join("\n");
}
