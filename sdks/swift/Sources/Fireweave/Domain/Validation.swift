import Foundation

/// Fireweave SDK validation — pure, total functions per
/// `spec/control-points.md` "Validation, before any I/O" and
/// `spec/modes.md` "Initialisation validation".
///
/// Result of a pure validator: `.success` (`Void`) or `.failure` naming the
/// `FireweaveError` a caller should degrade to. Named `Validated` per the
/// Phase 6 controller ruling ("Five validators as pure total functions
/// returning a `Validated` result").
public typealias Validated = Result<Void, FireweaveError>

/// Every function below is pure (no I/O, no ambient state, no environment
/// reads) and total — `FireweaveConformance` can exercise all of these
/// offline, with no backend. `FireweaveRuntime.evaluate` runs the read-path
/// ones (key, default-vs-type, context) in the fixed order
/// `spec/control-points.md` names, stopping at the first failure, THEN
/// checks lifecycle (a runtime-state concern, not a pure function — it
/// lives on `FireweaveRuntime`, not here) before ever consulting the cache.
/// Only `validateInitOptions`'s failure is surfaced as a `throw`, by
/// `initFireweave`; every other validator's failure here is converted into a
/// default-valued `Decision` before it ever reaches a caller.

// MARK: - Rule 1 — validateControlPointKey

private let maxControlPointKeyLength = 256

private func hasControlCharacters(_ key: String) -> Bool {
  key.unicodeScalars.contains { scalar in
    let value = scalar.value
    return value <= 0x1F || (0x7F...0x9F).contains(value)
  }
}

/// key — non-empty, <=256 characters, no control characters
/// (`spec/control-points.md` rule 1, the first check in the fixed order).
///
/// No taxonomy kind names "malformed key" explicitly (the return-discipline
/// table's closest row is "key unknown to the backend" -> `FlagNotFound`):
/// a key that can never identify a flag is treated the same as one the
/// backend doesn't recognise, so this maps to `.flagNotFound` too.
///
/// Controller-ruled interim mapping (carried over from the node reference,
/// same as rust's finding): the 15-kind taxonomy in `errors.schema.json` is
/// frozen at exactly 15 entries, `.invalidContext` is textually scoped to
/// the evaluation *context* (not the key), and the schema already maps
/// another non-literal case — quota-limited responses — onto
/// `.flagNotFound` rather than adding a kind for it. `.flagNotFound` is
/// therefore the least-wrong existing kind, not a literal fit.
public func validateControlPointKey(_ key: String) -> Validated {
  if key.isEmpty {
    return .failure(
      FireweaveError(kind: .flagNotFound, message: "control point key must be a non-empty string"))
  }
  if key.count > maxControlPointKeyLength {
    return .failure(
      FireweaveError(kind: .flagNotFound, message: "control point key exceeds maximum length"))
  }
  if hasControlCharacters(key) {
    return .failure(
      FireweaveError(kind: .flagNotFound, message: "control point key contains control characters"))
  }
  return .success(())
}

// MARK: - Rule 2 — validateDefaultValue

/// default vs type — e.g. `getBooleanValue` with a non-boolean default is
/// `.typeMismatch` (`spec/control-points.md` rule 2, checked before any I/O).
public func validateDefaultValue(_ expectedType: FlagType, _ defaultValue: JSONValue) -> Validated {
  matchesExpectedType(defaultValue, expectedType)
    ? .success(()) : .failure(FireweaveError(kind: .typeMismatch))
}

// MARK: - validateTargetingKey

/// targetingKey: "An SDK MUST NOT invent one: a missing targeting key is
/// InvalidContext where the evaluation needs it, never a generated
/// anonymous id" (`spec/control-points.md` "Context"). `required` is
/// call-site policy — the remote adapter always requires one; the generic
/// context pipeline (`validateContext`) only does when its caller opts in.
public func validateTargetingKey(_ targetingKey: String?, required: Bool) -> Validated {
  if required && (targetingKey?.isEmpty ?? true) {
    return .failure(.targetingKeyMissing())
  }
  return .success(())
}

// MARK: - Rule 3 — validateContext

private func maxDepth(of value: JSONValue) -> Int {
  switch value {
  case .object(let map): return 1 + (map.values.map(maxDepth(of:)).max() ?? 0)
  case .array(let arr): return 1 + (arr.map(maxDepth(of:)).max() ?? 0)
  default: return 0
  }
}

/// Depth of the top-level attribute map itself (root = 1, matching
/// `spec/evaluation-context.schema.json` `bounds.maxDepth`'s doc comment).
private func maxDepthOfAttributes(_ attrs: [String: JSONValue]) -> Int {
  1 + (attrs.values.map(maxDepth(of:)).max() ?? 0)
}

