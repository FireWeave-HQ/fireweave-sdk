import Foundation

/// A target recorded by `FireweaveLocalAdapter.registerTarget`.
public struct LocalRegisteredTarget: Sendable, Equatable {
  public var targetingKey: String
  public var kind: TargetKind
  public var properties: [String: JSONValue]
  public var environment: String?
}

/// Sink for the `[fireweave:local]` `registerTarget` trace line. Injectable
/// so tests assert the call without capturing stdout/stderr, and so a host
/// that owns its logging can route it (`spec/modes.md` "The ... log sink
/// MUST be injectable").
public typealias LogSink = @Sendable (String) -> Void

private let defaultLogSink: LogSink = { message in
  FileHandle.standardError.write(Data((message + "\n").utf8))
}

/// `FireweaveLocalAdapter` — the DEV substrate for a scaffolded harness.
///
/// Counterpart to `FireweaveRemoteAdapter`: prod evaluates control points
/// against fw-server; dev evaluates them here, in-process, with no network
/// and no credentials. Because it satisfies the same
/// `ControlPointsBackendAdapter` port, the dev branch of a harness runs
/// through the same `FireweaveRuntime` as prod.
///
/// Resolution policy is deliberately minimal (matches node/go/rust's own
/// dev adapters):
///
/// - a key present in the seeded map resolves to its mapped value with
///   reason `.staticReason` — the only supported way to turn a control
///   point ON (or force it OFF) on a laptop;
/// - every other key MISSES, which `FireweaveRuntime` turns into the
///   caller's own default with reason `.defaultReason` — not an error
///   (`spec/modes.md` "Behaviour per mode": local's unknown-key row is
///   deliberately `default`/`DEFAULT`, unlike remote's
///   `default`/`ERROR`/`FlagNotFound`).
public final class FireweaveLocalAdapter: ControlPointsBackendAdapter, @unchecked Sendable {
  private let devFlags: [String: Bool]
  private let log: LogSink
  private let lock = NSLock()
  private var targets: [String: LocalRegisteredTarget] = [:]
  private var closed = false

  public init(devFlags: [String: Bool] = [:], log: LogSink? = nil) {
    self.devFlags = devFlags
    self.log = log ?? defaultLogSink
  }

  public let missReason: DecisionReason? = .defaultReason

  /// Targets recorded this process, for assertions and dev inspection
  /// (`spec/modes.md`: "The recorded set MUST be readable ... so tests
  /// can assert registration without capturing stdout"). Reachable from
  /// the sanctioned entry point via
  /// `client.runtime.backendAdapter as? FireweaveLocalAdapter` — see
  /// `Runtime.swift`'s `backendAdapter` doc comment (rust task-12 finding,
  /// resolved differently here since Swift needs no `AsAny` workaround).
  public func registeredTargets() -> [LocalRegisteredTarget] {
    lock.withLock { Array(targets.values) }
  }

  public func isClosed() -> Bool {
    lock.withLock { closed }
  }

  public func initialize() async throws {
    lock.withLock { closed = false }
  }

  /// Every seeded key resolves to its boolean override, reason
  /// `.staticReason` — no context-based matching in local mode (the
  /// override map is a flat `[String: Bool]`, matching node/go/rust's own
  /// dev-mode adapter, which likewise ignores context entirely).
  public func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult
  {
    var result: PrefetchResult = [:]
    for (key, value) in devFlags {
      result[key] = AdapterResolution(
        found: true,
        enabled: true,
        value: .bool(value),
        variant: value ? "on" : "off",
        flagType: .boolean,
        reason: .staticReason
      )
    }
    return result
  }

  /// Records the target in-process and traces it, rather than reporting
  /// `.unsupportedCapability` (`spec/modes.md` "registerTarget in local
  /// mode").
  ///
  /// The failure being guarded against is a developer believing their
  /// targeting works because nothing objected. A recorded target plus an
  /// explicit `[fireweave:local]` line preserves that guarantee: nothing
  /// is silent, and local dev can exercise targeting rules offline
  /// instead of only in production. No network call is made and nothing
  /// reaches fw-server.
  public func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult
  {
    let kind = options?.kind ?? .defaultKind
    let properties = options?.properties ?? [:]
    let environment = options?.environment

    let target = LocalRegisteredTarget(
      targetingKey: targetingKey, kind: kind, properties: properties, environment: environment
    )
    lock.withLock { targets[targetingKey] = target }

    let propertiesJSON = JSONValue.object(properties).toStableJSONString()
    log(
      "[fireweave:local] registerTarget \(kind.rawValue) \(targetingKey) \(propertiesJSON)"
        + " — recorded in-process, NOT sent to fw-server"
    )

    return .success()
  }

  public func shutdown() async {
    lock.withLock { closed = true }
  }
}
