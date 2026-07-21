import {
  decideResourceRead,
  normalizeKbSensitivityPolicy,
  resolveResourceReadAccess,
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
