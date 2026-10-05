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
///   `FireweaveError`'s initializers runs through `redactSecrets`
///   (`contracts/errors.json` `rules.redaction`); canonical default
///   messages never echo credentials in the first place.

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
    self.message = normalizeErrorMessage(message ?? kind.defaultMessage)
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

// `contracts/errors.json` `rules.redaction`, implemented as a manual scanner
// rather than `NSRegularExpression`: the dependency budget for this SDK is
// "Foundation only", and while `NSRegularExpression` IS part of Foundation,
// four small fixed passes keep this file trivially auditable. Each pass is
// the scanner twin of one pattern in the other SDKs:
//
// 1. bearer:     `\bBearer(\s+)[A-Za-z0-9._~+/=-]+`, the word stays;
// 2. userinfo:   `\b([A-Za-z][A-Za-z0-9+.-]*://)[^\s/?#@]+@`, scheme and `@` stay;
// 3. assignment: `(NAME)(\s*[=:]\s*["']?)[^\s"',;]+`, name, separator and quote stay;
// 4. value:      `(PREFIX)[A-Za-z0-9_-]+`.

/// The text a redacted secret becomes (`rules.redaction.placeholder`).
let redactionPlaceholder = "[REDACTED]"

/// The variables whose assigned value is redacted (`rules.redaction.assignmentNames`).
/// A name on its own is prose and stays.
let redactionAssignmentNames = ["FIREWEAVE_KEY", "FIREWEAVE_BROWSER_KEY", "FW_PROJECT_API_KEY"]

/// Key-shaped value prefixes (`rules.redaction.valuePrefixes`). A prefix
/// followed by anything but `[A-Za-z0-9_-]` (the ellipsis in
/// `project-api-key_…`) is prose and stays.
let redactionValuePrefixes = [
  "project-api-key_", "fw_public_", "fw_ingest_pub_", "fw_org_", "cli_at_", "phc_", "phx_", "phs_",
]

/// What one pass claims at a position: the text that replaces the span and
/// the index just past it.
private struct RedactionHit {
  var replacement: String
  var end: Int
}

private func isASCIILetter(_ c: Character) -> Bool {
  c.isASCII && c.isLetter
}

/// `\w`: an ASCII letter, digit or underscore.
private func isWordChar(_ c: Character) -> Bool {
  c.isASCII && (c.isLetter || c.isNumber || c == "_")
}

/// `[A-Za-z0-9_-]`.
private func isKeyChar(_ c: Character) -> Bool {
  c.isASCII && (c.isLetter || c.isNumber || c == "_" || c == "-")
}

/// `[A-Za-z0-9._~+/=-]`: a bearer token character.
private func isTokenChar(_ c: Character) -> Bool {
  c.isASCII && (c.isLetter || c.isNumber || "._~+/=-".contains(c))
}

/// `\b` before a word character at `index`.
private func atWordStart(_ chars: [Character], _ index: Int) -> Bool {
  index == 0 || !isWordChar(chars[index - 1])
}

/// Whether `word` appears in `chars` starting at `start`.
private func matches(_ chars: [Character], at start: Int, _ word: String) -> Bool {
  var index = start
  for c in word {
    guard index < chars.count, chars[index] == c else { return false }
    index += 1
  }
  return true
}

/// The index past the run of characters from `start` that satisfy `test`.
private func runEnd(_ chars: [Character], from start: Int, _ test: (Character) -> Bool) -> Int {
  var index = start
  while index < chars.count && test(chars[index]) {
    index += 1
  }
  return index
}

/// Copies `chars`, replacing every span `match` claims, left to right.
private func redactPass(
  _ chars: [Character],
  _ match: ([Character], Int) -> RedactionHit?
) -> [Character] {
  var out: [Character] = []
  out.reserveCapacity(chars.count)
  var index = 0
  while index < chars.count {
    if let hit = match(chars, index) {
      out.append(contentsOf: hit.replacement)
      index = hit.end
    } else {
      out.append(chars[index])
      index += 1
    }
  }
  return out
}

