import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  decideResourceRead,
  excludesLlmContext,
  normalizeKbSensitivityPolicy,
  readLlmContextPolicy,
  resolveResourceReadAccess,
  sensitivityPolicyFromMetadata,
} from './sensitivity-policy.js';

describe('normalizeKbSensitivityPolicy — resource_read fail-closed', () => {
  it('keeps recognized resource_read values', () => {
    expect(normalizeKbSensitivityPolicy({ resource_read: 'allow' })).toEqual({
      resource_read: 'allow',
    });
    expect(normalizeKbSensitivityPolicy({ resource_read: 'local_only' })).toEqual({
      resource_read: 'local_only',
    });
    expect(normalizeKbSensitivityPolicy({ resource_read: 'deny' })).toEqual({
      resource_read: 'deny',
    });
    expect(normalizeKbSensitivityPolicy({ resource_read: 'Local-Only' })).toEqual({
      resource_read: 'local_only',
    });
    // Surrounding whitespace must be trimmed before the enum comparison.
    expect(normalizeKbSensitivityPolicy({ resource_read: '  allow  ' })).toEqual({
      resource_read: 'allow',
    });
  });

  it('fails closed on typo and non-enum resource_read values', () => {
    for (const value of ['denied', 'private', 'no', 'true', 'block', '']) {
      expect(normalizeKbSensitivityPolicy({ resource_read: value })).toEqual({
        resource_read: 'deny',
      });
    }
    expect(normalizeKbSensitivityPolicy({ resource_read: 1 })).toEqual({
      resource_read: 'deny',
    });
    expect(normalizeKbSensitivityPolicy({ resource_read: ['deny'] })).toEqual({
      resource_read: 'deny',
    });
    expect(normalizeKbSensitivityPolicy({ resource_read: null })).toEqual({
      resource_read: 'deny',
    });
  });

  it('fails closed when kb_policy is not a mapping', () => {
    expect(normalizeKbSensitivityPolicy(true)).toEqual({
      no_llm_context: true,
      resource_read: 'deny',
    });
    expect(normalizeKbSensitivityPolicy('deny')).toEqual({
      no_llm_context: true,
      resource_read: 'deny',
    });
    expect(normalizeKbSensitivityPolicy(['resource_read', 'deny'])).toEqual({
      no_llm_context: true,
      resource_read: 'deny',
    });
  });

  it('leaves resource_read unset when the key is absent', () => {
    expect(normalizeKbSensitivityPolicy({ no_llm_context: true })).toEqual({
      no_llm_context: true,
    });
    expect(normalizeKbSensitivityPolicy({})).toBeUndefined();
    expect(normalizeKbSensitivityPolicy(undefined)).toBeUndefined();
  });
});

describe('normalizeKbSensitivityPolicy — no_llm_context fail-closed', () => {
  it('preserves parseable boolean-like no_llm_context values', () => {
    expect(normalizeKbSensitivityPolicy({ no_llm_context: true })).toEqual({
      no_llm_context: true,
    });
    expect(normalizeKbSensitivityPolicy({ no_llm_context: false })).toEqual({
      no_llm_context: false,
    });
    expect(normalizeKbSensitivityPolicy({ no_llm_context: 'true' })).toEqual({
      no_llm_context: true,
    });
    expect(normalizeKbSensitivityPolicy({ no_llm_context: ' FALSE ' })).toEqual({
      no_llm_context: false,
    });
  });

  // A present-but-unparseable confidentiality control must fail closed: it is
  // forced to `no_llm_context === true` so malformed markup can never make a
  // protected document LLM-eligible (sensitivity-policy.ts fail-closed branch).
  it.each([
    ['numeric', 1],
    ['zero', 0],
    ['null', null],
    ['empty string', ''],
    ['non-enum string', 'maybe'],
    ['yes string', 'yes'],
    ['object', {}],
    ['array', ['true']],
  ])('forces no_llm_context true for a malformed %s value', (_label, value) => {
    expect(normalizeKbSensitivityPolicy({ no_llm_context: value })).toEqual({
      no_llm_context: true,
    });
  });

  it('keeps a valid sibling policy while failing the malformed no_llm_context closed', () => {
    // The malformed no_llm_context must not ride on a valid sibling field and
    // silently become LLM-eligible; it stays forced to true.
    expect(
      normalizeKbSensitivityPolicy({ no_llm_context: 'oops', resource_read: 'allow' }),
    ).toEqual({ no_llm_context: true, resource_read: 'allow' });
    expect(
      normalizeKbSensitivityPolicy({ no_llm_context: 'oops', sensitivity: 'secret' }),
    ).toEqual({ no_llm_context: true, sensitivity: 'secret' });
  });
});

