import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { CONFIG_SCHEMA } from './config/schema.js';

// Drift guard for `server.json`, the MCP Registry listing (issue #1278).
// Nothing at runtime reads this file. The registry checks that `mcpName` in the
// published npm package equals the server name here, and every release bump
// must update both version fields, so the parity is pinned here instead of
// trusting release-time memory. Schema validity is checked separately with
// `mcp-publisher validate` (see docs/operations/mcp-registry.md).

const REPO_ROOT = process.cwd();

interface RegistryEnvVar {
  name: string;
  isSecret?: boolean;
  choices?: string[];
  default?: string;
}

interface RegistryPackage {
  registryType: string;
  identifier: string;
  version: string;
  transport: { type: string };
  environmentVariables?: RegistryEnvVar[];
}

interface ServerJson {
  $schema: string;
  name: string;
  version: string;
  packages: RegistryPackage[];
}

interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
  files: string[];
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T;
}

function schemaSpec(name: string) {
  const spec = CONFIG_SCHEMA.find((entry) => entry.name === name);
  if (!spec) {
    throw new Error(`CONFIG_SCHEMA has no entry for ${name}`);
  }
  return spec;
}

describe('server.json (MCP Registry) parity', () => {
  const server = readJson<ServerJson>('server.json');
  const pkg = readJson<PackageJson>('package.json');

  it('references a dated official registry schema', () => {
    expect(server.$schema).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/,
    );
  });

  it('uses the server name that package.json declares as mcpName', () => {
    expect(pkg.mcpName).toBe('io.github.jeanibarz/knowledge-base-mcp-server');
    expect(server.name).toBe(pkg.mcpName);
  });

  it('lists exactly one stdio npm package matching package.json name and version', () => {
    expect(server.packages).toHaveLength(1);
    const [entry] = server.packages;
    expect(entry.registryType).toBe('npm');
    expect(entry.identifier).toBe(pkg.name);
    expect(entry.transport.type).toBe('stdio');
    expect(entry.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
  });

  it('declares only env vars registered in CONFIG_SCHEMA, with matching secret flags', () => {
    const envVars = server.packages[0].environmentVariables ?? [];
    expect(envVars.map((v) => v.name)).toEqual(
      expect.arrayContaining(['KNOWLEDGE_BASES_ROOT_DIR', 'EMBEDDING_PROVIDER']),
    );
    for (const envVar of envVars) {
      const spec = schemaSpec(envVar.name);
      expect({ name: envVar.name, isSecret: envVar.isSecret === true }).toEqual({
        name: envVar.name,
        isSecret: spec.secret === true,
      });
    }
  });

  it('offers the schema embedding providers minus the test-only fake provider', () => {
    const envVars = server.packages[0].environmentVariables ?? [];
    const provider = envVars.find((v) => v.name === 'EMBEDDING_PROVIDER');
    const spec = schemaSpec('EMBEDDING_PROVIDER');
    if (!('values' in spec) || !spec.values) {
      throw new Error('EMBEDDING_PROVIDER has no enum values in CONFIG_SCHEMA');
    }
    expect(provider?.choices).toEqual(spec.values.filter((value) => value !== 'fake'));
    expect(provider?.default).toBe(spec.default);
  });

  it('keeps server.json out of the npm tarball', () => {
    expect(pkg.files).not.toContain('server.json');
  });
});
