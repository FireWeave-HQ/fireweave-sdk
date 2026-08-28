/// `FireweaveClient` — control-point evaluation and target registration
/// (`spec/control-points.md`): the only two v1 capabilities. Facade methods
/// degrade instead of throwing.

/// Result of `FireweaveClient.invokeCapability`.
public struct ExtensionResult: Sendable, Equatable {
  public var ok: Bool
  public var errorKind: ErrorKind?
  public var errorCode: String?
  public var errorMessage: String?
  public var degraded: Bool

  fileprivate static func failure(_ error: FireweaveError, degraded: Bool) -> ExtensionResult {
    ExtensionResult(
      ok: false, errorKind: error.kind, errorCode: error.openFeatureErrorCode,
      errorMessage: error.message, degraded: degraded
    )
  }
}

/// Names `invokeCapability` will dispatch instead of degrading with
/// `.unsupportedCapability`. Empty in v1: releases, exposures, signals,
/// capabilities discovery, and guardrails are all out of scope
/// (`spec/control-points.md` "Scope of v1") and MUST NOT be exposed, so a
/// cut namespace's capability string resolves exactly like any other
/// unknown string.
private let supportedCapabilities: Set<String> = []

/// Typed evaluation helpers — the nine methods (`spec/control-points.md`
/// "The nine methods"). A `final class`, not a `struct`: `FireweaveClient
/// .flags` is documented as an identical alias SHARING IDENTITY with
/// `.controlPoints` (ADR-0007) — `flags === controlPoints` only means
/// something for a reference type, mirroring node/go's object-identity
/// alias and rust's `std::ptr::eq` proof.
///
/// Every method here is SYNCHRONOUS (Phase 6 controller ruling: "web's
/// shape, not node's") — `evaluate` is a pure cache read
/// (`FireweaveRuntime.evaluate`), never an `async` call.
public final class ControlPointsNamespace: Sendable {
  private let runtime: FireweaveRuntime

  init(runtime: FireweaveRuntime) {
    self.runtime = runtime
  }

  /// Evaluate a flag to a canonical `Decision` — the general form the
  /// eight `get*` methods delegate to.
  ///
  /// `options` is the reserved fifth argument for cross-language surface
  /// parity (`conformance/surface/control-points.surface.json` pins
  /// `evaluate(key, type, default, context?, options?)` across every
  /// language) — currently inert, see `EvaluateOptions`'s doc comment.
  public func evaluate(
    _ key: String,
    type: FlagType,
    default defaultValue: JSONValue,
    context: EvaluationContext? = nil,
    options: EvaluateOptions? = nil
  ) -> Decision {
    runtime.evaluate(
      key: key, type: type, defaultValue: defaultValue, context: context, options: options)
  }

  public func getBooleanValue(
    _ key: String, default defaultValue: Bool, context: EvaluationContext? = nil
  ) -> Bool {
    evaluate(key, type: .boolean, default: .bool(defaultValue), context: context).value.boolValue
      ?? defaultValue
  }

  public func getStringValue(
    _ key: String, default defaultValue: String, context: EvaluationContext? = nil
  )
    -> String
  {
    evaluate(key, type: .string, default: .string(defaultValue), context: context).value.stringValue
      ?? defaultValue
  }

  public func getNumberValue(
    _ key: String, default defaultValue: Double, context: EvaluationContext? = nil
  )
    -> Double
  {
    evaluate(key, type: .number, default: .number(defaultValue), context: context).value.numberValue
      ?? defaultValue
  }

  public func getObjectValue(
    _ key: String, default defaultValue: JSONValue, context: EvaluationContext? = nil
  )
    -> JSONValue
  {
    let decision = evaluate(key, type: .object, default: defaultValue, context: context)
    return (decision.value.isObject || decision.value.isArray) ? decision.value : defaultValue
  }

  /// Detailed reads — the whole `Decision` rather than just its value.
  /// Same arguments as the `*Value` pair above, so a caller upgrades from
  /// one to the other without restructuring the call
  /// (`spec/control-points.md` "The nine methods"). SYNCHRONOUS like every
  /// other read here.
  public func getBooleanDetails(
    _ key: String, default defaultValue: Bool, context: EvaluationContext? = nil
  )
    -> Decision
  {
    evaluate(key, type: .boolean, default: .bool(defaultValue), context: context)
  }

