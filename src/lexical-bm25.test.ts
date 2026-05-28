import { describe, expect, it } from '@jest/globals';
import { LexicalBm25Ranker, tokenizeLexicalText } from './lexical-bm25.js';

describe('LexicalBm25Ranker', () => {
  it('tokenizes punctuation, case, and camelCase consistently', () => {
    expect(tokenizeLexicalText('INDEX_NOT_INITIALIZED parseHTTPResponse v2.1')).toEqual([
      'index',
      'not',
      'initialized',
      'parse',
      'httpresponse',
      'v2',
      '1',
    ]);
  });

  it('keeps non-Latin lexical terms searchable', () => {
    expect(tokenizeLexicalText('東京 障害対応 кириллица')).toEqual([
      '東京',
      '障害対応',
      'кириллица',
    ]);

    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'ja', text: '東京 障害対応 手順' },
      { item: 'en', text: 'ordinary incident response' },
    ]);
    expect(ranker.query('東京 障害対応', 1)[0]?.item).toBe('ja');
  });

  it('uses title weighting as a general retrieval signal', () => {
    const ranker = LexicalBm25Ranker.fromRecords([
      { item: 'title-hit', title: 'Graph rollback', text: 'ordinary runbook body' },
      { item: 'body-hit', title: 'Ordinary', text: 'rollback rollback rollback body' },
    ], { k1: 1.2, b: 0.75, titleWeight: 6 });

    expect(ranker.query('graph rollback', 2)[0]?.item).toBe('title-hit');
  });
});
