import { readFileSync } from 'node:fs';
import * as path from 'node:path';

// npm search ranks packages by name, description and keywords (issue #1277).
// Pin the discoverability fields so a later edit cannot silently empty them.
// The description wording is deliberately not asserted.

interface PackageJson {
  description?: string;
  keywords?: string[];
  homepage?: string;
  bugs?: { url?: string } | string;
}

const pkg = JSON.parse(
  readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
) as PackageJson;

describe('package.json npm metadata', () => {
  it('has a non-empty description', () => {
    expect(typeof pkg.description).toBe('string');
    expect(pkg.description?.trim().length).toBeGreaterThan(0);
  });

  it('has keywords that include mcp', () => {
    expect(Array.isArray(pkg.keywords)).toBe(true);
    expect(pkg.keywords?.length).toBeGreaterThan(0);
    expect(pkg.keywords).toContain('mcp');
  });

  it('has homepage and bugs URLs', () => {
    expect(pkg.homepage).toMatch(/^https:\/\//);
    const bugsUrl = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url;
    expect(bugsUrl).toMatch(/^https:\/\//);
  });
});
