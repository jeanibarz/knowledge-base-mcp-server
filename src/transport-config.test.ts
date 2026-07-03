// src/transport-config.test.ts
//
// Issue #750 — Host-header allow-list derivation for DNS-rebinding protection.
// Covers the default derivation from bind address/port and the
// MCP_ALLOWED_HOSTS parsing (loopback defaults, CSV merge, `*` escape hatch).

import {
  defaultAllowedHosts,
  loadTransportConfig,
  parseAllowedHosts,
} from './transport-config.js';

describe('defaultAllowedHosts', () => {
  it('includes host:port and bare host plus loopback aliases for a loopback bind', () => {
    const hosts = defaultAllowedHosts('127.0.0.1', 8765);
    expect(hosts).toEqual(
      expect.arrayContaining([
        '127.0.0.1:8765',
        '127.0.0.1',
        'localhost:8765',
        'localhost',
        '[::1]:8765',
        '[::1]',
      ]),
    );
  });

  it('brackets an IPv6 bind address as it appears in the Host header', () => {
    const hosts = defaultAllowedHosts('::1', 8765);
    expect(hosts).toContain('[::1]:8765');
    expect(hosts).toContain('[::1]');
  });

  it('adds loopback aliases when bound to the wildcard address', () => {
    const hosts = defaultAllowedHosts('0.0.0.0', 8765);
    expect(hosts).toEqual(
      expect.arrayContaining(['localhost:8765', '127.0.0.1:8765']),
    );
  });

  it('does not add loopback aliases for a non-loopback bind address', () => {
    const hosts = defaultAllowedHosts('10.0.0.5', 9000);
    expect(hosts).toEqual(expect.arrayContaining(['10.0.0.5:9000', '10.0.0.5']));
    expect(hosts).not.toContain('localhost:9000');
  });
});

describe('parseAllowedHosts', () => {
  it('returns loopback defaults when unset', () => {
    const hosts = parseAllowedHosts(undefined, '127.0.0.1', 8765);
    expect(hosts).toContain('127.0.0.1:8765');
    expect(hosts).toContain('localhost:8765');
  });

  it('merges configured hosts with the derived defaults', () => {
    const hosts = parseAllowedHosts('kb.internal:8765, Proxy.Example', '127.0.0.1', 8765);
    expect(hosts).toContain('127.0.0.1:8765');
    expect(hosts).toContain('kb.internal:8765');
    // Configured entries are lowercased for case-insensitive comparison.
    expect(hosts).toContain('proxy.example');
  });

  it('deduplicates entries shared between defaults and config', () => {
    const hosts = parseAllowedHosts('localhost:8765', '127.0.0.1', 8765);
    expect(hosts.filter((h) => h === 'localhost:8765')).toHaveLength(1);
  });

  it('returns an empty list (validation disabled) for the `*` escape hatch', () => {
    expect(parseAllowedHosts('*', '127.0.0.1', 8765)).toEqual([]);
    expect(parseAllowedHosts('  *  ', '127.0.0.1', 8765)).toEqual([]);
  });
});

describe('loadTransportConfig — allowedHosts', () => {
  it('derives allowedHosts from bind address and port', () => {
    const config = loadTransportConfig({
      MCP_TRANSPORT: 'stdio',
      MCP_PORT: '9999',
      MCP_BIND_ADDR: '127.0.0.1',
    });
    expect(config.allowedHosts).toContain('127.0.0.1:9999');
    expect(config.allowedHosts).toContain('localhost:9999');
  });

  it('honors MCP_ALLOWED_HOSTS=* to disable Host validation', () => {
    const config = loadTransportConfig({
      MCP_TRANSPORT: 'stdio',
      MCP_ALLOWED_HOSTS: '*',
    });
    expect(config.allowedHosts).toEqual([]);
  });
});
