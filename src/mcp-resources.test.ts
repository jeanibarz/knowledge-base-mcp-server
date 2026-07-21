import { afterEach, describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListResourceTemplatesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { KNOWLEDGE_BASES_ROOT_DIR } from './config/paths.js';
import {
  buildResourceUri,
  listResourceTemplates,
  mimeTypeForResource,
  parseKnowledgeBaseResourceUri,
  readResource,
  registerResources,
} from './mcp-resources.js';

// Issue #157 step 2 — direct tests for the pure URI/MIME helpers extracted
// out of KnowledgeBaseServer.handleReadResource (#49). The integration
// tests in KnowledgeBaseServer.test.ts cover handleListResources /
// handleReadResource end-to-end against a real tempdir; these cover the
// pure-function contract that round-trip and traversal-rejection rest on.

describe('mimeTypeForResource', () => {
  it.each<[string, string]>([
    ['notes.md', 'text/markdown'],
    ['notes.markdown', 'text/markdown'],
    ['paper.pdf', 'application/pdf'],
    ['page.html', 'text/html'],
    ['page.HTM', 'text/html'],
    ['readme.txt', 'text/plain'],
    ['no-extension', 'text/plain'],
    ['weird.unknown', 'text/plain'],
  ])('maps %s to %s', (filePath, expected) => {
    expect(mimeTypeForResource(filePath)).toBe(expected);
  });
});

describe('buildResourceUri', () => {
  it('emits kb:// with percent-encoded segments for reserved characters', () => {
    expect(buildResourceUri('alpha', 'docs/guide.md')).toBe('kb://alpha/docs/guide.md');
    expect(buildResourceUri('alpha', 'issues/bug#42 &v=2.md')).toBe(
      `kb://alpha/issues/${encodeURIComponent('bug#42 &v=2.md')}`,
    );
  });

  it("does not encode the segment separator '/'", () => {
    const out = buildResourceUri('alpha', 'a/b/c.md');
    expect(out).toBe('kb://alpha/a/b/c.md');
  });

  it('round-trips with parseKnowledgeBaseResourceUri', () => {
    const filename = 'bug#123 ?q=1+rev.md';
    const uri = buildResourceUri('alpha', `issues/${filename}`);
    const parsed = parseKnowledgeBaseResourceUri(uri);
    expect(parsed).toEqual({ kbName: 'alpha', relativePath: `issues/${filename}` });
  });
});

describe('parseKnowledgeBaseResourceUri', () => {
  it('parses a plain kb:// URI', () => {
    expect(parseKnowledgeBaseResourceUri('kb://alpha/docs/guide.md')).toEqual({
      kbName: 'alpha',
      relativePath: 'docs/guide.md',
    });
  });

  it('rejects non-kb:// schemes', () => {
    expect(() => parseKnowledgeBaseResourceUri('http://alpha/docs/guide.md')).toThrow(
      /unsupported resource URI scheme|kb:\/\//,
    );
    expect(() => parseKnowledgeBaseResourceUri('not-a-uri')).toThrow(
      /resource URI must use the kb:\/\/ scheme/,
    );
  });

  it('rejects an empty KB authority', () => {
    expect(() => parseKnowledgeBaseResourceUri('kb:///docs/guide.md')).toThrow(
      /non-empty KB authority/,
    );
  });

  it('rejects an invalid KB name', () => {
    expect(() => parseKnowledgeBaseResourceUri('kb://..hidden/x.md')).toThrow(
      /invalid KB name/,
    );
  });

  it('rejects an empty resource path', () => {
    expect(() => parseKnowledgeBaseResourceUri('kb://alpha')).toThrow(
      /non-empty resource path/,
    );
    expect(() => parseKnowledgeBaseResourceUri('kb://alpha/')).toThrow(
      /non-empty resource path/,
    );
  });

  it('rejects encoded path separators (%2f, %5c) before decoding', () => {
    expect(() => parseKnowledgeBaseResourceUri('kb://alpha/..%2Fsecret.md')).toThrow(
      /path escapes KB root/,
    );
    expect(() => parseKnowledgeBaseResourceUri('kb://alpha/foo%5Cbar.md')).toThrow(
      /path escapes KB root/,
    );
  });

  it('rejects parent traversal segments after decoding', () => {
    expect(() => parseKnowledgeBaseResourceUri('kb://alpha/%2E%2E/secret.md')).toThrow(
      /path escapes KB root/,
    );
    expect(() => parseKnowledgeBaseResourceUri('kb://alpha/../secret.md')).toThrow(
      /path escapes KB root/,
    );
  });

  it('decodes per-segment so reserved chars (#, &, +, =, space) survive the round trip', () => {
    // Filenames with these chars would survive `decodeURI` only as literal
    // %xx — `resources/read` would then fail with "path not found". The
    // module's per-segment `decodeURIComponent` is what makes this work.
    const filename = 'bug#42 &v=2+rev?.md';
    const uri = buildResourceUri('alpha', `issues/${filename}`);
    const parsed = parseKnowledgeBaseResourceUri(uri);
    expect(parsed.relativePath).toBe(`issues/${filename}`);
  });
});

describe('listResourceTemplates', () => {
  it('advertises the kb:// document URI template', () => {
    expect(listResourceTemplates()).toEqual({
      resourceTemplates: [
        expect.objectContaining({
          uriTemplate: 'kb://{kb}/{path}',
          name: 'kb-document',
        }),
      ],
    });
  });

  it('registers the resources/templates/list handler with the template response', async () => {
    const handlers: Array<{ schema: unknown; handler: () => unknown }> = [];
    const mcp = {
      server: {
        registerCapabilities: () => undefined,
        setRequestHandler: (schema: unknown, handler: () => unknown) => {
          handlers.push({ schema, handler });
        },
      },
    };

    registerResources(mcp as unknown as McpServer);

    const registered = handlers.find(
      (entry) => entry.schema === ListResourceTemplatesRequestSchema,
    );
    expect(registered).toBeDefined();
    await expect(Promise.resolve(registered!.handler())).resolves.toEqual(
      listResourceTemplates(),
    );
  });
});

describe('readResource sensitivity policy', () => {
  const kbName = `resource-policy-${process.pid}`;
  const kbDir = path.join(KNOWLEDGE_BASES_ROOT_DIR, kbName);

  afterEach(async () => {
    await fsp.rm(kbDir, { recursive: true, force: true });
  });

  it('blocks resource_read=deny for local and remote reads', async () => {
    await fsp.mkdir(kbDir, { recursive: true });
    await fsp.writeFile(path.join(kbDir, 'deny.md'), [
      '---',
      'kb_policy:',
      '  resource_read: deny',
      '---',
      '# Private',
    ].join('\n'), 'utf-8');

    await expect(readResource(buildResourceUri(kbName, 'deny.md'), { access: 'local' }))
      .rejects.toThrow(/resource blocked by kb_policy\.resource_read/);
    await expect(readResource(buildResourceUri(kbName, 'deny.md'), { access: 'remote' }))
      .rejects.toThrow(/resource blocked by kb_policy\.resource_read/);
  });

  it('allows local_only resources locally but blocks them over remote MCP transports', async () => {
    await fsp.mkdir(kbDir, { recursive: true });
    await fsp.writeFile(path.join(kbDir, 'local.md'), [
      '---',
      'kb_policy:',
      '  resource_read: local_only',
      '---',
      '# Local',
      '',
      'Operator-only note.',
    ].join('\n'), 'utf-8');

    await expect(readResource(buildResourceUri(kbName, 'local.md'), { access: 'local' }))
      .resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('Operator-only note.') }],
      });
    await expect(readResource(buildResourceUri(kbName, 'local.md'), { access: 'remote' }))
      .rejects.toThrow(/local_only/);
  });

  it('derives remote resource access from MCP_TRANSPORT by default', async () => {
    const previousTransport = process.env.MCP_TRANSPORT;
    try {
      await fsp.mkdir(kbDir, { recursive: true });
      await fsp.writeFile(path.join(kbDir, 'transport.md'), [
        '---',
        'kb_policy:',
        '  resource_read: local_only',
        '---',
        '# Remote',
      ].join('\n'), 'utf-8');

      process.env.MCP_TRANSPORT = 'http';
      await expect(readResource(buildResourceUri(kbName, 'transport.md')))
        .rejects.toThrow(/local_only/);
    } finally {
      if (previousTransport === undefined) delete process.env.MCP_TRANSPORT;
      else process.env.MCP_TRANSPORT = previousTransport;
    }
  });

  it('fails closed on remote read when frontmatter YAML is malformed around a deny marker', async () => {
    await fsp.mkdir(kbDir, { recursive: true });
    await fsp.writeFile(path.join(kbDir, 'malformed-deny.md'), [
      '---',
      'kb_policy:',
      '  resource_read: deny',
      '  broken: [unclosed',
      '---',
      '# Secret body that must not leak',
      '',
      'classified payload',
    ].join('\n'), 'utf-8');

    await expect(readResource(buildResourceUri(kbName, 'malformed-deny.md'), { access: 'remote' }))
      .rejects.toThrow(/resource blocked by kb_policy\.resource_read.*unreadable or malformed/);
  });

  it('fails closed when the frontmatter closing fence sits past the 8 KB scan window', async () => {
    await fsp.mkdir(kbDir, { recursive: true });
    // Opening fence + padding + policy + closing fence exceed FRONTMATTER_MAX_BYTES
    // so the lenient parser would drop the policy; strict parse must fail closed.
    const padding = `# ${'x'.repeat(9000)}\n`;
    await fsp.writeFile(path.join(kbDir, 'oversized.md'), [
      '---',
      padding.trimEnd(),
      'kb_policy:',
      '  resource_read: deny',
      '---',
      '# Should not be readable remotely',
    ].join('\n'), 'utf-8');

    await expect(readResource(buildResourceUri(kbName, 'oversized.md'), { access: 'remote' }))
      .rejects.toThrow(/resource blocked by kb_policy\.resource_read.*unreadable or malformed/);
  });

  it('fails closed on typo resource_read values instead of allowing', async () => {
    await fsp.mkdir(kbDir, { recursive: true });
    for (const [name, value] of [
      ['typo-denied.md', 'denied'],
      ['typo-private.md', 'private'],
      ['typo-no.md', 'no'],
    ] as const) {
      await fsp.writeFile(path.join(kbDir, name), [
        '---',
        'kb_policy:',
        `  resource_read: ${value}`,
        '---',
        '# Typo policy body',
      ].join('\n'), 'utf-8');

      await expect(readResource(buildResourceUri(kbName, name), { access: 'remote' }))
        .rejects.toThrow(/resource blocked by kb_policy\.resource_read/);
      await expect(readResource(buildResourceUri(kbName, name), { access: 'local' }))
        .rejects.toThrow(/resource blocked by kb_policy\.resource_read/);
    }
  });

  it('still allows local stdio reads of well-formed resource_read=allow notes', async () => {
    await fsp.mkdir(kbDir, { recursive: true });
    await fsp.writeFile(path.join(kbDir, 'allow.md'), [
      '---',
      'kb_policy:',
      '  resource_read: allow',
      '---',
      '# Public',
      '',
      'open note body',
    ].join('\n'), 'utf-8');

    await expect(readResource(buildResourceUri(kbName, 'allow.md'), { access: 'local' }))
      .resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('open note body') }],
      });
    await expect(readResource(buildResourceUri(kbName, 'allow.md'), { access: 'remote' }))
      .resolves.toMatchObject({
        contents: [{ text: expect.stringContaining('open note body') }],
      });
  });
});
