import Fireweave

/// One control point the app reads, with the value served in local mode.
///
/// It holds a local value only. In remote mode fw-server and the rollout
/// decide, and call sites keep `false` as their default, so this file can
/// never switch a feature on in production.
public struct FireweaveLocalControlPoint: Sendable, Equatable, ExpressibleByBooleanLiteral {
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

  /// `defineControlPoints(["new-checkout": .local(true)])`.
  public static func local(_ value: Bool, description: String? = nil) -> FireweaveLocalControlPoint {
    FireweaveLocalControlPoint(localValue: value, description: description)
  }
}

/// Every control point the app reads, keyed by control point key. It lives
/// in its own file (`FireweaveLocalControlPoints.swift` by convention) and is passed as
/// `startFireweave(controlPoints:)`.
public typealias FireweaveLocalControlPoints = [String: FireweaveLocalControlPoint]

/// Declares the app's control points and returns them unchanged.
///
/// ```swift
/// // FireweaveLocalControlPoints.swift
/// let appControlPoints = defineControlPoints([
///   "new-checkout": .local(true, description: "New checkout flow"),
/// ])
/// ```
///
/// Every key is checked with the core's control point key rule. A bad key
/// stops a debug build here, where it was typed; `startFireweave` rejects it
/// with a Configuration error naming the key in every build.
public func defineControlPoints(_ controlPoints: FireweaveLocalControlPoints) -> FireweaveLocalControlPoints {
  if case .failure(let error) = normalizeControlPoints(controlPoints) {
    assertionFailure(error.message)
  }
  return controlPoints
}

/// Checks every key with the core's control point key rule, in key order.
func normalizeControlPoints(_ controlPoints: FireweaveLocalControlPoints) -> Result<FireweaveLocalControlPoints, FireweaveError> {
  for key in controlPoints.keys.sorted() {
    if case .failure(let problem) = validateControlPointKey(key) {
      return .failure(
        startConfigurationError(
          "controlPoints: \"\(key)\" is not a valid control point key (\(problem.message))."
        )
      )
    }
  }
  return .success(controlPoints)
}

/// The core local adapter's seed map.
func localSeeds(_ controlPoints: FireweaveLocalControlPoints) -> [String: Bool] {
  controlPoints.mapValues { $0.localValue }
}

/// A canonical rendering of the local values, for the idempotency check.
func controlPointsSignature(_ controlPoints: FireweaveLocalControlPoints) -> String {
  controlPoints.keys.sorted()
    .map { key in "\(key)=\(controlPoints[key]?.localValue == true)" }
    .joined(separator: ";")
}
