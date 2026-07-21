import { createHash } from 'crypto';
import { describe, expect, it } from '@jest/globals';
import { slugifyTitle } from './slug.js';

function expectedHash(title: string): string {
  return createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 8);
}

describe('slugifyTitle', () => {
  it('slugifies Latin titles to kebab-case', () => {
    expect(slugifyTitle('Hello, World!')).toBe('hello-world');
    expect(slugifyTitle('Deploy runbook v2')).toBe('deploy-runbook-v2');
  });

  it('strips combining marks so accented Latin remains readable', () => {
    expect(slugifyTitle('Café résumé')).toBe('cafe-resume');
  });

  it('honors maxLength for readable slugs', () => {
    const long = 'a'.repeat(100);
    expect(slugifyTitle(long, { maxLength: 12 })).toBe('a'.repeat(12));
  });

  it('honors a custom fallback prefix for non-Latin titles', () => {
    const title = '知识库笔记';
    expect(slugifyTitle(title, { fallback: 'ask-transcript' })).toBe(
      `ask-transcript-${expectedHash(title)}`,
    );
  });

  it('uses fallback-hash for empty / punctuation-only titles', () => {
    expect(slugifyTitle('')).toBe(`note-${expectedHash('')}`);
    expect(slugifyTitle('!!!')).toBe(`note-${expectedHash('!!!')}`);
    expect(slugifyTitle('   ')).toBe(`note-${expectedHash('   ')}`);
  });

  it('gives distinct deterministic filenames to different non-Latin titles', () => {
    const chineseA = '第一个笔记';
    const chineseB = '第二个笔记';
    const japanese = '日本語のノート';
    const arabic = 'مذكرة عربية';
    const cyrillic = 'Заметка';
    const korean = '한국어 노트';

    const slugA = slugifyTitle(chineseA);
    const slugB = slugifyTitle(chineseB);
    const slugJa = slugifyTitle(japanese);
    const slugAr = slugifyTitle(arabic);
    const slugRu = slugifyTitle(cyrillic);
    const slugKo = slugifyTitle(korean);

    expect(slugA).toBe(`note-${expectedHash(chineseA)}`);
    expect(slugB).toBe(`note-${expectedHash(chineseB)}`);
    expect(slugJa).toBe(`note-${expectedHash(japanese)}`);
    expect(slugAr).toBe(`note-${expectedHash(arabic)}`);
    expect(slugRu).toBe(`note-${expectedHash(cyrillic)}`);
    expect(slugKo).toBe(`note-${expectedHash(korean)}`);

    const all = [slugA, slugB, slugJa, slugAr, slugRu, slugKo];
    expect(new Set(all).size).toBe(all.length);
  });

  it('is deterministic for the same non-Latin title', () => {
    const title = '同じタイトル';
    // Two independent calls must both match the independent hash oracle.
    const once = slugifyTitle(title);
    const twice = slugifyTitle(title);
    expect(once).toBe(twice);
    expect(once).toBe(`note-${expectedHash(title)}`);
  });

  it('does not apply maxLength to the empty-slug hash stem', () => {
    const title = '中文';
    // Truncating the fingerprint would raise collision risk; keep full stem.
    expect(slugifyTitle(title, { maxLength: 4 })).toBe(`note-${expectedHash(title)}`);
  });

  it('keeps mixed Latin+script titles readable when any ASCII alnum remains', () => {
    // Latin letters survive the filter; CJK is stripped — not empty-slug path.
    expect(slugifyTitle('RFC 日本語 draft')).toBe('rfc-draft');
  });
});
