export const KB_INDEX_TYPE_ENV = 'KB_INDEX_TYPE';

export type FaissIndexType = 'flat' | 'sq8';

export const DEFAULT_FAISS_INDEX_TYPE: FaissIndexType = 'flat';

export function parseFaissIndexType(raw: string | undefined): FaissIndexType {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === undefined || normalized === '') {
    return DEFAULT_FAISS_INDEX_TYPE;
  }
  if (normalized === 'flat' || normalized === 'sq8') {
    return normalized;
  }
  throw new Error(
    `${KB_INDEX_TYPE_ENV} must be one of: flat, sq8; got ${JSON.stringify(raw)}`,
  );
}

export function resolveFaissIndexType(
  raw: string | undefined = process.env[KB_INDEX_TYPE_ENV],
): FaissIndexType {
  return parseFaissIndexType(raw);
}
