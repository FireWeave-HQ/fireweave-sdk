import Foundation

/// One flag definition, as loaded from a fixture or constructed directly.
public struct FlagDefinition: Sendable, Equatable {
  public var enabled: Bool
  public var variant: String?
  public var value: JSONValue
  public var payload: JSONValue?
  public var reasonCode: String?
  public var conditionIndex: Int?
  public var version: Int?
  public var vendorFlagId: Int?
  public var fireweaveReason: DecisionReason?
  public var fromCache: Bool
  public var matchTargetingKey: String?
  public var matchAttribute: [String: JSONValue]?
  public var matchGroups: [String: JSONValue]?
  public var matchPerson: [String: JSONValue]?

  public init(
    enabled: Bool = true,
    variant: String? = nil,
    value: JSONValue = .null,
    payload: JSONValue? = nil,
    reasonCode: String? = nil,
    conditionIndex: Int? = nil,
    version: Int? = nil,
    vendorFlagId: Int? = nil,
    fireweaveReason: DecisionReason? = nil,
    fromCache: Bool = false,
    matchTargetingKey: String? = nil,
    matchAttribute: [String: JSONValue]? = nil,
    matchGroups: [String: JSONValue]? = nil,
    matchPerson: [String: JSONValue]? = nil
  ) {
    self.enabled = enabled
    self.variant = variant
    self.value = value
    self.payload = payload
    self.reasonCode = reasonCode
    self.conditionIndex = conditionIndex
    self.version = version
    self.vendorFlagId = vendorFlagId
    self.fireweaveReason = fireweaveReason
    self.fromCache = fromCache
    self.matchTargetingKey = matchTargetingKey
    self.matchAttribute = matchAttribute
    self.matchGroups = matchGroups
    self.matchPerson = matchPerson
  }

  /// Builds a definition from the raw fixture JSON shape
  /// (`given.flags: {key: {...}}`, `contracts/README.md`).
  public static func from(json value: JSONValue) -> FlagDefinition {
    let obj = value.objectValue ?? [:]
    let reason = obj["reason"]?.objectValue
    let metadata = obj["metadata"]?.objectValue
    return FlagDefinition(
      enabled: obj["enabled"]?.boolValue ?? true,
      variant: obj["variant"]?.stringValue,
      value: obj["value"] ?? .null,
      payload: obj["payload"].flatMap { $0.isNull ? nil : $0 },
      reasonCode: reason?["code"]?.stringValue,
      conditionIndex: reason?["condition_index"]?.numberValue.map(Int.init),
      version: metadata?["version"]?.numberValue.map(Int.init),
      vendorFlagId: metadata?["id"]?.numberValue.map(Int.init),
      fireweaveReason: obj["fireweaveReason"]?.stringValue.flatMap(DecisionReason.init(rawValue:)),
      fromCache: obj["fromCache"]?.boolValue ?? false,
      matchTargetingKey: obj["matchTargetingKey"]?.stringValue,
      matchAttribute: obj["matchAttribute"]?.objectValue,
      matchGroups: obj["matchGroups"]?.objectValue,
      matchPerson: obj["matchPerson"]?.objectValue
    )
  }
}

/// A fault to raise on every `prefetch()` call — protocol-fault fixtures
/// (`contracts/security/*.json`) that declare a fault but run on the
/// in-memory backend (mirrors node/go/java/rust's built-in
/// `InMemoryAdapterOptions.fault`/`InMemoryFault`). Faults at PREFETCH time,
/// not at per-call read time — the one place this architecture's adapter
/// does I/O at all (see `Ports.swift`'s doc comment).
public struct InMemoryFault: Sendable, Equatable {
  public var kind: ErrorKind

  public init(kind: ErrorKind) {
    self.kind = kind
  }
}

