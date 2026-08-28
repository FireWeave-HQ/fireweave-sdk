/// Evaluation-context value type: merge order (global -> client ->
/// invocation) over the canonical, structurally-owned attribute map.
///
/// Bounds are enforced in `validateContext` (`spec/control-points.md`
/// "Validation, before any I/O" rule 3).
///
/// **Spec-ambiguity note — recurrence of rust finding 2
/// (task-12-report.md).** node/python/web detect a caller-constructed cyclic
/// `attributes` object and fail closed with `InvalidContext('context
/// contains a circular reference')`, because their host languages let a
/// plain object/dict hold a reference to one of its own ancestors.
/// `EvaluationContext.attributes: [String: JSONValue]` is a Swift `struct`
/// over a `Dictionary` of an `indirect enum` — a plain, owned VALUE type
/// with copy-on-write semantics, not a reference graph. There is no `class`,
/// `AnyObject`, or unmanaged pointer anywhere in `JSONValue`'s or
/// `EvaluationContext`'s definitions, so a caller cannot construct an
/// attribute map that contains itself even if they tried — the same
/// structural argument rust's finding 2 makes for `serde_json::Map`. This
/// file deliberately carries no cycle-detection code, for the identical
/// reason: inventing shared-pointer machinery solely to simulate a hazard
/// the type system already rules out would be manufacturing a bug class
/// rather than closing one.
public struct EvaluationContext: Sendable, Equatable {
  public var targetingKey: String?
  public var attributes: [String: JSONValue]

  public init(targetingKey: String? = nil, attributes: [String: JSONValue] = [:]) {
    self.targetingKey = targetingKey
    self.attributes = attributes
  }

  public func withTargetingKey(_ key: String) -> EvaluationContext {
    var copy = self
    copy.targetingKey = key
    return copy
  }

  public func withAttribute(_ key: String, _ value: JSONValue) -> EvaluationContext {
    var copy = self
    copy.attributes[key] = value
    return copy
  }

  /// `$`-prefixed attributes: vendor pass-through options.
  public var vendorHints: [String: JSONValue] {
    attributes.filter { $0.key.hasPrefix("$") }
  }

  /// Attributes minus vendor hints (`$`-prefixed keys).
  public var plainAttributes: [String: JSONValue] {
    attributes.filter { !$0.key.hasPrefix("$") }
  }

  /// Group memberships from `fireweave.groups` or the plain `groups` alias.
  public var groups: [String: JSONValue]? {
    (attributes["fireweave.groups"] ?? attributes["groups"])?.objectValue
  }

  /// Group properties from `fireweave.groupProperties` or the plain
  /// `groupProperties` alias.
  public var groupProperties: [String: JSONValue]? {
    (attributes["fireweave.groupProperties"] ?? attributes["groupProperties"])?.objectValue
  }

  /// Plain-JSON snapshot (`{targetingKey?, attributes?}`), matching the
  /// shape conformance fixtures compare against.
  public func toJSON() -> JSONValue {
    var out: [String: JSONValue] = [:]
    if let key = targetingKey { out["targetingKey"] = .string(key) }
    if !attributes.isEmpty { out["attributes"] = .object(attributes) }
    return .object(out)
  }
}

/// Sanctioned `fireweave.*` carriers (`spec/evaluation-context.schema.json`):
/// the ONLY `fireweave.*` context keys callers may set. Canonical spelling
/// for group memberships / group properties; plain `groups`/`groupProperties`
/// remain accepted as a documented alias.
public let allowedFireweaveContextKeys: Set<String> = [
  "fireweave.groups", "fireweave.groupProperties",
]

/// Attribute keys reserved at the evaluation-context boundary
/// (`spec/evaluation-context.schema.json` `reservedKeys`, restricted here to
/// the attribute-level pair `validateContext` checks; `targetingKey` itself
/// is a top-level field, never an attribute key).
public let defaultReservedAttributeKeys: Set<String> = ["targetingKey", "kind"]

/// Context bounds (`spec/evaluation-context.schema.json`).
public struct ContextLimits: Sendable, Equatable {
  public var maxAttributeCount: Int
  public var maxKeyBytes: Int
  public var maxValueBytes: Int
  public var maxNestingDepth: Int
  public var maxSerializedBytes: Int

  public init(
    maxAttributeCount: Int,
    maxKeyBytes: Int,
    maxValueBytes: Int,
    maxNestingDepth: Int,
    maxSerializedBytes: Int
  ) {
    self.maxAttributeCount = maxAttributeCount
    self.maxKeyBytes = maxKeyBytes
    self.maxValueBytes = maxValueBytes
    self.maxNestingDepth = maxNestingDepth
    self.maxSerializedBytes = maxSerializedBytes
  }
}

/// Ratified default bounds (`contracts/README.md` "Ratified context limits").
public let defaultContextLimits = ContextLimits(
  maxAttributeCount: 128,
  maxKeyBytes: 256,
  maxValueBytes: 4096,
  maxNestingDepth: 6,
  maxSerializedBytes: 65536
)

/// Merges context layers; later layers win per attribute key.
///
/// Order: global -> client -> invocation (`spec/control-points.md`
/// "Context"). `targetingKey` from the latest layer that sets one wins.
/// Merge is shallow per top-level attribute key.
public func mergeContexts(_ layers: [EvaluationContext?]) -> EvaluationContext {
  var merged = EvaluationContext()
  for layer in layers.compactMap({ $0 }) {
    if layer.targetingKey != nil { merged.targetingKey = layer.targetingKey }
    for (key, value) in layer.attributes { merged.attributes[key] = value }
  }
  return merged
}
