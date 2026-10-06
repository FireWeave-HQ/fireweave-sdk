import Fireweave

/// The process-wide FireWeave handle, reached as `fw`.
///
/// Safe to use from any thread or actor, in any order: before
/// `startFireweave`, reads serve their defaults and `identify` returns a
/// `NotReady` failure. Nothing here throws.
public final class FireweaveHandle: Sendable {
  let core: StartCore

  /// Read control points: `fw.controlPoints.getBooleanValue("key", default: false)`.
  /// Synchronous.
  public let controlPoints: FireweaveControlPoints

  init(core: StartCore) {
    self.core = core
    self.controlPoints = FireweaveControlPoints(core: core)
  }

  /// Sign-in and session restore: registers the user's targeting properties.
  ///
  /// - App profile: then re-prefetches under the user's key, so ramps bucket
  ///   on the user. Calls to `identify`, `reset` and `forget` run one at a
  ///   time, in call order, and the last one wins.
  /// - Server profile: registration only. It runs concurrently and never
  ///   changes the process's decisions, which stay keyed by `instanceKey()`.
  ///
  /// Returns the core's result and never throws: a sign-in path must not
  /// break on targeting. A blank key is an `InvalidContext` failure.
  @discardableResult
  public func identify(
    _ targetingKey: String,
    properties: [String: JSONValue] = [:],
    kind: TargetKind = .user
  ) async -> RegisterTargetResult {
    let options = RegisterTargetOptions(
      kind: kind,
      properties: properties.isEmpty ? nil : properties
    )
    return await core.identify(targetingKey, options: options)
  }

  /// App sign-out: re-prefetches under this install's device id. On a server
  /// it does nothing (one warning).
  public func reset() async {
    await core.reset()
  }

  /// App: the anonymous key decisions are prefetched under before
  /// `identify`, for joining with analytics. Nil before start and on a server.
  public var deviceId: String? {
    core.deviceId
  }

  /// App consent: `.memory` deletes the stored device id and stores nothing
  /// more; `.userDefaults` stores the current id again. Takes effect at once
  /// and is never part of the `startFireweave` configuration check.
  public func setPersistence(_ persistence: FireweavePersistence) {
    core.setPersistence(persistence)
  }

  /// App consent withdrawn or account deleted: deletes the stored device id,
  /// switches to `.memory`, and re-prefetches under a fresh id. On a server
  /// it does nothing (one warning).
  public func forget() async {
    await core.forget()
  }

  /// Server: a stable targeting key for reads where the process itself is
  /// the subject (cron, workers, boot-time decisions), and the key the
  /// process prefetches under. The `instanceId` option, else
  /// `FIREWEAVE_INSTANCE_ID`, else `inst_` plus a hash of the host name. It
  /// works before start and never writes to disk. Set
  /// `FIREWEAVE_INSTANCE_ID` when replicas share a host name. In an app it
  /// is the device id.
  public func instanceKey() -> String {
    core.instanceKey()
  }

  /// Waits for the first prefetch to settle, or for `timeout`, and returns
  /// the state. Without a timeout it is still bounded by the core's
  /// prefetch ceiling (5 seconds). Never throws.
  ///
  /// ```swift
  /// startFireweave()
  /// await fw.ready()  // the first request sees decisions
  /// ```
  @discardableResult
  public func ready(timeout: Duration? = nil) async -> FireweaveStartState {
    await core.ready(timeout: timeout)
  }

  /// What `startFireweave` decided and how it is going: state, profile, mode
  /// and why, channel, SDK version, host, endpoint source, key source,
  /// environment, control-point count, problem and the latest fw-server error kind.
  /// Never the key.
  public var status: FireweaveStatus {
    core.status
  }

  /// State changes, starting with the current state: after start, when the
  /// first prefetch settles, after `identify`, `reset` and `forget`, and on
  /// shutdown. SwiftUI does not re-render when decisions change; observe
  /// this to re-read. Each access returns a new stream.
  public var updates: AsyncStream<FireweaveStartState> {
    core.updates()
  }

  /// The running core client, for anything this handle does not cover. Nil
  /// until the first prefetch settles. Shut down with `fw.shutdown()`, never
  /// through the client.
  public var client: FireweaveClient? {
    core.client
  }

  /// Closes the running client and stops a server's periodic re-fetch.
  /// Afterwards reads serve their defaults (`AlreadyClosed`) until the next
  /// `startFireweave`, which may use any configuration.
  public func shutdown() async {
    await core.shutdown()
  }
}