/// Deterministic in-memory adapter for tests and conformance fixtures.
///
/// Resolution is purely definition-driven — no hashing, no percentage
/// bucketing. A flag definition is shaped like `contracts/README.md`'s
/// fixture `given.flags.<key>` entries.
///
/// `matchPerson` is intentionally identical to `matchAttribute` (both
/// deep-equality-check plain context attributes) — this mirrors node/go/
/// rust's `InMemoryAdapter`, which implement the two conditions with the
/// same equality check under two names for descriptive fixture authoring
/// (`contracts/context/ctx-person-and-groups.json`).
///
/// **Conditions are matched against the context available AT PREFETCH
/// time** (global + client layers), never per-call invocation context —
/// this is the architectural line the Phase 6 controller ruling draws
/// (`spec/control-points.md` "web's shape, not node's"): a synchronous
/// `evaluate()` never touches this adapter, so a caller's invocation-only
/// attributes cannot retroactively change which cached decision is served.
/// This is exactly why the six context-suite fixtures whose matching is
/// invocation-context-driven are `skipped-with-documented-limitation` in
/// the conformance runner rather than run for real — see
/// `FireweaveConformance`'s runner doc comment.
public final class InMemoryAdapter: ControlPointsBackendAdapter, @unchecked Sendable {
  private let lock = NSLock()
  private var definitions: [String: FlagDefinition]
  private var fault: InMemoryFault?
  private var closed = false

  public init(_ definitions: [String: FlagDefinition] = [:]) {
    self.definitions = definitions
  }

  /// Builds an adapter from the raw fixture JSON shape
  /// (`given.flags: {key: {...}}`).
  public static func from(flagsJSON: [String: JSONValue]) -> InMemoryAdapter {
    InMemoryAdapter(flagsJSON.mapValues(FlagDefinition.from(json:)))
  }

  public let missReason: DecisionReason? = nil

  public func setFlags(_ definitions: [String: FlagDefinition]) {
    lock.withLock { self.definitions = definitions }
  }

  /// Every `prefetch()` call raises this fault instead of resolving
  /// (protocol-fault fixtures exercised on the in-memory backend).
  public func setFault(_ fault: InMemoryFault?) {
    lock.withLock { self.fault = fault }
  }

  public func isClosed() -> Bool {
    lock.withLock { closed }
  }

  private static func conditionsMatch(_ definition: FlagDefinition, context: EvaluationContext)
    -> Bool
  {
    if let expectedKey = definition.matchTargetingKey, context.targetingKey != expectedKey {
      return false
    }
    if let conditions = definition.matchAttribute {
      for (key, expected) in conditions where context.attributes[key] != expected {
        return false
      }
    }
    if let conditions = definition.matchPerson {
      for (key, expected) in conditions where context.attributes[key] != expected {
        return false
      }
    }
    if let matchGroups = definition.matchGroups {
      let groups = context.groups
      for (groupType, expected) in matchGroups where groups?[groupType] != expected {
        return false
      }
    }
    return true
  }

  public func initialize() async throws {
    lock.withLock { closed = false }
  }

  public func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult
  {
    let (currentFault, currentDefinitions) = lock.withLock { (fault, definitions) }

    if let currentFault {
      throw FireweaveError(kind: currentFault.kind)
    }

    var result: PrefetchResult = [:]
    for (key, definition) in currentDefinitions {
      let matched = Self.conditionsMatch(definition, context: context)
      // Ruling 11 gate (spec/decision.schema.json standardMetadataKeys):
      // fireweave.vendorFlagId + fireweave.reasonCode are emitted only
      // when the fixture reports a vendor flag id, a matched-condition
      // index, AND a reason code together — this adapter is the one
      // place that raw "condition index" signal exists, so it applies
      // the gate itself before constructing the AdapterResolution the
      // (adapter-agnostic) runtime reads, rather than exposing
      // conditionIndex on the shared port type (task-12-report.md
      // fix-report finding 1 — the same fix rust's runtime needed).
      var vendorFlagId: Int?
      var reasonCode: String?
      if let vfi = definition.vendorFlagId, definition.conditionIndex != nil,
        let rc = definition.reasonCode
      {
        vendorFlagId = vfi
        reasonCode = rc
      }
      result[key] = AdapterResolution(
        found: matched,
        enabled: definition.enabled,
        value: definition.value,
        variant: definition.variant,
        reason: definition.fireweaveReason,
        reasonCode: reasonCode,
        version: definition.version,
        vendorFlagId: vendorFlagId,
        payload: definition.payload,
        fromCache: definition.fromCache
      )
    }
    return result
  }

  // registerTarget: no override — the in-memory adapter degrades via the
  // protocol's default-shaped failure below (mirrors go/rust's fixture
  // adapter, which has no registration capability either).
  public func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult
  {
    .failure(FireweaveError(kind: .unsupportedCapability))
  }

  public func shutdown() async {
    lock.withLock { closed = true }
  }
}
