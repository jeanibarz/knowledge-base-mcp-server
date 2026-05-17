export interface SlugifyTitleOptions {
  fallback?: string;
  maxLength?: number;
}

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
  return slug.length > 0 ? slug.slice(0, maxLength).replace(/-+$/g, '') : fallback;
}
