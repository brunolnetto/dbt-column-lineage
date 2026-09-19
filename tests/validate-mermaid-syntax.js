#!/usr/bin/env node
/**
 * Sanity check for the diagrams the extension renders.
 *
 * Loads the exact mermaid.min.js bundled under media/ (the same file the
 * webview loads) and runs its parser against every .mmd fixture, or against
 * any .mmd file paths passed on the command line. This doesn't validate
 * layout/rendering (that needs a real browser — jsdom has no SVG layout
 * engine), but it does catch a malformed diagram before it ships, which is
 * the failure mode most likely if column_lineage.py's mermaid output format
 * ever changes.
 *
 * Usage:
 *   node tests/validate-mermaid-syntax.js               # checks tests/fixtures/*.mmd
 *   node tests/validate-mermaid-syntax.js some/file.mmd  # checks specific files
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const projectRoot = path.join(__dirname, "..");
const mermaidPath = path.join(projectRoot, "media", "mermaid.min.js");

function collectTargets() {
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    return argv;
  }
  const fixturesDir = path.join(__dirname, "fixtures");
  return fs
    .readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".mmd"))
    .map((f) => path.join(fixturesDir, f));
}

async function main() {
  if (!fs.existsSync(mermaidPath)) {
    console.error(`media/mermaid.min.js not found at ${mermaidPath} — did you run npm install?`);
    process.exit(1);
  }

  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { runScripts: "dangerously" });
  const { window } = dom;
  // jsdom has no SVG layout engine (no getBBox), so full rendering can't run
  // here — but structuredClone is a real browser global mermaid needs even
  // just to parse, and jsdom doesn't ship it.
  window.structuredClone = global.structuredClone;
  window.eval(fs.readFileSync(mermaidPath, "utf8"));

  const targets = collectTargets();
  let allOk = true;
  for (const target of targets) {
    const label = path.relative(projectRoot, target);
    try {
      await window.mermaid.parse(fs.readFileSync(target, "utf8"));
      console.log(`ok    ${label}`);
    } catch (err) {
      allOk = false;
      console.error(`FAIL  ${label}: ${err && err.message ? err.message : err}`);
    }
  }

  if (!allOk) {
    process.exit(1);
  }
}

main();
