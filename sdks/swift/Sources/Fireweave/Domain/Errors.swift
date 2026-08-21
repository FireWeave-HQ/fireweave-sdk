/// Fireweave canonical error taxonomy (`spec/errors.schema.json`, 15 kinds).
///
/// Rules implemented here:
///
/// - **Defaults do not throw**: the runtime converts these errors into
///   default-valued decisions; control-point reads never raise for abnormal
///   evaluation (`spec/control-points.md` "Return discipline"). In Swift
///   terms: `FireweaveError` is a plain `Error`-conforming value returned
///   from fallible internals, never `throw`n from a read-path public
///   method — only `initFireweave` surfaces it as a `throw`.
/// - **No secrets in messages**: every message that crosses
///   `FireweaveError`'s initializers runs through `redactSecrets`; canonical
///   default messages never echo credentials in the first place.

/// `flagMetadata` key carrying the canonical Fireweave kind on error
/// decisions (`spec/errors.schema.json` `rules.flagMetadataErrorKindKey`).
public let flagMetadataErrorKindKey = "fireweave.errorKind"

/// Canonical PascalCase error kinds (`spec/errors.schema.json`); exactly 15.
public enum ErrorKind: String, Sendable, Equatable, CaseIterable {
  case notReady = "NotReady"
  case flagNotFound = "FlagNotFound"
  case typeMismatch = "TypeMismatch"
  case invalidContext = "InvalidContext"
  case authentication = "Authentication"
  case authorization = "Authorization"
  case rateLimited = "RateLimited"
  case timeout = "Timeout"
  case network = "Network"
  case backendUnavailable = "BackendUnavailable"
  case malformedResponse = "MalformedResponse"
  case unsupportedCapability = "UnsupportedCapability"
  case configuration = "Configuration"
  case alreadyClosed = "AlreadyClosed"
  case internalError = "Internal"

  /// Canonical safe default message for this kind (`contracts/errors.json`).
  var defaultMessage: String {
    switch self {
    case .notReady: return "provider not ready"
    case .flagNotFound: return "flag not found"
    case .typeMismatch: return "flag type mismatch"
    case .invalidContext: return "invalid evaluation context"
    case .authentication: return "authentication failed"
    case .authorization: return "authorization failed"
    case .rateLimited: return "rate limited"
    case .timeout: return "request timed out"
    case .network: return "network error"
    case .backendUnavailable: return "backend unavailable"
    case .malformedResponse: return "malformed backend response"
    case .unsupportedCapability: return "unsupported capability"
    case .configuration: return "invalid configuration"
    case .alreadyClosed: return "provider already closed"
    case .internalError: return "internal error"
    }
  }

  /// `contracts/errors.json`: kinds that a later identical call may
  /// succeed at without a configuration change.
  public var isRetryable: Bool {
    switch self {
    case .notReady, .rateLimited, .timeout, .network, .backendUnavailable:
      return true
    default:
      return false
    }
  }

  /// Baseline OpenFeature error-code mapping (`spec/errors.schema.json`).
  /// `InvalidContext` -> `TARGETING_KEY_MISSING` and `Configuration` ->
  /// `PROVIDER_FATAL` are subtype overrides carried on `FireweaveError`
  /// itself, not here (see `FireweaveError.openFeatureErrorCode`).
  fileprivate var baseOpenFeatureErrorCode: String {
    switch self {
    case .notReady: return "PROVIDER_NOT_READY"
    case .flagNotFound: return "FLAG_NOT_FOUND"
    case .typeMismatch: return "TYPE_MISMATCH"
    case .invalidContext: return "INVALID_CONTEXT"
    case .authentication, .authorization, .rateLimited, .timeout, .network,
      .backendUnavailable, .unsupportedCapability:
      return "GENERAL"
    case .malformedResponse: return "PARSE_ERROR"
    // Runtime path; init-fatal overrides to PROVIDER_FATAL (see below).
    case .configuration: return "GENERAL"
    case .alreadyClosed: return "PROVIDER_NOT_READY"
    case .internalError: return "GENERAL"
    }
  }
}

