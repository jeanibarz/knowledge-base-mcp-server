import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

import { MCP_TOOL_SPECS } from './mcp-tool-specs.js';
import { MCP_TOOLS_REFERENCE_PATH, renderMcpToolsMarkdown } from './mcp-tools-doc.js';

// The rendering is pure (it takes the specs as an argument and does no I/O or
// build import), so the drift gate can be exercised directly against the
// in-source MCP_TOOL_SPECS — no `npm run build` required for this test.
function readCommittedDoc(): string {
  return fs.readFileSync(path.join(process.cwd(), MCP_TOOLS_REFERENCE_PATH), 'utf8');
}

describe('docs/reference/mcp-tools.md drift gate', () => {
  it('the committed doc matches what the generator renders from the registry', () => {
    expect(renderMcpToolsMarkdown(MCP_TOOL_SPECS)).toBe(readCommittedDoc());
  });

  it('detects drift when a tool description changes (the check would fail)', () => {
    const committed = readCommittedDoc();
    const mutated = MCP_TOOL_SPECS.map((spec, index) =>
      index === 0 ? { ...spec, description: `${spec.description} (drifted)` } : spec,
    );
    const rendered = renderMcpToolsMarkdown(mutated);
    expect(rendered).not.toBe(committed);
    expect(rendered).toContain('(drifted)');
  });

  it('detects drift when an input-schema bound changes', () => {
    const baseline = renderMcpToolsMarkdown(MCP_TOOL_SPECS);
    const askSpec = MCP_TOOL_SPECS.find((spec) => spec.name === 'ask_knowledge');
    expect(askSpec?.inputShape).toBeDefined();
    // Tighten ask_knowledge.k from max 50 to max 10; the constraint text must change.
    const mutated = MCP_TOOL_SPECS.map((spec) =>
      spec.name === 'ask_knowledge'
        ? {
            ...spec,
            inputShape: {
              ...askSpec!.inputShape,
              k: z.number().int().min(1).max(10).optional(),
            },
          }
        : spec,
    );
    const rendered = renderMcpToolsMarkdown(mutated);
    expect(rendered).not.toBe(baseline);
    expect(rendered).toContain('max 10');
  });

  it('renders every registered tool and flags ingest-gated ones', () => {
    const markdown = renderMcpToolsMarkdown(MCP_TOOL_SPECS);
    for (const spec of MCP_TOOL_SPECS) {
      expect(markdown).toContain(`## \`${spec.name}\``);
    }
    // Numeric bounds from the Zod schemas are surfaced verbatim.
    expect(markdown).toContain('max 5'); // context_window / context_before / context_after
    expect(markdown).toContain('max 50'); // ask_knowledge.k
    // Ingest-gated tools carry the gating note.
    expect(markdown).toContain('Only registered when `KB_INGEST_ENABLED` is set.');
  });
});
