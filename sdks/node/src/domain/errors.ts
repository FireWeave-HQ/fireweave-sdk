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

/**
 * The redaction contract (contracts/errors.json `rules.redaction`, start-profile
 * SP-26). Applied in this order: bearer tokens, URL userinfo, named
 * assignments, then key-shaped values. A variable NAME is never redacted on its
 * own; only its value is. `test/unit/redaction-contract.test.ts` runs every
 * contract vector through `redactSecrets`.
 */
const REDACTION_PLACEHOLDER = '[REDACTED]';

/** Variables whose assigned value is scrubbed: `NAME=value`, `NAME: value`, `NAME = "value"`. */
const ASSIGNMENT_NAMES: readonly string[] = ['FIREWEAVE_KEY', 'FIREWEAVE_BROWSER_KEY', 'FW_PROJECT_API_KEY'];

/** Key families; a prefix only counts when one or more of [A-Za-z0-9_-] follows it. */
const VALUE_PREFIXES: readonly string[] = [
  'project-api-key_',
  'fw_public_',
  'fw_ingest_pub_',
  'fw_org_',
  'cli_at_',
  'phc_',
  'phx_',
  'phs_',
];

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const BEARER = /\bBearer(\s+)[A-Za-z0-9._~+/=-]+/g;
// scheme://userinfo@host: userinfo cannot hold whitespace, '/', '?', '#' or '@'.
const URL_USERINFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/?#@]+@/g;
// The name stays, as do the separator and any opening quote; the value runs to
// whitespace, a quote, a comma or a semicolon. The lookbehind keeps a longer
// name that merely ends in one of these (MY_FIREWEAVE_KEY) out of scope.
const ASSIGNMENT = new RegExp(
  `(?<![A-Za-z0-9_])(${ASSIGNMENT_NAMES.map(escapeRegExp).join('|')})(\\s*[=:]\\s*)(["']?)[^\\s"',;]+`,
  'g',
);
// No leading boundary: a key glued to other text is still a key.
const KEY_VALUE = new RegExp(`(?:${VALUE_PREFIXES.map(escapeRegExp).join('|')})[A-Za-z0-9_-]+`, 'g');

/**
 * Scrub secrets per the redaction contract, then collapse whitespace runs and
 * trim (so a message stays on one log line).
 */
export function redactSecrets(text: string): string {
  const out = text
    .replace(BEARER, `Bearer$1${REDACTION_PLACEHOLDER}`)
    .replace(URL_USERINFO, `$1${REDACTION_PLACEHOLDER}@`)
    .replace(ASSIGNMENT, `$1$2$3${REDACTION_PLACEHOLDER}`)
    .replace(KEY_VALUE, REDACTION_PLACEHOLDER);
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