private func anyKeyExceedsBytes(_ value: JSONValue, limit: Int) -> Bool {
  switch value {
  case .object(let map):
    return map.contains { key, v in key.utf8.count > limit || anyKeyExceedsBytes(v, limit: limit) }
  case .array(let arr):
    return arr.contains { anyKeyExceedsBytes($0, limit: limit) }
  default:
    return false
  }
}

private func anyStringValueExceedsBytes(_ value: JSONValue, limit: Int) -> Bool {
  switch value {
  case .object(let map): return map.values.contains { anyStringValueExceedsBytes($0, limit: limit) }
  case .array(let arr): return arr.contains { anyStringValueExceedsBytes($0, limit: limit) }
  case .string(let s): return s.utf8.count > limit
  default: return false
  }
}

/// context — depth, key count, value size, reserved keys
/// (`evaluation-context.schema.json`) (`spec/control-points.md` rule 3).
/// Also enforces `requireTargetingKey` via `validateTargetingKey`.
///
/// Carries no cycle check: `EvaluationContext.attributes` is an owned Swift
/// `Dictionary` over an `indirect enum` value tree with no shared/back-
/// references possible, so a cyclic context is structurally unreachable for
/// this SDK's context input type — see `Context.swift`'s doc comment
/// (recurrence of rust finding 2, task-12-report.md).
public func validateContext(
  _ context: EvaluationContext,
  limits: ContextLimits,
  reservedKeys: Set<String>,
  requireTargetingKey: Bool
) -> Validated {
  let attrs = context.attributes

  for key in attrs.keys {
    if reservedKeys.contains(key) {
      return .failure(FireweaveError(kind: .invalidContext))
    }
    if key.hasPrefix("fireweave.") && !allowedFireweaveContextKeys.contains(key) {
      return .failure(FireweaveError(kind: .invalidContext))
    }
  }

  if attrs.count > limits.maxAttributeCount {
    return .failure(
      FireweaveError(kind: .invalidContext, message: "context exceeds maximum attribute count"))
  }

  if attrs.contains(where: { key, value in
    key.utf8.count > limits.maxKeyBytes || anyKeyExceedsBytes(value, limit: limits.maxKeyBytes)
  }) {
    return .failure(
      FireweaveError(kind: .invalidContext, message: "context key exceeds maximum size"))
  }

  if attrs.values.contains(where: { anyStringValueExceedsBytes($0, limit: limits.maxValueBytes) }) {
    return .failure(
      FireweaveError(kind: .invalidContext, message: "context value exceeds maximum size"))
  }

  if maxDepthOfAttributes(attrs) > limits.maxNestingDepth {
    return .failure(
      FireweaveError(kind: .invalidContext, message: "context exceeds maximum nesting depth"))
  }

  let probe: JSONValue = .object([
    "targetingKey": context.targetingKey.map(JSONValue.string) ?? .null,
    "attributes": .object(attrs),
  ])
  if probe.toStableJSONString().utf8.count > limits.maxSerializedBytes {
    return .failure(
      FireweaveError(kind: .invalidContext, message: "serialized context exceeds maximum size"))
  }

  return validateTargetingKey(context.targetingKey, required: requireTargetingKey)
}

// MARK: - validateInitOptions (spec/modes.md "Initialisation validation")

private func isBlank(_ value: String?) -> Bool {
  (value?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) ?? true
}

/// Initialisation-validation table (`spec/modes.md`), the three rows
/// representable at this layer:
///
/// - `mode` absent (`nil`) — "unrecognised" has no Swift analogue; see
///   `Mode.swift`'s doc comment (recurrence of rust finding 3).
/// - `mode == .remote` with `apiKey`/`apiUrl` missing/blank.
/// - `mode == .local` with credentials supplied (a config half-migrated
///   from remote to local reads as neither, silently — reject it instead).
///
/// Row 3 ("apiUrl fails the host allowlist") is intentionally NOT checked
/// here — that check (`assertHostAllowed`) lives in `Hosts.swift` and is
/// invoked directly by `initFireweave` before any adapter/network I/O
/// happens (a pure `Domain/` function must not depend on it).
public func validateInitOptions(mode: Mode?, apiKey: String?, apiUrl: String?) -> Validated {
  guard let mode else {
    return .failure(
      .configuration(#"mode is required and must be "local" or "remote""#, initFatal: true))
  }
  switch mode {
  case .remote:
    if isBlank(apiKey) || isBlank(apiUrl) {
      return .failure(.configuration(#"mode "remote" requires apiKey and apiUrl"#, initFatal: true))
    }
    return .success(())
  case .local:
    if !isBlank(apiKey) || !isBlank(apiUrl) {
      return .failure(
        .configuration(
          #"mode "local" must not be combined with apiKey/apiUrl — the caller means one or the other"#,
          initFatal: true
        )
      )
    }
    return .success(())
  }
}