/// `Bearer <token>`: the token goes, the word and the whitespace stay.
private func matchBearer(_ chars: [Character], _ start: Int) -> RedactionHit? {
  let word = "Bearer"
  guard atWordStart(chars, start), matches(chars, at: start, word) else { return nil }
  let spaceStart = start + word.count
  let tokenStart = runEnd(chars, from: spaceStart) { $0.isWhitespace }
  guard tokenStart > spaceStart else { return nil }
  let end = runEnd(chars, from: tokenStart, isTokenChar)
  guard end > tokenStart else { return nil }
  let kept = String(chars[start..<tokenStart])
  return RedactionHit(replacement: kept + redactionPlaceholder, end: end)
}

/// `scheme://userinfo@host`: the userinfo goes.
private func matchURLUserinfo(_ chars: [Character], _ start: Int) -> RedactionHit? {
  guard start < chars.count, isASCIILetter(chars[start]), atWordStart(chars, start) else {
    return nil
  }
  let schemeEnd = runEnd(chars, from: start + 1) { c in
    c.isASCII && (c.isLetter || c.isNumber || c == "+" || c == "." || c == "-")
  }
  guard matches(chars, at: schemeEnd, "://") else { return nil }
  let infoStart = schemeEnd + 3
  let infoEnd = runEnd(chars, from: infoStart) { c in
    !c.isWhitespace && c != "/" && c != "?" && c != "#" && c != "@"
  }
  guard infoEnd > infoStart, infoEnd < chars.count, chars[infoEnd] == "@" else { return nil }
  let kept = String(chars[start..<infoStart])
  return RedactionHit(replacement: kept + redactionPlaceholder + "@", end: infoEnd + 1)
}

/// `NAME=value`, `NAME: value`, `NAME = "value"`, `NAME='value'`: the value
/// (up to whitespace, a quote, a comma or a semicolon) goes.
private func matchAssignment(_ chars: [Character], _ start: Int) -> RedactionHit? {
  for name in redactionAssignmentNames where matches(chars, at: start, name) {
    var index = runEnd(chars, from: start + name.count) { $0.isWhitespace }
    guard index < chars.count, chars[index] == "=" || chars[index] == ":" else { continue }
    index = runEnd(chars, from: index + 1) { $0.isWhitespace }
    if index < chars.count, chars[index] == "\"" || chars[index] == "'" {
      index += 1
    }
    let end = runEnd(chars, from: index) { c in
      !c.isWhitespace && c != "\"" && c != "'" && c != "," && c != ";"
    }
    guard end > index else { continue }
    let kept = String(chars[start..<index])
    return RedactionHit(replacement: kept + redactionPlaceholder, end: end)
  }
  return nil
}

/// A value prefix followed by one or more `[A-Za-z0-9_-]`.
private func matchKeyValue(_ chars: [Character], _ start: Int) -> RedactionHit? {
  for prefix in redactionValuePrefixes where matches(chars, at: start, prefix) {
    let valueStart = start + prefix.count
    let end = runEnd(chars, from: valueStart, isKeyChar)
    guard end > valueStart else { continue }
    return RedactionHit(replacement: redactionPlaceholder, end: end)
  }
  return nil
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

/// Scrubs secrets from `text` exactly as `contracts/errors.json`
/// `rules.redaction` specifies (`contracts/errors.md` rule 2): bearer
/// tokens, then URL userinfo, then the values assigned to `FIREWEAVE_KEY`,
/// `FIREWEAVE_BROWSER_KEY` and `FW_PROJECT_API_KEY`, then key-shaped values
/// each become `[REDACTED]`. A variable NAME is never redacted on its own,
/// only its value, and nothing else in `text` changes.
///
/// Applied to every message that reaches `FireweaveError`, even though
/// canonical default messages never contain a secret: it is the safety net
/// for a message built dynamically elsewhere in the SDK.
public func redactSecrets(_ text: String) -> String {
  var chars = Array(text)
  chars = redactPass(chars, matchBearer)
  chars = redactPass(chars, matchURLUserinfo)
  chars = redactPass(chars, matchAssignment)
  chars = redactPass(chars, matchKeyValue)
  return String(chars)
}

/// A message as `FireweaveError` stores it: redacted, then whitespace runs
/// collapsed to one space and trimmed.
func normalizeErrorMessage(_ text: String) -> String {
  collapseAndTrimWhitespace(redactSecrets(text))
}
