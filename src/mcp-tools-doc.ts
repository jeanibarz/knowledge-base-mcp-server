// mcp-tools-doc.ts
//
// Pure rendering + Zod-schema introspection for docs/reference/mcp-tools.md.
// Kept separate from scripts/gen-mcp-tools-doc.mjs (which owns file I/O and the
// CLI/--check entry point) so the rendering can be unit-tested directly against
// MCP_TOOL_SPECS without a build or a child process.

import type { ZodTypeAny, ZodRawShape } from 'zod';

import type { McpToolSpec } from './mcp-tool-specs.js';

export const MCP_TOOLS_REFERENCE_PATH = 'docs/reference/mcp-tools.md';

interface FieldDoc {
  name: string;
  type: string;
  required: boolean;
  constraints: string[];
  description: string;
}

// zod stores its runtime metadata on `_def`; the public types don't expose the
// version-specific check shapes, so introspection works through a narrow local
// view rather than `any`.
interface ZodDefView {
  typeName?: string;
  description?: string;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  type?: ZodTypeAny;
  checks?: Array<{ kind: string; value?: unknown }>;
  values?: unknown[];
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
}

function defOf(type: ZodTypeAny): ZodDefView {
  return (type as unknown as { _def?: ZodDefView })._def ?? {};
}

// Walk past wrappers that do not change the documented base type. Optional and
// default both make a field non-required; effects (refine/transform) wrap a base
// schema we still want to describe.
function unwrap(type: ZodTypeAny): { node: ZodTypeAny; required: boolean } {
  let node = type;
  let required = true;
  for (;;) {
    const def = defOf(node);
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') {
      required = false;
      node = def.innerType as ZodTypeAny;
      continue;
    }
    if (def.typeName === 'ZodNullable') {
      node = def.innerType as ZodTypeAny;
      continue;
    }
    if (def.typeName === 'ZodEffects') {
      node = def.schema as ZodTypeAny;
      continue;
    }
    break;
  }
  return { node, required };
}

function baseTypeLabel(type: ZodTypeAny): string {
  return typeInfo(unwrap(type).node).type;
}

function typeInfo(node: ZodTypeAny): { type: string; constraints: string[] } {
  const def = defOf(node);
  switch (def.typeName) {
    case 'ZodString': {
      const constraints: string[] = [];
      for (const check of def.checks ?? []) {
        if (check.kind === 'max') constraints.push(`max ${String(check.value)} chars`);
        else if (check.kind === 'min') constraints.push(`min ${String(check.value)} chars`);
      }
      return { type: 'string', constraints };
    }
    case 'ZodNumber': {
      let isInt = false;
      const constraints: string[] = [];
      for (const check of def.checks ?? []) {
        if (check.kind === 'int') isInt = true;
        else if (check.kind === 'min') constraints.push(`min ${String(check.value)}`);
        else if (check.kind === 'max') constraints.push(`max ${String(check.value)}`);
      }
      return { type: isInt ? 'integer' : 'number', constraints };
    }
    case 'ZodBoolean':
      return { type: 'boolean', constraints: [] };
    case 'ZodEnum':
      return {
        type: 'enum',
        constraints: [`one of: ${(def.values ?? []).map((value) => `\`${String(value)}\``).join(', ')}`],
      };
    case 'ZodArray': {
      const element = baseTypeLabel(def.type as ZodTypeAny);
      const constraints: string[] = [];
      if (def.maxLength) constraints.push(`max ${def.maxLength.value} items`);
      if (def.minLength) constraints.push(`min ${def.minLength.value} items`);
      return { type: `array of ${element}`, constraints };
    }
    default: {
      const name = (def.typeName ?? 'unknown').replace(/^Zod/, '').toLowerCase();
      return { type: name, constraints: [] };
    }
  }
}

function describeField(name: string, type: ZodTypeAny): FieldDoc {
  const { node, required } = unwrap(type);
  const { type: typeLabel, constraints } = typeInfo(node);
  // `.describe()` is always the outermost call, so the description lives on the
  // top-level type; fall back to the unwrapped node just in case.
  const description = defOf(type).description ?? defOf(node).description ?? '';
  return { name, type: typeLabel, required, constraints, description };
}

function describeShape(shape: ZodRawShape | undefined): FieldDoc[] {
  if (!shape) return [];
  return Object.entries(shape).map(([name, type]) => describeField(name, type));
}

// GitHub slugifies `## \`tool_name\`` to `tool_name`: backticks are dropped and
// the names only contain lowercase letters and underscores, so the anchor is the
// name verbatim.
function slug(name: string): string {
  return name;
}

function tableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
}

export function renderMcpToolsMarkdown(specs: McpToolSpec[]): string {
  const gatedCount = specs.filter((spec) => spec.ingestGated).length;

  const lines: string[] = [
    '# MCP Tools Reference',
    '',
    '<!-- This file is generated by scripts/gen-mcp-tools-doc.mjs. Do not edit by hand. -->',
    '',
    'This reference is generated from `MCP_TOOL_SPECS` in `src/mcp-tool-specs.ts`,',
    'the same registry `KnowledgeBaseServer.registerTools` uses to register tools',
    'with the MCP server. Each input field is rendered from its Zod schema, so the',
    'types and bounds (e.g. `context_window` max 5, `k` max 50) always match the',
    'shipped tool surface. Run `npm run docs:gen-mcp-tools` after changing a tool',
    'name, description, or input schema, and commit the result. The',
    '`docs:check-mcp-tools` gate (part of `npm run check`) fails if this file',
    'drifts.',
    '',
    `The server exposes ${specs.length} tools` +
      (gatedCount > 0
        ? `, ${gatedCount} of which are only registered when \`KB_INGEST_ENABLED\` is set.`
        : '.'),
    '',
    '## Tools',
    '',
    '| Tool | Gated | Description |',
    '| --- | --- | --- |',
    ...specs.map(
      (spec) =>
        `| [\`${spec.name}\`](#${slug(spec.name)}) | ${spec.ingestGated ? '`KB_INGEST_ENABLED`' : '—'} | ${tableCell(spec.description)} |`,
    ),
  ];

  for (const spec of specs) {
    lines.push('', `## \`${spec.name}\``, '');
    if (spec.ingestGated) {
      lines.push('> Only registered when `KB_INGEST_ENABLED` is set.', '');
    }
    lines.push(spec.description, '');

    const fields = describeShape(spec.inputShape);
    if (fields.length === 0) {
      lines.push('_No input parameters._');
      continue;
    }

    lines.push(
      '| Field | Type | Required | Constraints | Description |',
      '| --- | --- | --- | --- | --- |',
      ...fields.map(
        (field) =>
          `| \`${field.name}\` | ${field.type} | ${field.required ? 'yes' : 'no'} | ${field.constraints.length ? tableCell(field.constraints.join('; ')) : '—'} | ${tableCell(field.description)} |`,
      ),
    );
  }

  return `${lines.join('\n')}\n`;
}
