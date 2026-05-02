/**
 * Coerce an unknown thrown value into an `Error`.
 *
 * Strict mode (`tsconfig.json` `useUnknownInCatchVariables`) types `catch`
 * variables as `unknown`; this helper narrows once at the catch boundary so
 * callers can rely on `err.message` / `err.stack` without re-checking.
 *
 * - `Error` in -> returned by reference (preserves prototype, `cause`, and any
 *   ad-hoc properties like `__alreadyLogged` set by callers further up).
 * - `string` in -> `new Error(x)`.
 * - anything else -> `new Error(JSON.stringify(x))`. JSON-encoding is best-effort:
 *   if it throws (cycle, BigInt) we fall back to `String(x)` so the helper
 *   itself never throws inside a catch.
 */
export function toError(x: unknown): Error {
  if (x instanceof Error) return x;
  if (typeof x === 'string') return new Error(x);
  try {
    return new Error(JSON.stringify(x));
  } catch {
    return new Error(String(x));
  }
}
