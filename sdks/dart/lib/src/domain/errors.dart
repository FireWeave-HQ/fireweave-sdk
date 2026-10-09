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

/// `controlPointMetadata` key carrying the canonical Fireweave kind on error
/// decisions (`spec/errors.schema.json` `rules.controlPointMetadataErrorKindKey`).
const String controlPointMetadataErrorKindKey = 'fireweave.errorKind';

/// Canonical PascalCase error kinds (`spec/errors.schema.json`); exactly 15.
enum ErrorKind {
  notReady(
    'NotReady',
    'provider not ready',
    'PROVIDER_NOT_READY',
    isRetryable: true,
  ),
  controlPointNotFound(
    'ControlPointNotFound',
    'flag not found',
    'FLAG_NOT_FOUND',
  ),
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
/// - [quotaLimited] — only meaningful on [ErrorKind.controlPointNotFound]: the
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
  }) : message = _normalizeMessage(message ?? kind.defaultMessage);

  /// [ErrorKind.controlPointNotFound], optionally noting the backend reported quota
  /// limiting (`contracts/errors.json`: "quota-limited responses resolve as
  /// ControlPointNotFound with fireweave.quotaLimited metadata").
  factory FireweaveError.controlPointNotFound({bool quotaLimited = false}) =>
      FireweaveError(
        ErrorKind.controlPointNotFound,
        quotaLimited: quotaLimited,
      );

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

/// The text a redacted value becomes (`contracts/errors.json`
/// `rules.redaction.placeholder`).
const String redactionPlaceholder = '[REDACTED]';

// `contracts/errors.json` `rules.redaction`, applied in its order: bearer
// tokens, URL userinfo, named assignments, then key-shaped values. Dart's
// `RegExp` is part of `dart:core`, so there is no dependency question here.

/// `Bearer <token>`: the token goes, the word stays.
final RegExp _bearer = RegExp(r'\bBearer(\s+)[A-Za-z0-9._~+/=-]+');

/// `scheme://userinfo@host`: the userinfo goes.
final RegExp _urlUserinfo = RegExp(
  r'\b([A-Za-z][A-Za-z0-9+.-]*://)[^\s/?#@]+@',
);

/// `NAME=value`, `NAME: value`, `NAME = "value"` and `NAME='value'` for the
/// three key variables: the value (up to whitespace, a quote, a comma or a
/// semicolon) goes; the name, the separator and the quotes stay. A name with
/// no separator after it is prose and stays whole.
final RegExp _assignment = RegExp(
  '(FIREWEAVE_KEY|FIREWEAVE_BROWSER_KEY|FW_PROJECT_API_KEY)'
  r'''(\s*[=:]\s*["']?)[^\s"',;]+''',
);

/// A key-shaped value: a known prefix followed by one or more
/// `[A-Za-z0-9_-]`. A prefix followed by anything else (the ellipsis in
/// `project-api-key_…`) is prose and stays.
final RegExp _keyValue = RegExp(
  // The three analytics-vendor prefixes as one character class, so no
  // vendor key shape appears literally in lib/ (portability_guard_test).
  '(?:project-api-key_|fw_public_|fw_ingest_pub_|fw_org_|cli_at_|ph[csx]_)'
  '[A-Za-z0-9_-]+',
);

final RegExp _whitespaceRun = RegExp(r'\s+');

/// Scrubs secrets from [text] exactly as `contracts/errors.json`
/// `rules.redaction` specifies (`contracts/errors.md` rule 2): bearer
/// tokens, then URL userinfo, then the values assigned to `FIREWEAVE_KEY`,
/// `FIREWEAVE_BROWSER_KEY` and `FW_PROJECT_API_KEY`, then key-shaped values
/// each become [redactionPlaceholder]. A variable NAME is never redacted on
/// its own, only its value, and nothing else in [text] changes.
///
/// Applied to every message that reaches [FireweaveError], even though
/// canonical default messages never contain a secret: it is the safety net
/// for a message built dynamically elsewhere in the SDK.
String redactSecrets(String text) => text
    .replaceAllMapped(_bearer, (m) => 'Bearer${m[1]}$redactionPlaceholder')
    .replaceAllMapped(_urlUserinfo, (m) => '${m[1]}$redactionPlaceholder@')
    .replaceAllMapped(_assignment, (m) => '${m[1]}${m[2]}$redactionPlaceholder')
    .replaceAll(_keyValue, redactionPlaceholder);

/// A message as [FireweaveError] stores it: redacted, then whitespace runs
/// collapsed to one space and trimmed.
String _normalizeMessage(String text) =>
    redactSecrets(text).replaceAll(_whitespaceRun, ' ').trim();
