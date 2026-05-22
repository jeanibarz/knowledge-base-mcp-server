import { describe, expect, it } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListResourceTemplatesRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  buildResourceUri,
  listResourceTemplates,
  mimeTypeForResource,
  parseKnowledgeBaseResourceUri,
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
