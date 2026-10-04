import Fireweave

/// The control-point reads on `fw`: exactly the core
/// `ControlPointsNamespace`'s nine methods, with identical signatures, so
/// call sites read the same with or without the start profile.
///
/// A stable forwarding object: it exists before `startFireweave` and stays
/// the same object across starts and shutdowns. Reads are synchronous, safe
/// from the main actor, and never throw:
///
/// - once the core client is installed, each read is the core's own read;
/// - before that, local mode answers from the flags (a seeded key with its
///   value and reason `STATIC`, any other key with the caller's default and
///   reason `DEFAULT`, exactly as the core local adapter does), and remote
///   mode returns the caller's default (`*Details`: an `ERROR` decision with
///   `NotReady`);
/// - before `startFireweave`, after `fw.shutdown()` (`AlreadyClosed`) or
///   after a failed start, the caller's default.
///
/// A per-call `context` is validated like the core validates it, but it
/// does not select a decision: decisions are prefetched for one targeting
/// key per process (`fw.identify` in an app, `fw.instanceKey()` on a server).
public final class FireweaveControlPoints: Sendable {
  private let core: StartCore

  init(core: StartCore) {
    self.core = core
  }

  /// Evaluate a control point to a canonical `Decision`.
  public func evaluate(
    _ key: String,
    type: FlagType,
    default defaultValue: JSONValue,
    context: EvaluationContext? = nil,
    options: EvaluateOptions? = nil
  ) -> Decision {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.evaluate(
        key,
        type: type,
        default: defaultValue,
        context: context,
        options: options
      )
    case .fallback(let reader):
      return reader.decide(key, type: type, default: defaultValue, context: context)
    }
  }

  public func getBooleanValue(
    _ key: String, default defaultValue: Bool, context: EvaluationContext? = nil
  ) -> Bool {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getBooleanValue(key, default: defaultValue, context: context)
    case .fallback(let reader):
      let decision = reader.decide(
        key, type: .boolean, default: .bool(defaultValue), context: context)
      return decision.value.boolValue ?? defaultValue
    }
  }

  public func getStringValue(
    _ key: String, default defaultValue: String, context: EvaluationContext? = nil
  )
    -> String
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getStringValue(key, default: defaultValue, context: context)
    case .fallback(let reader):
      let decision = reader.decide(
        key, type: .string, default: .string(defaultValue), context: context)
      return decision.value.stringValue ?? defaultValue
    }
  }

  public func getNumberValue(
    _ key: String, default defaultValue: Double, context: EvaluationContext? = nil
  )
    -> Double
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getNumberValue(key, default: defaultValue, context: context)
    case .fallback(let reader):
      let decision = reader.decide(
        key, type: .number, default: .number(defaultValue), context: context)
      return decision.value.numberValue ?? defaultValue
    }
  }

  public func getObjectValue(
    _ key: String, default defaultValue: JSONValue, context: EvaluationContext? = nil
  )
    -> JSONValue
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getObjectValue(key, default: defaultValue, context: context)
    case .fallback(let reader):
      let decision = reader.decide(key, type: .object, default: defaultValue, context: context)
      return (decision.value.isObject || decision.value.isArray) ? decision.value : defaultValue
    }
  }

  /// Detailed reads: the whole `Decision`, with the same arguments as the
  /// `*Value` methods.
  public func getBooleanDetails(
    _ key: String, default defaultValue: Bool, context: EvaluationContext? = nil
  )
    -> Decision
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getBooleanDetails(key, default: defaultValue, context: context)
    case .fallback(let reader):
      return reader.decide(key, type: .boolean, default: .bool(defaultValue), context: context)
    }
  }

  public func getStringDetails(
    _ key: String, default defaultValue: String, context: EvaluationContext? = nil
  )
    -> Decision
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getStringDetails(key, default: defaultValue, context: context)
    case .fallback(let reader):
      return reader.decide(key, type: .string, default: .string(defaultValue), context: context)
    }
  }

  public func getNumberDetails(
    _ key: String, default defaultValue: Double, context: EvaluationContext? = nil
  )
    -> Decision
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getNumberDetails(key, default: defaultValue, context: context)
    case .fallback(let reader):
      return reader.decide(key, type: .number, default: .number(defaultValue), context: context)
    }
  }

  public func getObjectDetails(
    _ key: String, default defaultValue: JSONValue, context: EvaluationContext? = nil
  )
    -> Decision
  {
    switch core.route(for: key, context: context) {
    case .client(let client):
      return client.controlPoints.getObjectDetails(key, default: defaultValue, context: context)
    case .fallback(let reader):
      return reader.decide(key, type: .object, default: defaultValue, context: context)
    }
  }
}

/// Answers a read when no core client is installed, with the core's own
/// validators and decision shapes, so the answer is the one the core would
/// give: the same validation order (key, default vs type, context, then
/// lifecycle), the same `ERROR` decision, and in local mode the same
/// `STATIC`/`DEFAULT` decisions as the core local adapter.
struct FallbackReader: Sendable {
  /// Why there is no client: NotReady, AlreadyClosed, or the start failure.
  /// Unused when `seeds` is set.
  var error: FireweaveError
  /// The anonymous key the client prefetches under, merged into the context
  /// check as the core merges its global layer.
  var subject: String?
  /// Local mode only: the flags' local values.
  var seeds: [String: Bool]?

  func decide(
    _ key: String,
    type: FlagType,
    default defaultValue: JSONValue,
    context: EvaluationContext?
  ) -> Decision {
    if case .failure(let problem) = validateControlPointKey(key) {
      return errorDecision(defaultValue, problem)
    }
    if case .failure(let problem) = validateDefaultValue(type, defaultValue) {
      return errorDecision(defaultValue, problem)
    }
    let global = subject.map { EvaluationContext(targetingKey: $0) }
    let merged = mergeContexts([global, context])
    let checked = validateContext(
      merged,
      limits: defaultContextLimits,
      reservedKeys: defaultReservedAttributeKeys,
      requireTargetingKey: false
    )
    if case .failure(let problem) = checked {
      return errorDecision(defaultValue, problem)
    }
    guard let seeds else {
      return errorDecision(defaultValue, error)
    }
    guard let seeded = seeds[key] else {
      return Decision(value: defaultValue, reason: .defaultReason)
    }
    let value = JSONValue.bool(seeded)
    guard matchesExpectedType(value, type) else {
      return errorDecision(defaultValue, FireweaveError(kind: .typeMismatch))
    }
    return Decision(value: value, variant: seeded ? "on" : "off", reason: .staticReason)
  }
}

/// The core runtime's error decision: the caller's default, reason `ERROR`,
/// and the error's kind, OpenFeature code and redacted message.
func errorDecision(_ defaultValue: JSONValue, _ error: FireweaveError) -> Decision {
  var metadata: FlagMetadata = [flagMetadataErrorKindKey: .string(error.kind.rawValue)]
  if error.kind == .flagNotFound && error.quotaLimited {
    metadata["fireweave.quotaLimited"] = .bool(true)
  }
  return Decision(
    value: defaultValue,
    reason: .error,
    errorCode: error.openFeatureErrorCode,
    errorMessage: error.message,
    errorKind: error.kind,
    flagMetadata: metadata
  )
}
