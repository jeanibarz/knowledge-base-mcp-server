import { describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

function extractKbErrorCodes(source: string): string[] {
  const match = source.match(/export type KBErrorCode =([\s\S]*?)\n\nexport class KBError/);
  if (!match) {
    throw new Error('Unable to find KBErrorCode union in src/errors.ts');
  }

  return [...match[1].matchAll(/\|\s*'([^']+)'/g)].map(([, code]) => code);
}

function extractDocumentedCodes(doc: string): string[] {
  return [...doc.matchAll(/^\| `([A-Z_]+)` \|/gm)].map(([, code]) => code);
}

describe('KBErrorCode documentation', () => {
  it('documents every KBErrorCode in the operator reference', () => {
    const root = process.cwd();
    const source = fs.readFileSync(path.join(root, 'src', 'errors.ts'), 'utf-8');
    const doc = fs.readFileSync(path.join(root, 'docs', 'reference', 'error-codes.md'), 'utf-8');
    const codes = extractKbErrorCodes(source);
    const documentedCodes = extractDocumentedCodes(doc);

    expect(new Set(documentedCodes)).toEqual(new Set(codes));
    expect(documentedCodes).toHaveLength(codes.length);
  });
});
