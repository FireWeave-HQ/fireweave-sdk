/// Fireweave canonical error taxonomy (`spec/errors.schema.json`, 15 kinds).
///
/// Rules implemented here:
///
/// - **Defaults do not throw**: the runtime converts these errors into
///   default-valued decisions; control-point reads never raise for abnormal
///   evaluation (`spec/control-points.md` "Return discipline"). In Dart
///   terms: [FireweaveError] is a plain value returned from fallible
///   internals, never thrown from a read-path public method — only
///   `initFireweave` surfaces it as a throw.
/// - **No secrets in messages**: every message that crosses
///   [FireweaveError]'s constructor runs through [redactSecrets]; canonical
///   default messages never echo credentials in the first place.
library;

/// `flagMetadata` key carrying the canonical Fireweave kind on error
/// decisions (`spec/errors.schema.json` `rules.flagMetadataErrorKindKey`).
const String flagMetadataErrorKindKey = 'fireweave.errorKind';

/// Canonical PascalCase error kinds (`spec/errors.schema.json`); exactly 15.
enum ErrorKind {
  notReady(
    'NotReady',
    'provider not ready',
    'PROVIDER_NOT_READY',
    isRetryable: true,
  ),
  flagNotFound('FlagNotFound', 'flag not found', 'FLAG_NOT_FOUND'),
  typeMismatch('TypeMismatch', 'flag type mismatch', 'TYPE_MISMATCH'),
  invalidContext(
    'InvalidContext',
    'invalid evaluation context',
    'INVALID_CONTEXT',
  ),
  authentication('Authentication', 'authentication failed', 'GENERAL'),
  authorization('Authorization', 'authorization failed', 'GENERAL'),
  rateLimited('RateLimited', 'rate limited', 'GENERAL', isRetryable: true),
  timeout('Timeout', 'request timed out', 'GENERAL', isRetryable: true),
  network('Network', 'network error', 'GENERAL', isRetryable: true),
  backendUnavailable(
    'BackendUnavailable',
    'backend unavailable',
    'GENERAL',
    isRetryable: true,
  ),
  malformedResponse(
    'MalformedResponse',
    'malformed backend response',
    'PARSE_ERROR',
  ),
  unsupportedCapability(
    'UnsupportedCapability',
    'unsupported capability',
    'GENERAL',
  ),
  // Runtime path; init-fatal overrides to PROVIDER_FATAL (see
  // FireweaveError.openFeatureErrorCode).
  configuration('Configuration', 'invalid configuration', 'GENERAL'),
  alreadyClosed(
    'AlreadyClosed',
    'provider already closed',
    'PROVIDER_NOT_READY',
  ),
  internal('Internal', 'internal error', 'GENERAL');

  const ErrorKind(
    this.wireName,
    this.defaultMessage,
    this._baseOpenFeatureCode, {
    this.isRetryable = false,
  });

  /// The canonical PascalCase name (`fireweave.errorKind` metadata value).
  final String wireName;

  /// Canonical safe default message for this kind (`contracts/errors.json`).
  final String defaultMessage;

  /// Baseline OpenFeature error-code mapping (`spec/errors.schema.json`).
  /// `InvalidContext` -> `TARGETING_KEY_MISSING` and `Configuration` ->
  /// `PROVIDER_FATAL` are subtype overrides carried on [FireweaveError]
  /// itself, not here.
  final String _baseOpenFeatureCode;

  /// `contracts/errors.json`: kinds that a later identical call may succeed
  /// at without a configuration change.
  final bool isRetryable;

  /// Parses a wire name; `null` when it is not one of the fifteen.
  static ErrorKind? fromWireName(String raw) {
    for (final kind in values) {
      if (kind.wireName == raw) {
        return kind;
      }
    }
    return null;
  }
}

