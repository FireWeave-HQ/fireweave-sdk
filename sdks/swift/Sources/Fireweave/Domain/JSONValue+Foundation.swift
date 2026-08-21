import Foundation

/// Bridges `JSONValue` to and from Foundation's `JSONSerialization` — the
/// sanctioned JSON parser (`Package.swift`'s zero-dependency ruling: "Nothing
/// from swift-server, no Alamofire, no SwiftyJSON" — JSONSerialization and
/// Codable are both Foundation, not a package dependency).
extension JSONValue {
  /// Builds a `JSONValue` from the `Any` tree `JSONSerialization` produces
  /// (`NSNull`, `Bool`, `NSNumber`, `String`, `[Any]`, `[String: Any]`).
  ///
  /// `NSNumber`'s `Bool` carve-out mirrors python's own need (`bool` is a
  /// subclass of `int` there): on Apple platforms and Linux alike,
  /// `JSONSerialization` represents a JSON `true`/`false` literal as an
  /// `NSNumber` wrapping a C `BOOL`, indistinguishable from `1`/`0` by
  /// `NSNumber.doubleValue` alone. `objCType` is the portable fix (used
  /// without importing CoreFoundation directly, which swift-corelibs-
  /// foundation does not expose as a separate importable module the same
  /// way Apple's does): a boolean-backed `NSNumber`'s Objective-C type
  /// encoding is `"c"` (signed `char`, matching `BOOL`'s C definition),
  /// while `JSONSerialization` encodes a parsed JSON integer as a wider
  /// type (`"q"`, `long long`) — this holds on both Foundation
  /// implementations this SDK targets.
  public static func from(any value: Any) -> JSONValue {
    if value is NSNull { return .null }
    if let number = value as? NSNumber {
      if String(cString: number.objCType) == "c" {
        return .bool(number.boolValue)
      }
      return .number(number.doubleValue)
    }
    if let bool = value as? Bool { return .bool(bool) }
    if let string = value as? String { return .string(string) }
    if let array = value as? [Any] { return .array(array.map(JSONValue.from(any:))) }
    if let object = value as? [String: Any] {
      return .object(object.mapValues(JSONValue.from(any:)))
    }
    return .null
  }

  /// Parses UTF-8 JSON `data` into a `JSONValue` tree.
  public static func parse(data: Data) throws -> JSONValue {
    let any = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    return JSONValue.from(any: any)
  }

  /// Parses a UTF-8 JSON string into a `JSONValue` tree.
  public static func parse(string: String) throws -> JSONValue {
    try parse(data: Data(string.utf8))
  }

  /// Converts back to the `Any` tree `JSONSerialization` expects for
  /// serialization.
  public func toFoundationAny() -> Any {
    switch self {
    case .null: return NSNull()
    case .bool(let v): return v
    case .number(let v): return v
    case .string(let v): return v
    case .array(let v): return v.map { $0.toFoundationAny() }
    case .object(let v): return v.mapValues { $0.toFoundationAny() }
    }
  }

  /// Serializes with sorted keys — the deterministic ordering
  /// `spec/decision.schema.json`'s `fireweave.payload` stable-JSON-string
  /// requirement needs (mirrors node/python's dedicated stable-stringify
  /// helper and rust's `BTreeMap`-backed `serde_json::Map`).
  public func toStableJSONString() -> String {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: toFoundationAny(),
        options: [.sortedKeys, .fragmentsAllowed]
      ),
      let string = String(data: data, encoding: .utf8)
    else {
      return "null"
    }
    return string
  }
}
