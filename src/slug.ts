import { createHash } from 'crypto';

export interface SlugifyTitleOptions {
  fallback?: string;
  maxLength?: number;
}

/** Short, stable fingerprint so empty Latin slugs still differ by title. */
function shortTitleHash(title: string): string {
  return createHash('sha256').update(title, 'utf8').digest('hex').slice(0, 8);
}

/**
 * Derive a filesystem-safe filename stem from a note title.
 *
 * Latin / ASCII-friendly titles keep a readable kebab-case slug. Titles whose
 * characters are all stripped by the `[a-z0-9]` filter (CJK, Arabic, Cyrillic,
 * punctuation-only, empty) used to collapse to a shared fallback (`note`), so
 * only the first `kb remember` / `kb ask --save-transcript` write could succeed.
 * Those now use `${fallback}-<8-hex>` hashed from the original title so distinct
 * titles get distinct, deterministic paths while exclusive-create (`wx`) still
 * rejects a true same-title collision.
 */
export function slugifyTitle(title: string, options: SlugifyTitleOptions = {}): string {
  const maxLength = options.maxLength ?? 80;
  const fallback = options.fallback ?? 'note';
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (slug.length > 0) {
    return slug.slice(0, maxLength).replace(/-+$/g, '');
  }
  return `${fallback}-${shortTitleHash(title)}`;
}