describe('normalizeKbSensitivityPolicy — unknown-key fail-closed', () => {
  // A mapping with only unrecognized keys is not a policy-free document: it is
  // treated as an opaque/unknown policy and forced to exclude LLM context.
  it.each([
    ['single unknown key', { unknown_field: 'x' }],
    ['policy typo', { llm_context: false }],
    ['nested unknown', { extra: { nested: true } }],
    ['multiple unknowns', { a: 1, b: 2 }],
  ])('forces no_llm_context true for an unknown-only mapping (%s)', (_label, value) => {
    expect(normalizeKbSensitivityPolicy(value)).toEqual({ no_llm_context: true });
  });

  it('does not fail closed when a recognized field is present alongside unknown keys', () => {
    expect(
      normalizeKbSensitivityPolicy({ resource_read: 'allow', unknown_field: 'x' }),
    ).toEqual({ resource_read: 'allow' });
  });
});

describe('normalizeKbSensitivityPolicy — sensitivity label', () => {
  it('trims surrounding whitespace from a sensitivity label', () => {
    expect(normalizeKbSensitivityPolicy({ sensitivity: '  secret  ' })).toEqual({
      sensitivity: 'secret',
    });
  });

  it('does not keep a blank sensitivity label, failing closed as an unknown-only mapping', () => {
    // A blank label carries no usable field; it must not become an empty-string
    // sensitivity (guards the length check, not just the trim). With no
    // recognized field left, the mapping is treated as unknown and fails closed.
    expect(normalizeKbSensitivityPolicy({ sensitivity: '   ' })).toEqual({
      no_llm_context: true,
    });
    expect(normalizeKbSensitivityPolicy({ sensitivity: '' })).toEqual({
      no_llm_context: true,
    });
  });

  it('ignores a non-string sensitivity label and fails closed', () => {
    expect(normalizeKbSensitivityPolicy({ sensitivity: 42 })).toEqual({
      no_llm_context: true,
    });
  });
});

describe('decideResourceRead', () => {
  it('allows when no resource_read policy is present', () => {
    expect(decideResourceRead(undefined, 'remote')).toEqual({ allowed: true });
    expect(decideResourceRead({}, 'remote')).toEqual({ allowed: true });
    expect(decideResourceRead({ resource_read: 'allow' }, 'remote')).toEqual({
      allowed: true,
    });
  });

  it('denies deny for local and remote', () => {
    expect(decideResourceRead({ resource_read: 'deny' }, 'local')).toEqual({
      allowed: false,
      reason: 'resource_read_deny',
    });
    expect(decideResourceRead({ resource_read: 'deny' }, 'remote')).toEqual({
      allowed: false,
      reason: 'resource_read_deny',
    });
  });

  it('blocks local_only only for remote access', () => {
    expect(decideResourceRead({ resource_read: 'local_only' }, 'local')).toEqual({
      allowed: true,
    });
    expect(decideResourceRead({ resource_read: 'local_only' }, 'remote')).toEqual({
      allowed: false,
      reason: 'resource_read_local_only',
    });
  });
});

describe('resolveResourceReadAccess', () => {
  it('treats http and sse as remote', () => {
    expect(resolveResourceReadAccess({ MCP_TRANSPORT: 'http' } as NodeJS.ProcessEnv)).toBe('remote');
    expect(resolveResourceReadAccess({ MCP_TRANSPORT: 'sse' } as NodeJS.ProcessEnv)).toBe('remote');
    expect(resolveResourceReadAccess({} as NodeJS.ProcessEnv)).toBe('local');
    expect(resolveResourceReadAccess({ MCP_TRANSPORT: 'stdio' } as NodeJS.ProcessEnv)).toBe('local');
  });
});

