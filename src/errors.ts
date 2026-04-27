export type KBErrorCode =
  | 'INDEX_NOT_INITIALIZED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_AUTH'
  | 'KB_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'CORRUPT_INDEX'
  | 'VALIDATION'
  | 'INTERNAL';

export class KBError extends Error {
  readonly code: KBErrorCode;
  override readonly cause?: unknown;

  constructor(code: KBErrorCode, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'KBError';
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