/// A concrete Fireweave error occurrence.
///
/// Carries the canonical `kind` and a secret-redacted `message`. Three
/// booleans thread the subtype/behavioral flags the reference SDKs model as
/// constructor keyword args (python) / dedicated struct fields (go/rust):
///
/// - `quotaLimited` — only meaningful on `.flagNotFound`: the backend
///   reported quota limiting for this evaluation
///   (`spec/decision.schema.json` `standardMetadataKeys`).
/// - `initFatal` — only meaningful on `.configuration`: whether this
///   occurrence is on the init-fatal path (`PROVIDER_FATAL`) rather than a
///   runtime path (`GENERAL`).
/// - `targetingKeyMissing` — only meaningful on `.invalidContext`: whether
///   this occurrence is specifically a missing targeting key
///   (`TARGETING_KEY_MISSING`) rather than a generic context failure
///   (`INVALID_CONTEXT`).
public struct FireweaveError: Error, Sendable, Equatable {
  public let kind: ErrorKind
  public let message: String
  public let quotaLimited: Bool
  public let initFatal: Bool
  public let targetingKeyMissing: Bool

  public init(
    kind: ErrorKind,
    message: String? = nil,
    quotaLimited: Bool = false,
    initFatal: Bool = false,
    targetingKeyMissing: Bool = false
  ) {
    self.kind = kind
    self.message = redactSecrets(message ?? kind.defaultMessage)
    self.quotaLimited = quotaLimited
    self.initFatal = initFatal
    self.targetingKeyMissing = targetingKeyMissing
  }

  /// `.flagNotFound`, optionally noting the backend reported quota
  /// limiting (`contracts/errors.json`: "quota-limited responses resolve
  /// as FlagNotFound with fireweave.quotaLimited metadata").
  public static func flagNotFound(quotaLimited: Bool = false) -> FireweaveError {
    FireweaveError(kind: .flagNotFound, quotaLimited: quotaLimited)
  }

  /// `.invalidContext` subtype: missing targeting key
  /// (`spec/control-points.md` "Context"). OF code `TARGETING_KEY_MISSING`.
  public static func targetingKeyMissing() -> FireweaveError {
    FireweaveError(
      kind: .invalidContext, message: "targeting key missing", targetingKeyMissing: true)
  }

  /// `.configuration`, with `initFatal` controlling the OF error-code
  /// subtype (`spec/modes.md` "Initialisation validation": every row here
  /// raises with `initFatal = true`).
  public static func configuration(_ message: String, initFatal: Bool) -> FireweaveError {
    FireweaveError(kind: .configuration, message: message, initFatal: initFatal)
  }

  /// Whether a later identical call may succeed without a configuration
  /// change (`contracts/errors.json`).
  public var isRetryable: Bool { kind.isRetryable }

  /// OpenFeature error-code string for this occurrence, applying the two
  /// documented subtype overrides
  /// (`spec/errors.schema.json` `openFeatureErrorCodeAlternates`).
  public var openFeatureErrorCode: String {
    if kind == .invalidContext && targetingKeyMissing { return "TARGETING_KEY_MISSING" }
    if kind == .configuration && initFatal { return "PROVIDER_FATAL" }
    return kind.baseOpenFeatureErrorCode
  }
}

// MARK: - Secret redaction

// Manual scanner, NOT a regex-backed `NSRegularExpression` — the dependency
// budget for this SDK is "Foundation only", and while `NSRegularExpression`
// IS part of Foundation, hand-rolling the three fixed patterns keeps this
// file trivially auditable and mirrors rust's own choice (task-12) to hand-
// scan rather than pull in a pattern-matching dependency, even though its
// dependency budget is a different shape (crates vs. frameworks). Matches
// node/python/rust's `(ph[csx]_[A-Za-z0-9_\-]*|Bearer\s+\S+|
// FW_PROJECT_API_KEY\s*[=:]\s*\S+)` byte-for-byte on the covered cases.

