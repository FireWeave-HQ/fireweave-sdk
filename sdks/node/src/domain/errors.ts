/**
 * Fireweave canonical error taxonomy (spec/errors.schema.json, contracts/errors.json).
 *
 * 15 PascalCase kinds mapped to OpenFeature error codes. Rules:
 *  - defaults never throw: evaluation paths surface errors via Decision, not exceptions;
 *  - no secrets in messages: all outward-facing messages are redacted;
 *  - cause preserved internally (`FireweaveError.cause`), never serialized outward.
 */

export type FireweaveErrorKind =
  | 'NotReady'
  | 'FlagNotFound'
  | 'TypeMismatch'
  | 'InvalidContext'
  | 'Authentication'
  | 'Authorization'
  | 'RateLimited'
  | 'Timeout'
  | 'Network'
  | 'BackendUnavailable'
  | 'MalformedResponse'
  | 'UnsupportedCapability'
  | 'Configuration'
  | 'AlreadyClosed'
  | 'Internal';

/** OpenFeature error code strings (mirrors @openfeature/core ErrorCode values). */
export type OpenFeatureErrorCode =
  | 'PROVIDER_NOT_READY'
  | 'PROVIDER_FATAL'
  | 'FLAG_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'TYPE_MISMATCH'
  | 'TARGETING_KEY_MISSING'
  | 'INVALID_CONTEXT'
  | 'GENERAL';

export interface ErrorKindSpec {
  readonly kind: FireweaveErrorKind;
  readonly openFeatureErrorCode: OpenFeatureErrorCode;
  readonly retryable: boolean;
  readonly errorClass: 'transient' | 'permanent';
  readonly defaultMessage: string;
}

const spec = (
  kind: FireweaveErrorKind,
  openFeatureErrorCode: OpenFeatureErrorCode,
  retryable: boolean,
  errorClass: 'transient' | 'permanent',
  defaultMessage: string,
): ErrorKindSpec => ({ kind, openFeatureErrorCode, retryable, errorClass, defaultMessage });

export const ERROR_TAXONOMY: Readonly<Record<FireweaveErrorKind, ErrorKindSpec>> = Object.freeze({
  NotReady: spec('NotReady', 'PROVIDER_NOT_READY', true, 'transient', 'provider not ready'),
  FlagNotFound: spec('FlagNotFound', 'FLAG_NOT_FOUND', false, 'permanent', 'flag not found'),
  TypeMismatch: spec('TypeMismatch', 'TYPE_MISMATCH', false, 'permanent', 'flag type mismatch'),
  InvalidContext: spec('InvalidContext', 'INVALID_CONTEXT', false, 'permanent', 'invalid evaluation context'),
  Authentication: spec('Authentication', 'GENERAL', false, 'permanent', 'authentication failed'),
  Authorization: spec('Authorization', 'GENERAL', false, 'permanent', 'authorization failed'),
  RateLimited: spec('RateLimited', 'GENERAL', true, 'transient', 'rate limited'),
  Timeout: spec('Timeout', 'GENERAL', true, 'transient', 'request timed out'),
  Network: spec('Network', 'GENERAL', true, 'transient', 'network error'),
  BackendUnavailable: spec('BackendUnavailable', 'GENERAL', true, 'transient', 'backend unavailable'),
  MalformedResponse: spec('MalformedResponse', 'PARSE_ERROR', false, 'permanent', 'malformed backend response'),
  UnsupportedCapability: spec('UnsupportedCapability', 'GENERAL', false, 'permanent', 'unsupported capability'),
  Configuration: spec('Configuration', 'PROVIDER_FATAL', false, 'permanent', 'invalid configuration'),
  AlreadyClosed: spec('AlreadyClosed', 'PROVIDER_NOT_READY', false, 'permanent', 'provider already closed'),
  Internal: spec('Internal', 'GENERAL', false, 'permanent', 'internal error'),
});

const SECRET_PATTERNS: readonly RegExp[] = [
  /ph[csx]_[A-Za-z0-9]*/g, // project / secret / legacy personal API keys
  /Bearer\s+[^\s"']+/g, // bearer tokens
  /FW_PROJECT_API_KEY\s*[=:]\s*[^\s"']+/g,
];

/** Redact secret-shaped substrings; collapse whitespace runs; trim. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export interface FireweaveErrorOptions {
  /** Custom message; will be redacted. Defaults to the taxonomy default message. */
  message?: string;
  /** Underlying cause, preserved internally only. */
  cause?: unknown;
  /** Override the OF code (e.g. TARGETING_KEY_MISSING for InvalidContext). */
  openFeatureErrorCode?: OpenFeatureErrorCode;
  /** Extra fireweave.* flag metadata to surface with error decisions. */
  metadata?: Record<string, string | number | boolean>;
}

export class FireweaveError extends Error {
  readonly kind: FireweaveErrorKind;
  readonly openFeatureErrorCode: OpenFeatureErrorCode;
  readonly retryable: boolean;
  readonly errorClass: 'transient' | 'permanent';
  /** Deterministic outward-facing message from the taxonomy. */
  readonly safeMessage: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;

  constructor(kind: FireweaveErrorKind, options: FireweaveErrorOptions = {}) {
    const taxonomy = ERROR_TAXONOMY[kind];
    const message = options.message !== undefined ? redactSecrets(options.message) : taxonomy.defaultMessage;
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FireweaveError';
    this.kind = kind;
    this.openFeatureErrorCode = options.openFeatureErrorCode ?? taxonomy.openFeatureErrorCode;
    this.retryable = taxonomy.retryable;
    this.errorClass = taxonomy.errorClass;
    this.safeMessage = taxonomy.defaultMessage;
    this.metadata = Object.freeze({ ...(options.metadata ?? {}) });
  }
}

export function isFireweaveError(err: unknown): err is FireweaveError {
  return err instanceof FireweaveError;
}