describe('sensitivityPolicyFromMetadata & excludesLlmContext', () => {
  it('reads the policy from frontmatter metadata', () => {
    expect(
      sensitivityPolicyFromMetadata({ frontmatter: { kb_policy: { no_llm_context: true } } }),
    ).toEqual({ no_llm_context: true });
  });

  it('returns undefined when metadata or frontmatter is absent or non-mapping', () => {
    expect(sensitivityPolicyFromMetadata(undefined)).toBeUndefined();
    expect(sensitivityPolicyFromMetadata({})).toBeUndefined();
    expect(sensitivityPolicyFromMetadata({ frontmatter: null })).toBeUndefined();
    expect(sensitivityPolicyFromMetadata({ frontmatter: 'x' })).toBeUndefined();
    expect(sensitivityPolicyFromMetadata({ frontmatter: ['x'] })).toBeUndefined();
    expect(sensitivityPolicyFromMetadata({ frontmatter: {} })).toBeUndefined();
  });

  it('fails closed to exclude LLM context when kb_policy is malformed', () => {
    // A non-mapping kb_policy in metadata must exclude the document from LLM
    // context rather than be treated as policy-free.
    expect(excludesLlmContext({ frontmatter: { kb_policy: 'deny' } })).toBe(true);
    expect(excludesLlmContext({ frontmatter: { kb_policy: { no_llm_context: 'oops' } } })).toBe(
      true,
    );
    expect(excludesLlmContext({ frontmatter: { kb_policy: { unknown: 1 } } })).toBe(true);
  });

  it('does not exclude LLM context for absent, empty, or opt-in policies', () => {
    expect(excludesLlmContext(undefined)).toBe(false);
    expect(excludesLlmContext({ frontmatter: {} })).toBe(false);
    expect(excludesLlmContext({ frontmatter: { kb_policy: {} } })).toBe(false);
    expect(excludesLlmContext({ frontmatter: { kb_policy: { no_llm_context: false } } })).toBe(
      false,
    );
  });
});

describe('readLlmContextPolicy', () => {
  async function withTempFile(
    contents: string | null,
    run: (source: string) => Promise<void>,
  ): Promise<void> {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'llm-context-policy-'));
    const source = path.join(tempDir, 'doc.md');
    try {
      if (contents !== null) {
        await fsp.writeFile(source, contents, 'utf-8');
      }
      await run(source);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }

  it('marks an unreadable source as not readable and not valid, failing closed', async () => {
    await withTempFile(null, async (source) => {
      expect(await readLlmContextPolicy(source)).toEqual({
        readable: false,
        valid: false,
        policy: undefined,
      });
    });
  });

  it('treats a file with no kb_policy as readable and valid', async () => {
    await withTempFile('---\ntitle: note\n---\nbody\n', async (source) => {
      expect(await readLlmContextPolicy(source)).toEqual({
        readable: true,
        valid: true,
        policy: undefined,
      });
    });
  });

  it('accepts an empty kb_policy mapping as a valid, policy-free document', async () => {
    await withTempFile('---\nkb_policy: {}\n---\nbody\n', async (source) => {
      expect(await readLlmContextPolicy(source)).toEqual({
        readable: true,
        valid: true,
        policy: undefined,
      });
    });
  });

  it('surfaces a normalized policy and stays valid for a well-formed kb_policy', async () => {
    await withTempFile('---\nkb_policy:\n  no_llm_context: true\n---\nbody\n', async (source) => {
      expect(await readLlmContextPolicy(source)).toEqual({
        readable: true,
        valid: true,
        policy: { no_llm_context: true },
      });
    });
  });

  it('stays valid but fails the policy closed when kb_policy is malformed', async () => {
    // A malformed but present kb_policy is still a decodable frontmatter, so it
    // is readable/valid, yet the normalized policy must exclude LLM context.
    await withTempFile('---\nkb_policy: "deny"\n---\nbody\n', async (source) => {
      expect(await readLlmContextPolicy(source)).toEqual({
        readable: true,
        valid: true,
        policy: { no_llm_context: true, resource_read: 'deny' },
      });
    });
  });
});