  public func getStringDetails(
    _ key: String, default defaultValue: String, context: EvaluationContext? = nil
  )
    -> Decision
  {
    evaluate(key, type: .string, default: .string(defaultValue), context: context)
  }

  public func getNumberDetails(
    _ key: String, default defaultValue: Double, context: EvaluationContext? = nil
  )
    -> Decision
  {
    evaluate(key, type: .number, default: .number(defaultValue), context: context)
  }

  public func getObjectDetails(
    _ key: String, default defaultValue: JSONValue, context: EvaluationContext? = nil
  )
    -> Decision
  {
    evaluate(key, type: .object, default: defaultValue, context: context)
  }
}

/// Top-level Fireweave client: control-point evaluation + target
/// registration — the only two v1 capabilities. No hidden globals: callers
/// construct the runtime (or go through `initFireweave`), so tests inject
/// fakes.
public final class FireweaveClient: Sendable {
  public let runtime: FireweaveRuntime
  public let controlPoints: ControlPointsNamespace

  public init(runtime: FireweaveRuntime) {
    self.runtime = runtime
    self.controlPoints = ControlPointsNamespace(runtime: runtime)
  }

  /// Control-point evaluation under its former name.
  ///
  /// Identical to `controlPoints` and shares its identity — both resolve
  /// to the exact same `ControlPointsNamespace` instance, so
  /// `client.flags === client.controlPoints` holds. Silent at runtime: the
  /// alias is permanent, not scheduled for removal (ADR-0007), so there is
  /// nothing to warn a caller toward — deprecation is conveyed by this doc
  /// comment (and `@available(*, deprecated, ...)` below, which carries
  /// the signal to IDEs/compilers) only, never a runtime log.
  @available(
    *, deprecated, renamed: "controlPoints", message: "Renamed to controlPoints (ADR-0007)."
  )
  public var flags: ControlPointsNamespace { controlPoints }

  public func initialize(context: EvaluationContext? = nil) async {
    await runtime.initialize(context: context)
  }

  /// Bind the client-layer evaluation context (merge order: middle, ahead
  /// of per-call invocation, behind constructor-time global).
  public func setContext(_ context: EvaluationContext?) {
    runtime.setClientContext(context)
  }

  /// Register durable targeting facts for a target (`spec/modes.md`).
  ///
  /// Resolves rather than throwing: this runs in sign-in paths, where a
  /// targeting concern must not break authentication. In local mode this
  /// records in-process and traces the call; nothing reaches fw-server.
  public func registerTarget(
    _ targetingKey: String,
    options: RegisterTargetOptions? = nil
  ) async -> RegisterTargetResult {
    await runtime.registerTarget(targetingKey: targetingKey, options: options)
  }

  /// Sign-in hook: register the user's durable targeting properties, then
  /// re-prefetch under that id so percentage ramps bucket on a stable key.
  public func identify(
    _ targetingKey: String,
    options: RegisterTargetOptions? = nil
  ) async -> RegisterTargetResult {
    let result = await runtime.registerTarget(targetingKey: targetingKey, options: options)
    runtime.setClientContext(EvaluationContext(targetingKey: targetingKey))
    await runtime.refresh()
    return result
  }

  /// Dynamic capability dispatch. Unknown capabilities — currently all of
  /// them, v1's `supportedCapabilities` is empty — degrade with
  /// `.unsupportedCapability`, never throw.
  public func invokeCapability(_ capability: String, args: [String: JSONValue]? = nil)
    -> ExtensionResult
  {
    guard supportedCapabilities.contains(capability) else {
      return .failure(FireweaveError(kind: .unsupportedCapability), degraded: true)
    }
    if let gate = runtime.extensionLifecycleGate() {
      return .failure(gate, degraded: true)
    }
    return ExtensionResult(
      ok: true, errorKind: nil, errorCode: nil, errorMessage: nil, degraded: false)
  }

  public func shutdown() async {
    await runtime.shutdown()
  }
}
