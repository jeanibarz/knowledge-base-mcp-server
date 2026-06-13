import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { Document } from '@langchain/core/documents';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  createSimilaritySearchPostFilter,
  parseRecencyFilterRange,
  type ScoredDocument,
} from './search-filters.js';

describe('parseRecencyFilterRange (#609)', () => {
  const nowMs = Date.parse('2026-06-13T12:00:00Z');

  it('accepts duration and ISO date bounds deterministically', () => {
    expect(parseRecencyFilterRange({ since: '30d', until: '24h', nowMs })).toEqual({
      sinceMs: Date.parse('2026-05-14T12:00:00Z'),
      untilMs: Date.parse('2026-06-12T12:00:00Z'),
    });
    expect(parseRecencyFilterRange({
      since: '2026-06-01',
      until: '2026-06-02T03:04:05Z',
      nowMs,
    })).toEqual({
      sinceMs: Date.parse('2026-06-01T00:00:00Z'),
      untilMs: Date.parse('2026-06-02T03:04:05Z'),
    });
  });

  it('rejects invalid and inverted ranges', () => {
    expect(() => parseRecencyFilterRange({ since: 'soon', nowMs })).toThrow(/invalid since/);
    expect(() => parseRecencyFilterRange({ until: '0d', nowMs })).toThrow(/invalid until/);
    expect(() => parseRecencyFilterRange({ since: '24h', until: '30d', nowMs })).toThrow(
      /invalid recency range/,
    );
  });
});

describe('createSimilaritySearchPostFilter recency filters (#609)', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeFile(name: string, mtimeIso: string): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-search-filter-recency-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, name);
    await fsp.writeFile(filePath, 'content', 'utf-8');
    const mtime = new Date(mtimeIso);
    await fsp.utimes(filePath, mtime, mtime);
    return filePath;
  }

  function row(source: string | undefined, score = 0.1): ScoredDocument {
    return [
      {
        pageContent: source ?? 'missing source',
        metadata: source === undefined
          ? { relativePath: 'kb/missing.md' }
          : { source, relativePath: `kb/${path.basename(source)}`, extension: '.md' },
      } as Document,
      score,
    ];
  }

  it('filters candidates by current source-file mtime after metadata filters', async () => {
    const recent = await makeFile('recent.md', '2026-06-10T00:00:00Z');
    const old = await makeFile('old.md', '2026-05-01T00:00:00Z');
    const filter = createSimilaritySearchPostFilter({
      threshold: 2,
      knowledgeBasesRootDir: path.dirname(path.dirname(recent)),
      filters: { extensions: ['md'], since: '2026-06-01', until: '2026-06-30' },
    });

    expect(filter.requiresOverfetch).toBe(true);
    expect(filter.apply([row(recent), row(old), row(undefined)]).map(([doc]) => doc.pageContent))
      .toEqual([recent]);
  });

  it('memoizes file stats by source path within one post-filter', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-search-filter-recency-'));
    tempDirs.push(dir);
    const source = path.join(dir, 'memo.md');
    const filter = createSimilaritySearchPostFilter({
      threshold: 2,
      knowledgeBasesRootDir: dir,
      filters: { since: '2026-06-01' },
    });

    expect(filter.apply([row(source)])).toHaveLength(0);

    await fsp.writeFile(source, 'content', 'utf-8');
    const mtime = new Date('2026-06-10T00:00:00Z');
    await fsp.utimes(source, mtime, mtime);

    expect(filter.apply([row(source, 0.2)])).toHaveLength(0);
  });
});
