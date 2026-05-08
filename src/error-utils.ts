import * as path from 'path';
import { KBError } from './errors.js';
import { logger } from './logger.js';

type FsError = NodeJS.ErrnoException & { code?: string };

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

export function isPermissionError(error: unknown): error is FsError {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const code = (error as FsError).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/**
 * Translate filesystem operation failures into operator-facing errors.
 *
 * Permission-like failures become `KBError('PERMISSION_DENIED')`; all thrown
 * errors are marked `__alreadyLogged` so outer catch blocks do not log the
 * same failure twice.
 */
export function handleFsOperationError(
  action: string,
  targetPath: string,
  error: unknown,
): never {
  const pathDescription = path.resolve(targetPath);
  const stack = (error as Error)?.stack;
  if (isPermissionError(error)) {
    const message = `Permission denied while attempting to ${action} ${pathDescription}. Grant write access and retry.`;
    logger.error(message);
    if (stack) {
      logger.error(stack);
    }
    const loggedError = new KBError('PERMISSION_DENIED', message, error) as KBError & {
      __alreadyLogged?: boolean;
    };
    loggedError.__alreadyLogged = true;
    throw loggedError;
  }
  logger.error(`Failed to ${action} ${pathDescription}:`, error);
  if (stack) {
    logger.error(stack);
  }
  if (error instanceof Error) {
    (error as Error & { __alreadyLogged?: boolean }).__alreadyLogged = true;
    throw error;
  }
  const newError = new Error(`Failed to ${action} ${pathDescription}: ${String(error)}`) as Error & {
    __alreadyLogged?: boolean;
  };
  newError.__alreadyLogged = true;
  throw newError;
}
