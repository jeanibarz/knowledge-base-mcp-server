import { describe, expect, it } from '@jest/globals';
import { createHash } from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import { normalizeRetrievalEvalFixture } from './retrieval-eval.js';

const FIXTURE_DIR = path.join(process.cwd(), 'docs/testing/fixtures');
const CORPUS_DIR = path.join(FIXTURE_DIR, 'dogfood-corpus');
const DOGFOOD_FIXTURES = [
  {
    file: 'dogfood-frozen-core.yml',
    expectedCases: [
      'smoke - doctor health checks are discoverable',
      'recall floor - per-file invalidation remains findable',
      'precision floor - archived rollback stays out',
      'duplicate budget - canonical duplicate guidance is not crowded out',
      'hybrid exact token - INDEX_NOT_INITIALIZED',
      'hybrid non-regression - paraphrased atomic save',
    ],
  },
  {
    file: 'dogfood-rotating-arena.yml',
    expectedCases: [
      'arena precision - current rollback beats archived note',
      'arena hybrid - exact model id remains findable',
      'arena hybrid - exact parser token remains findable',
      'arena duplicate - canonical source survives shadow copy',
    ],
  },
] as const;

async function readFixture(file: string) {
  const raw = await fsp.readFile(path.join(FIXTURE_DIR, file), 'utf-8');
  return {
    raw,
    fixture: normalizeRetrievalEvalFixture(yaml.load(raw)),
  };
}

function referencedSources(fixture: ReturnType<typeof normalizeRetrievalEvalFixture>): string[] {
  return fixture.cases.flatMap((fixtureCase) => [
    ...fixtureCase.requiredSources,
    ...fixtureCase.forbiddenSources,
  ]);
}

function stableDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe('dogfood retrieval eval fixtures', () => {
  it.each(DOGFOOD_FIXTURES)('parses $file with stable warning-only cases', async ({ file, expectedCases }) => {
    const { raw, fixture } = await readFixture(file);

    expect(fixture.gate).toBe(false);
    expect(fixture.mode).toBe('auto');
    expect(fixture.cases.map((fixtureCase) => fixtureCase.name)).toEqual(expectedCases);
    expect(fixture.cases.every((fixtureCase) => fixtureCase.kb === 'dogfood')).toBe(true);
    expect(new Set(fixture.cases.map((fixtureCase) => fixtureCase.query)).size).toBe(fixture.cases.length);
    expect(raw.match(/source-of-truth:/g)).toHaveLength(fixture.cases.length);
  });

  it('keeps every dogfood source judgment inside the committed corpus', async () => {
    for (const { file } of DOGFOOD_FIXTURES) {
      const { fixture } = await readFixture(file);

      for (const source of referencedSources(fixture)) {
        expect(source.startsWith('docs/testing/fixtures/dogfood-corpus/')).toBe(true);
        expect((await fsp.stat(path.join(process.cwd(), source))).isFile()).toBe(true);
      }
    }
  });

  it('covers smoke, recall, precision, duplicate-budget, and hybrid/non-regression cases', async () => {
    const { fixture } = await readFixture('dogfood-frozen-core.yml');
    const names = fixture.cases.map((fixtureCase) => fixtureCase.name);

    expect(names.some((name) => name.startsWith('smoke -'))).toBe(true);
    expect(names.some((name) => name.startsWith('recall floor -'))).toBe(true);
    expect(names.some((name) => name.startsWith('precision floor -'))).toBe(true);
    expect(fixture.cases.some((fixtureCase) => fixtureCase.maxDuplicateGroups === 1)).toBe(true);
    expect(fixture.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'hybrid exact token - INDEX_NOT_INITIALIZED', mode: 'auto' }),
      expect.objectContaining({ name: 'hybrid non-regression - paraphrased atomic save', mode: 'hybrid' }),
    ]));
  });

  it('has a deterministic provider-free fixture and corpus digest for CI', async () => {
    const normalizedFixtures = [];
    for (const { file } of DOGFOOD_FIXTURES) {
      normalizedFixtures.push((await readFixture(file)).fixture);
    }

    const corpusFiles = (await fsp.readdir(CORPUS_DIR, { recursive: true }))
      .filter((entry) => entry.endsWith('.md'))
      .sort();
    const corpus = await Promise.all(corpusFiles.map(async (file) => [
      file,
      await fsp.readFile(path.join(CORPUS_DIR, file), 'utf-8'),
    ]));

    expect(stableDigest({ normalizedFixtures, corpus })).toBe(
      'efc9f96676f70fe4ac4185ae304ae3719d05f636848e7586ab3f180b38baeaed',
    );
  });
});
