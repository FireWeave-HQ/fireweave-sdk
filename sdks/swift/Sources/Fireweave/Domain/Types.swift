import Foundation

/// Shared public types for the Fireweave SDK.
///
/// No vendor-backend or OpenFeature-provider types appear here — these are
/// the canonical Fireweave-owned shapes per `spec/` v0.1.0.

/// JSON-compatible value (`spec/decision.schema.json` `$defs.jsonValue`).
///
/// A hand-rolled `Codable`/`Equatable`/`Sendable` enum rather than `Any` —
/// Foundation's `JSONSerialization` decodes into `[String: Any]`/`[Any]`,
/// which is neither `Sendable` nor `Equatable`, both of which this SDK's
/// concurrency-safety and fixture-comparison needs require. Conversions to
/// and from Foundation's `Any` tree live in `JSONValue+Foundation.swift`.
public indirect enum JSONValue: Sendable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  public var isNull: Bool {
    if case .null = self { return true }
    return false
  }
  public var isBool: Bool {
    if case .bool = self { return true }
    return false
  }
  public var isNumber: Bool {
    if case .number = self { return true }
    return false
  }
  public var isString: Bool {
    if case .string = self { return true }
    return false
  }
  public var isArray: Bool {
    if case .array = self { return true }
    return false
  }
  public var isObject: Bool {
    if case .object = self { return true }
    return false
  }

  public var boolValue: Bool? {
    if case .bool(let v) = self { return v }
    return nil
  }
  public var numberValue: Double? {
    if case .number(let v) = self { return v }
    return nil
  }
  public var stringValue: String? {
    if case .string(let v) = self { return v }
    return nil
  }
  public var arrayValue: [JSONValue]? {
    if case .array(let v) = self { return v }
    return nil
  }
  public var objectValue: [String: JSONValue]? {
    if case .object(let v) = self { return v }
    return nil
  }
}

extension JSONValue: ExpressibleByNilLiteral, ExpressibleByBooleanLiteral,
  ExpressibleByIntegerLiteral,
  ExpressibleByFloatLiteral, ExpressibleByStringLiteral, ExpressibleByArrayLiteral,
  ExpressibleByDictionaryLiteral
{
  public init(nilLiteral: ()) { self = .null }
  public init(booleanLiteral value: Bool) { self = .bool(value) }
  public init(integerLiteral value: Int) { self = .number(Double(value)) }
  public init(floatLiteral value: Double) { self = .number(value) }
  public init(stringLiteral value: String) { self = .string(value) }
  public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
  public init(dictionaryLiteral elements: (String, JSONValue)...) {
    self = .object(Dictionary(uniqueKeysWithValues: elements))
  }
}

/// `flagMetadata` values per `spec/decision.schema.json`: `bool | string | number`.
public typealias FlagMetadata = [String: JSONValue]

/// Requested flag value type for typed evaluation (`spec/control-points.md`
/// "The nine methods"). Exactly four members: boolean, string, number,
/// object — there is no separate integer/float distinction in v1
/// (`Decision.value` is `jsonValue`; `getNumberValue` returns **number**,
/// not integer).
public enum FlagType: String, Sendable, Equatable, CaseIterable {
  case boolean
  case string
  case number
  case object
}

/// Matches whether `value`'s runtime shape agrees with `expected`. Shared by
/// the default-value validator (before any I/O) and the runtime's
/// post-resolve check (after the cache read) — same predicate, two
/// different inputs.
public func matchesExpectedType(_ value: JSONValue, _ expected: FlagType) -> Bool {
  switch expected {
  case .boolean: return value.isBool
  case .string: return value.isString
  case .number: return value.isNumber
  case .object: return value.isObject || value.isArray
  }
}