private let secretKeyPrefixes = ["phc_", "phs_", "phx_"]

private func isKeyChar(_ c: Character) -> Bool {
  c.isASCII && (c.isLetter || c.isNumber || c == "_" || c == "-")
}

/// Matches a `phc_`/`phs_`/`phx_` prefix followed by zero or more
/// `[A-Za-z0-9_-]` characters starting at `start`. Returns the end index of
/// the whole match, if `text` has one there.
private func matchProjectKeyPrefix(_ text: String, at start: String.Index) -> String.Index? {
  for prefix in secretKeyPrefixes where text[start...].hasPrefix(prefix) {
    var end = text.index(start, offsetBy: prefix.count)
    while end < text.endIndex && isKeyChar(text[end]) {
      end = text.index(after: end)
    }
    return end
  }
  return nil
}

/// Matches `Bearer` + required whitespace run + required non-whitespace run.
private func matchBearerToken(_ text: String, at start: String.Index) -> String.Index? {
  let keyword = "Bearer"
  guard text[start...].hasPrefix(keyword) else { return nil }
  var idx = text.index(start, offsetBy: keyword.count)
  var sawSpace = false
  while idx < text.endIndex && text[idx].isWhitespace {
    sawSpace = true
    idx = text.index(after: idx)
  }
  guard sawSpace else { return nil }
  var sawToken = false
  while idx < text.endIndex && !text[idx].isWhitespace {
    sawToken = true
    idx = text.index(after: idx)
  }
  guard sawToken else { return nil }
  return idx
}

/// Matches `FW_PROJECT_API_KEY` + optional whitespace + (`=`|`:`) +
/// optional whitespace + required non-whitespace run.
private func matchFwProjectApiKeyAssignment(_ text: String, at start: String.Index) -> String.Index?
{
  let keyword = "FW_PROJECT_API_KEY"
  guard text[start...].hasPrefix(keyword) else { return nil }
  var idx = text.index(start, offsetBy: keyword.count)
  while idx < text.endIndex && text[idx].isWhitespace { idx = text.index(after: idx) }
  guard idx < text.endIndex, text[idx] == "=" || text[idx] == ":" else { return nil }
  idx = text.index(after: idx)
  while idx < text.endIndex && text[idx].isWhitespace { idx = text.index(after: idx) }
  var sawToken = false
  while idx < text.endIndex && !text[idx].isWhitespace {
    sawToken = true
    idx = text.index(after: idx)
  }
  guard sawToken else { return nil }
  return idx
}

/// Collapses whitespace runs to a single space and trims both ends.
private func collapseAndTrimWhitespace(_ text: String) -> String {
  var out = ""
  var pendingSpace = false
  for ch in text {
    if ch.isWhitespace {
      if !out.isEmpty { pendingSpace = true }
    } else {
      if pendingSpace {
        out.append(" ")
        pendingSpace = false
      }
      out.append(ch)
    }
  }
  return out
}

/// Redacts secret-shaped substrings (`spec/errors.schema.json`
/// `secretPatterns`) and collapses whitespace runs. Defensive: applied to
/// every message that reaches `FireweaveError`, even though canonical
/// default messages never contain a secret in the first place — this is the
/// safety net for a message built dynamically elsewhere in the SDK.
public func redactSecrets(_ text: String) -> String {
  var out = ""
  var i = text.startIndex
  while i < text.endIndex {
    if let end = matchProjectKeyPrefix(text, at: i) {
      out += "[REDACTED]"
      i = end
      continue
    }
    if let end = matchBearerToken(text, at: i) {
      out += "[REDACTED]"
      i = end
      continue
    }
    if let end = matchFwProjectApiKeyAssignment(text, at: i) {
      out += "[REDACTED]"
      i = end
      continue
    }
    out.append(text[i])
    i = text.index(after: i)
  }
  return collapseAndTrimWhitespace(out)
}
