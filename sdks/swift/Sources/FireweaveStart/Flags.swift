import Fireweave

/// One control point the app reads, with the value served in local mode.
///
/// It holds a local value only. In remote mode fw-server and the rollout
/// decide, and call sites keep `false` as their default, so a flags file can
/// never switch a feature on in production.
public struct FireweaveFlag: Sendable, Equatable, ExpressibleByBooleanLiteral {
  /// The value served in local mode. Ignored in remote mode.
  public var localValue: Bool
  /// An optional note for humans and agents. Never sent anywhere.
  public var description: String?

  public init(localValue: Bool, description: String? = nil) {
    self.localValue = localValue
    self.description = description
  }

  /// `true` and `false` literals are local values: `["new-checkout": true]`.
  public init(booleanLiteral value: Bool) {
    self.init(localValue: value)
  }

  /// `defineFlags(["new-checkout": .local(true)])`.
  public static func local(_ value: Bool, description: String? = nil) -> FireweaveFlag {
    FireweaveFlag(localValue: value, description: description)
  }
}

/// Every control point the app reads, keyed by control point key. It lives
/// in its own file (`FireweaveFlags.swift` by convention) and is passed as
/// `startFireweave(flags:)`.
public typealias FireweaveFlags = [String: FireweaveFlag]

/// Declares the app's control points and returns them unchanged.
///
/// ```swift
/// // FireweaveFlags.swift
/// let appFlags = defineFlags([
///   "new-checkout": .local(true, description: "New checkout flow"),
/// ])
/// ```
///
/// Every key is checked with the core's control point key rule. A bad key
/// stops a debug build here, where it was typed; `startFireweave` rejects it
/// with a Configuration error naming the key in every build.
public func defineFlags(_ flags: FireweaveFlags) -> FireweaveFlags {
  if case .failure(let error) = normalizeFlags(flags) {
    assertionFailure(error.message)
  }
  return flags
}

/// Checks every key with the core's control point key rule, in key order.
func normalizeFlags(_ flags: FireweaveFlags) -> Result<FireweaveFlags, FireweaveError> {
  for key in flags.keys.sorted() {
    if case .failure(let problem) = validateControlPointKey(key) {
      return .failure(
        startConfigurationError(
          "flags: \"\(key)\" is not a valid control point key (\(problem.message))."
        )
      )
    }
  }
  return .success(flags)
}

/// The core local adapter's seed map.
func localSeeds(_ flags: FireweaveFlags) -> [String: Bool] {
  flags.mapValues { $0.localValue }
}

/// A canonical rendering of the local values, for the idempotency check.
func flagsSignature(_ flags: FireweaveFlags) -> String {
  flags.keys.sorted()
    .map { key in "\(key)=\(flags[key]?.localValue == true)" }
    .joined(separator: ";")
}
