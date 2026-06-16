#!/usr/bin/env node
// Generate docs/reference/mcp-tools.md from the MCP tool registry.
//
// The single source of truth is MCP_TOOL_SPECS in src/mcp-tool-specs.ts: each
// entry carries a tool's wire name, its model-facing description, and the Zod
// input shape (the same objects KnowledgeBaseServer.registerTools hands to
// mcp.tool). The pure rendering + Zod introspection lives in src/mcp-tools-doc.ts
// so it can be unit-tested without a build; this script imports the built
// modules, walks the registry, and writes/checks the doc — it never boots the
// server. Reading the registry instead of a hand-maintained list is what lets
// the drift gate catch a newly added tool or a changed bound. Output is
// deterministic (registration order, source field order) so the gate is not
// noisy.
//
// Modes:
//   node scripts/gen-mcp-tools-doc.mjs           # write docs/reference/mcp-tools.md
//   node scripts/gen-mcp-tools-doc.mjs --check   # exit 1 if the committed doc drifts
//
// Mirrors scripts/gen-cli-reference.mjs / scripts/generate-config-reference.mjs.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { MCP_TOOL_SPECS } from '../build/mcp-tool-specs.js';
import { MCP_TOOLS_REFERENCE_PATH, renderMcpToolsMarkdown } from '../build/mcp-tools-doc.js';

export { MCP_TOOLS_REFERENCE_PATH };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function generateMcpToolsMarkdown() {
  return renderMcpToolsMarkdown(MCP_TOOL_SPECS);
}

export async function writeMcpToolsReference({ root = REPO_ROOT } = {}) {
  const target = path.join(root, MCP_TOOLS_REFERENCE_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, generateMcpToolsMarkdown(), 'utf8');
}

export async function checkMcpToolsReference({ root = REPO_ROOT } = {}) {
  const expected = generateMcpToolsMarkdown();
  const target = path.join(root, MCP_TOOLS_REFERENCE_PATH);
  let actual = null;
  try {
    actual = await fs.readFile(target, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: actual === expected, exists: actual !== null };
}

async function main(argv) {
  if (argv.includes('--check')) {
    const { ok, exists } = await checkMcpToolsReference();
    if (!ok) {
      process.stderr.write(
        [
          `${MCP_TOOLS_REFERENCE_PATH} is ${exists ? 'out of date' : 'missing'}.`,
          'Run `npm run docs:gen-mcp-tools` and commit the result.',
          '',
        ].join('\n'),
      );
      process.exitCode = 1;
    }
    return;
  }
  await writeMcpToolsReference();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`gen-mcp-tools-doc: ${err.message}\n`);
    process.exitCode = 1;
  });
}
