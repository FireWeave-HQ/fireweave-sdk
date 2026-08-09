/**
 * Error taxonomy for the browser SDK.
 *
 * Same kinds and same OpenFeature mapping as the server SDK, because the wire
 * protocol and the failure modes are the same — a 401 is a 401 whether it is a
 * server or a browser asking. Reimplemented here rather than shared so the
 * browser package keeps zero cross-package coupling and can be audited on its
 * own; `spec/errors.schema.json` is the source both follow.
 *
 * Messages are FIXED per kind. A browser error is visible in a devtools console
 * on a machine we do not control, so nothing host-, key-, or response-derived
 * is ever interpolated into one.
 */

export type FireweaveErrorKind =
  | 'Configuration'
  | 'Authentication'
  | 'Authorization'
  | 'Network'
  | 'Timeout'
  | 'RateLimited'
  | 'BackendUnavailable'
  | 'MalformedResponse'
  | 'InvalidContext'
  | 'FlagNotFound'
  | 'TypeMismatch'
  | 'NotReady'
  | 'AlreadyClosed'
  | 'UnsupportedCapability'
  | 'Internal';

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
  readonly message: string;
  readonly openFeatureErrorCode: OpenFeatureErrorCode;
  /** Whether an identical retry could plausibly succeed. */
  readonly retryable: boolean;
}

export const ERROR_TAXONOMY: Readonly<Record<FireweaveErrorKind, ErrorKindSpec>> = Object.freeze({
  Configuration: {
    message: 'invalid configuration',
    openFeatureErrorCode: 'PROVIDER_FATAL',
    retryable: false,
  },
  Authentication: {
    message: 'authentication failed',
    openFeatureErrorCode: 'PROVIDER_FATAL',
    retryable: false,
  },
  Authorization: {
    message: 'not authorized',
    openFeatureErrorCode: 'PROVIDER_FATAL',
    retryable: false,
  },
  Network: { message: 'network error', openFeatureErrorCode: 'GENERAL', retryable: true },
  Timeout: { message: 'request timed out', openFeatureErrorCode: 'GENERAL', retryable: true },
  RateLimited: { message: 'rate limited', openFeatureErrorCode: 'GENERAL', retryable: true },
  BackendUnavailable: {
    message: 'backend unavailable',
    openFeatureErrorCode: 'GENERAL',
    retryable: true,
  },
  MalformedResponse: {
    message: 'malformed response',
    openFeatureErrorCode: 'PARSE_ERROR',
    retryable: false,
  },
  InvalidContext: {
    message: 'invalid evaluation context',
    openFeatureErrorCode: 'INVALID_CONTEXT',
    retryable: false,
  },
  FlagNotFound: {
    message: 'flag not found',
    openFeatureErrorCode: 'FLAG_NOT_FOUND',
    retryable: false,
  },
  TypeMismatch: {
    message: 'type mismatch',
    openFeatureErrorCode: 'TYPE_MISMATCH',
    retryable: false,
  },
  NotReady: {
    message: 'provider not ready',
    openFeatureErrorCode: 'PROVIDER_NOT_READY',
    retryable: true,
  },
  AlreadyClosed: {
    message: 'provider already closed',
    openFeatureErrorCode: 'PROVIDER_FATAL',
    retryable: false,
  },
  UnsupportedCapability: {
    message: 'unsupported capability',
    openFeatureErrorCode: 'GENERAL',
    retryable: false,
  },
  Internal: { message: 'internal error', openFeatureErrorCode: 'GENERAL', retryable: false },
});

export interface FireweaveErrorOptions {
  /** Overrides the taxonomy's OpenFeature code (e.g. a missing targeting key). */
  readonly openFeatureErrorCode?: OpenFeatureErrorCode;
  readonly metadata?: Record<string, string | number | boolean>;
  readonly cause?: unknown;
}

export class FireweaveError extends Error {
  readonly kind: FireweaveErrorKind;
  readonly openFeatureErrorCode: OpenFeatureErrorCode;
  readonly retryable: boolean;
  readonly metadata: Record<string, string | number | boolean>;

  constructor(kind: FireweaveErrorKind, options: FireweaveErrorOptions = {}) {
    const spec = ERROR_TAXONOMY[kind];
    super(spec.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FireweaveError';
    this.kind = kind;
    this.openFeatureErrorCode = options.openFeatureErrorCode ?? spec.openFeatureErrorCode;
    this.retryable = spec.retryable;
    this.metadata = { ...(options.metadata ?? {}) };
  }
}

export function isFireweaveError(value: unknown): value is FireweaveError {
  return value instanceof FireweaveError;
}
