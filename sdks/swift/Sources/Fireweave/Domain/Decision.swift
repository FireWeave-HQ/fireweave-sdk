/// Canonical evaluation decision (`spec/decision.schema.json`).

/// Canonical reason strings (`spec/decision.schema.json`).
public enum DecisionReason: String, Sendable, Equatable {
  case targetingMatch = "TARGETING_MATCH"
  case split = "SPLIT"
  case disabled = "DISABLED"
  case defaultReason = "DEFAULT"
  case stale = "STALE"
  case cached = "CACHED"
  case staticReason = "STATIC"
  case error = "ERROR"
}

/// Result of a flag evaluation. Evaluation APIs return this, never throw
/// (`spec/control-points.md` "Return discipline — never throw into a read
/// path").
public struct Decision: Sendable, Equatable {
  public var value: JSONValue
  public var variant: String?
  public var reason: DecisionReason
  public var errorCode: String?
  public var errorMessage: String?
  public var errorKind: ErrorKind?
  public var flagMetadata: FlagMetadata

  public init(
    value: JSONValue,
    variant: String? = nil,
    reason: DecisionReason,
    errorCode: String? = nil,
    errorMessage: String? = nil,
    errorKind: ErrorKind? = nil,
    flagMetadata: FlagMetadata = [:]
  ) {
    self.value = value
    self.variant = variant
    self.reason = reason
    self.errorCode = errorCode
    self.errorMessage = errorMessage
    self.errorKind = errorKind
    self.flagMetadata = flagMetadata
  }

  public var isError: Bool { reason == .error }
}
