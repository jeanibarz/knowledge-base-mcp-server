// mcp-tools-doc.ts
//
// Pure rendering + Zod-schema introspection for docs/reference/mcp-tools.md.
// Kept separate from scripts/gen-mcp-tools-doc.mjs (which owns file I/O and the
// CLI/--check entry point) so the rendering can be unit-tested directly against
// MCP_TOOL_SPECS without a build or a child process.

import type { ZodRawShape } from 'zod';

import type { McpToolSpec } from './mcp-tool-specs.js';

export const MCP_TOOLS_REFERENCE_PATH = 'docs/reference/mcp-tools.md';

interface FieldDoc {
  name: string;
  type: string;
  required: boolean;
  constraints: string[];
  description: string;
}

// zod 4 keeps runtime metadata on `_def` — lowercase `type` tag, `innerType` /
// `element` / `entries` payload, and `checks[]` carrying `{ check, ... }` defs —
// while `.describe()` lives on the schema's `description` getter (backed by the
// global registry). The public types don't expose those internals, so
// introspection works through a narrow structural view rather than `any`.
interface ZodCheckDef {
  check?: string;
  value?: number;
  maximum?: number;
  minimum?: number;
  format?: string;
}

interface ZodDefView {
  type?: string;
  format?: string;
  innerType?: unknown;
  element?: unknown;
  entries?: Record<string, unknown>;
  checks?: Array<{ _zod?: { def?: ZodCheckDef } }>;
}

interface ZodLike {
  _def?: ZodDefView;
  description?: string;
}

function defOf(node: unknown): ZodDefView {
  return (node as ZodLike)?._def ?? {};
}

function checkDefs(def: ZodDefView): ZodCheckDef[] {
  return (def.checks ?? []).map((check) => check._zod?.def ?? {});
}

// Walk past wrappers that do not change the documented base type. Optional and
// default both make a field non-required.
function unwrap(type: unknown): { node: unknown; required: boolean } {
  let node = type;
  let required = true;
  for (;;) {
    const def = defOf(node);
    if (def.type === 'optional' || def.type === 'default' || def.type === 'prefault') {
      required = false;
      node = def.innerType;
      continue;
    }
    if (def.type === 'nullable' || def.type === 'nonoptional') {
      node = def.innerType;
      continue;
    }
    break;
  }
  return { node, required };
}

function baseTypeLabel(type: unknown): string {
  return typeInfo(unwrap(type).node).type;
}

function typeInfo(node: unknown): { type: string; constraints: string[] } {
  const def = defOf(node);
  switch (def.type) {
    case 'string': {
      const constraints: string[] = [];
      for (const check of checkDefs(def)) {
        if (check.check === 'max_length') constraints.push(`max ${String(check.maximum)} chars`);
        else if (check.check === 'min_length') constraints.push(`min ${String(check.minimum)} chars`);
      }
      return { type: 'string', constraints };
    }
    case 'number': {
      // z.int() bakes the format onto the def; `.int()` appends a check.
      let isInt = def.format === 'safeint' || def.format === 'int32' || def.format === 'uint32';
      const constraints: string[] = [];
      for (const check of checkDefs(def)) {
        if (check.check === 'number_format' && check.format === 'safeint') isInt = true;
        else if (check.check === 'greater_than') constraints.push(`min ${String(check.value)}`);
        else if (check.check === 'less_than') constraints.push(`max ${String(check.value)}`);
      }
      return { type: isInt ? 'integer' : 'number', constraints };
    }
    case 'boolean':
      return { type: 'boolean', constraints: [] };
    case 'enum':
      return {
        type: 'enum',
        constraints: [`one of: ${Object.values(def.entries ?? {}).map((value) => `\`${String(value)}\``).join(', ')}`],
      };
    case 'array': {
      const element = baseTypeLabel(def.element);
      const constraints: string[] = [];
      for (const check of checkDefs(def)) {
        if (check.check === 'max_length') constraints.push(`max ${check.maximum} items`);
        else if (check.check === 'min_length') constraints.push(`min ${check.minimum} items`);
      }
      return { type: `array of ${element}`, constraints };
    }
    default: {
      return { type: def.type ?? 'unknown', constraints: [] };
    }
  }
}

function describeField(name: string, type: unknown): FieldDoc {
  const { node, required } = unwrap(type);
  const { type: typeLabel, constraints } = typeInfo(node);
  // `.describe()` is always the outermost call, so the description lives on the
  // top-level type; fall back to the unwrapped node just in case.
  const description = (type as ZodLike).description ?? (node as ZodLike).description ?? '';
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
