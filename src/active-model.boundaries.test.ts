// Issue #1008 — pin the module split that replaced `active-model.ts` with
// `model-resolution.ts` (resolution layer) and `model-storage-layout.ts`
// (path builders + sentinel state machine). Behavior-preserving refactor:
// no re-exported model-id symbols, no backward-compat barrel.
//
// If a future change reintroduces `active-model.ts`, or re-adds the
// model-id re-export to either new module, this test fails before the
// change can land.

import { describe, expect, it } from '@jest/globals';
import * as fsp from 'fs/promises';
import * as path from 'path';

const SRC_DIR = path.resolve(__dirname);

async function readSource(rel: string): Promise<string> {
  return fsp.readFile(path.join(SRC_DIR, rel), 'utf-8');
}

describe('issue #1008 module boundary: active-model split into resolution + storage-layout', () => {
  it('src/active-model.ts no longer exists', async () => {
    await expect(
      fsp.stat(path.join(SRC_DIR, 'active-model.ts')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cli-models.ts imports from model-resolution and model-storage-layout, not active-model', async () => {
    const src = await readSource('cli-models.ts');
    expect(src).toMatch(/from ['"]\.\/model-resolution\.js['"]/);
    expect(src).toMatch(/from ['"]\.\/model-storage-layout\.js['"]/);
    expect(src).not.toMatch(/from ['"]\.\/active-model\.js['"]/);
  });

  it('KnowledgeBaseServer.ts imports from model-resolution and model-storage-layout, not active-model', async () => {
    const src = await readSource('KnowledgeBaseServer.ts');
    expect(src).toMatch(/from ['"]\.\/model-resolution\.js['"]/);
    expect(src).toMatch(/from ['"]\.\/model-storage-layout\.js['"]/);
    expect(src).not.toMatch(/from ['"]\.\/active-model\.js['"]/);
  });

  it('cli-backup.ts dynamic imports target model-resolution / model-storage-layout, not active-model', async () => {
    const src = await readSource('cli-backup.ts');
    expect(src).toMatch(/await import\(['"]\.\/model-storage-layout\.js['"]\)/);
    expect(src).toMatch(/await import\(['"]\.\/model-resolution\.js['"]\)/);
    expect(src).not.toMatch(/await import\(['"]\.\/active-model\.js['"]\)/);
  });

  it('no source file still imports from ./active-model.js', async () => {
    const entries = await fsp.readdir(SRC_DIR);
    for (const entry of entries) {
      if (!entry.endsWith('.ts')) continue;
      const src = await readSource(entry);
      expect(src).not.toMatch(/from ['"]\.\/active-model\.js['"]/);
      expect(src).not.toMatch(/import\(['"]\.\/active-model\.js['"]\)/);
    }
  });

  it('model-resolution.ts does not re-declare/re-export the model-id symbols', async () => {
    const src = await readSource('model-resolution.ts');
    expect(src).not.toMatch(/export\s*\{\s*deriveModelId/);
    expect(src).not.toMatch(/export\s+function\s+deriveModelId\b/);
    expect(src).not.toMatch(/export\s+function\s+parseModelId\b/);
    expect(src).not.toMatch(/export\s+function\s+isValidModelId\b/);
  });

  it('model-storage-layout.ts does not re-declare/re-export the model-id symbols', async () => {
    const src = await readSource('model-storage-layout.ts');
    expect(src).not.toMatch(/export\s*\{\s*deriveModelId/);
    expect(src).not.toMatch(/export\s+function\s+deriveModelId\b/);
    expect(src).not.toMatch(/export\s+function\s+parseModelId\b/);
    expect(src).not.toMatch(/export\s+function\s+isValidModelId\b/);
  });

  it('model-storage-layout.ts never imports from model-resolution.ts (one-way dependency)', async () => {
    const src = await readSource('model-storage-layout.ts');
    expect(src).not.toMatch(/from ['"]\.\/model-resolution\.js['"]/);
  });
});
