import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

import { CONFIG_SCHEMA, isRegisteredConfigName } from './config/schema.js';

// Drift guard for `smithery.yaml` (issue #1199). Nothing else reads this file,
// and it has drifted from the config schema before (#34: the provider enum
// omitted `openai`). These assertions tie it back to `CONFIG_SCHEMA` and to the
// Docker image it launches in.

const REPO_ROOT = process.cwd();

interface SmitheryProperty {
  type?: string;
  enum?: string[];
  default?: unknown;
}

interface SmitheryFile {
  startCommand: {
    type: string;
    configSchema: { properties: Record<string, SmitheryProperty> };
    commandFunction: string;
  };
}

function loadSmithery(): SmitheryFile {
  const raw = readFileSync(path.join(REPO_ROOT, 'smithery.yaml'), 'utf8');
  return yaml.load(raw) as SmitheryFile;
}

function schemaEnumValues(name: string): string[] {
  const spec = CONFIG_SCHEMA.find((entry) => entry.name === name);
  if (!spec || !('values' in spec) || !spec.values) {
    throw new Error(`CONFIG_SCHEMA has no enum values for ${name}`);
  }
  return [...spec.values];
}

type CommandFunction = (config: Record<string, unknown>) => {
  command: string;
  args: string[];
  env: Record<string, unknown>;
};

function compileCommandFunction(source: string): CommandFunction {
  // The command function is JS source that Smithery evaluates; do the same.
  return new Function(`return (${source});`)() as CommandFunction;
}

describe('smithery.yaml parity', () => {
  const smithery = loadSmithery();
  const properties = smithery.startCommand.configSchema.properties;

  it('offers exactly the schema embedding providers minus the test-only fake provider', () => {
    const expected = schemaEnumValues('EMBEDDING_PROVIDER').filter((value) => value !== 'fake');
    expect(expected).toEqual(['huggingface', 'ollama', 'openai']);
    expect(properties.embeddingProvider.enum).toEqual(expected);
  });

  it('offers exactly the transports the server accepts', () => {
    // Smithery itself launches over stdio (startCommand.type); the network
    // transports stay selectable so the option mirrors MCP_TRANSPORT exactly.
    expect(smithery.startCommand.type).toBe('stdio');
    expect(properties.mcpTransport.enum).toEqual(schemaEnumValues('MCP_TRANSPORT'));
  });

  it('sets only env vars registered in CONFIG_SCHEMA and forwards every option', () => {
    const commandFunction = compileCommandFunction(smithery.startCommand.commandFunction);
    const sentinelConfig = Object.fromEntries(
      Object.keys(properties).map((name) => [name, `sentinel:${name}`]),
    );
    const { env } = commandFunction(sentinelConfig);

    const envNames = Object.keys(env);
    expect(envNames.length).toBeGreaterThan(0);
    expect(envNames.filter((name) => !isRegisteredConfigName(name))).toEqual([]);

    // Every config option must reach some env var, or it is a dead knob.
    const forwarded = new Set(Object.values(env).map(String));
    const dropped = Object.keys(properties).filter((name) => !forwarded.has(`sentinel:${name}`));
    expect(dropped).toEqual([]);
  });

  it('defaults data paths to a directory the image runtime user owns', () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, 'Dockerfile'), 'utf8');
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)\s*$/gm)].map((match) => match[1]);
    const runtimeUser = users[users.length - 1];
    expect(runtimeUser).toBe('node');
    const home = `/home/${runtimeUser}/`;

    for (const name of ['knowledgeBasesRootDir', 'faissIndexPath']) {
      const value = properties[name].default;
      expect(typeof value).toBe('string');
      expect((value as string).startsWith(home)).toBe(true);
    }
  });
});