/// A concrete Fireweave error occurrence.
///
/// Carries the canonical [kind] and a secret-redacted [message]. Three
/// booleans thread the subtype/behavioral flags the reference SDKs model as
/// constructor keyword args (python) / dedicated struct fields (go/rust/
/// swift):
///
/// - [quotaLimited] — only meaningful on [ErrorKind.flagNotFound]: the
///   backend reported quota limiting for this evaluation
///   (`spec/decision.schema.json` `standardMetadataKeys`).
/// - [initFatal] — only meaningful on [ErrorKind.configuration]: whether
///   this occurrence is on the init-fatal path (`PROVIDER_FATAL`) rather
///   than a runtime path (`GENERAL`).
/// - [targetingKeyMissing] — only meaningful on [ErrorKind.invalidContext]:
///   whether this occurrence is specifically a missing targeting key
///   (`TARGETING_KEY_MISSING`) rather than a generic context failure
///   (`INVALID_CONTEXT`).
class FireweaveError implements Exception {
  FireweaveError(
    this.kind, {
    String? message,
    this.quotaLimited = false,
    this.initFatal = false,
    this.targetingKeyMissing = false,
  }) : message = redactSecrets(message ?? kind.defaultMessage);

  /// [ErrorKind.flagNotFound], optionally noting the backend reported quota
  /// limiting (`contracts/errors.json`: "quota-limited responses resolve as
  /// FlagNotFound with fireweave.quotaLimited metadata").
  factory FireweaveError.flagNotFound({bool quotaLimited = false}) =>
      FireweaveError(ErrorKind.flagNotFound, quotaLimited: quotaLimited);

  /// [ErrorKind.invalidContext] subtype: missing targeting key
  /// (`spec/control-points.md` "Context"). OF code `TARGETING_KEY_MISSING`.
  factory FireweaveError.targetingKeyMissing() => FireweaveError(
    ErrorKind.invalidContext,
    message: 'targeting key missing',
    targetingKeyMissing: true,
  );

  /// [ErrorKind.configuration], with [initFatal] controlling the OF
  /// error-code subtype (`spec/modes.md` "Initialisation validation": every
  /// row there raises with `initFatal: true`).
  factory FireweaveError.configuration(
    String message, {
    required bool initFatal,
  }) => FireweaveError(
    ErrorKind.configuration,
    message: message,
    initFatal: initFatal,
  );

  final ErrorKind kind;
  final String message;
  final bool quotaLimited;
  final bool initFatal;
  final bool targetingKeyMissing;

  /// Whether a later identical call may succeed without a configuration
  /// change (`contracts/errors.json`).
  bool get isRetryable => kind.isRetryable;

  /// OpenFeature error-code string for this occurrence, applying the two
  /// documented subtype overrides
  /// (`spec/errors.schema.json` `openFeatureErrorCodeAlternates`).
  String get openFeatureErrorCode {
    if (kind == ErrorKind.invalidContext && targetingKeyMissing) {
      return 'TARGETING_KEY_MISSING';
    }
    if (kind == ErrorKind.configuration && initFatal) {
      return 'PROVIDER_FATAL';
    }
    return kind._baseOpenFeatureCode;
  }

  @override
  String toString() => 'FireweaveError(${kind.wireName}: $message)';
}

// Matches node/python/rust's
// `(ph[csx]_[A-Za-z0-9_\-]*|Bearer\s+\S+|FW_PROJECT_API_KEY\s*[=:]\s*\S+)`
// byte-for-byte. Dart's `RegExp` is part of `dart:core`, so unlike swift
// (which hand-rolled a scanner to keep its Foundation-only budget honest)
// there is no dependency question here.
final RegExp _secretPattern = RegExp(
  r'ph[csx]_[A-Za-z0-9_\-]*|Bearer\s+\S+|FW_PROJECT_API_KEY\s*[=:]\s*\S+',
);
final RegExp _whitespaceRun = RegExp(r'\s+');

/// Redacts secret-shaped substrings (`spec/errors.schema.json`
/// `secretPatterns`) and collapses whitespace runs. Defensive: applied to
/// every message that reaches [FireweaveError], even though canonical
/// default messages never contain a secret in the first place — this is the
/// safety net for a message built dynamically elsewhere in the SDK.
String redactSecrets(String text) => text
    .replaceAll(_secretPattern, '[REDACTED]')
    .replaceAll(_whitespaceRun, ' ')
    .trim();
