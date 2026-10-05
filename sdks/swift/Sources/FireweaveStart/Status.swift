import Fireweave

/// Where the process-wide start is in its life (`fw.status.state`).
///
/// The raw values match the other start profiles' state names.
public enum FireweaveStartState: String, Sendable, Equatable {
  /// `startFireweave` has not run. Reads serve their defaults.
  case notStarted = "NOT_STARTED"
  /// Started; the first prefetch has not settled. Remote reads serve their
  /// defaults (`NotReady`); local reads already answer from the flags.
  case initializing = "INITIALIZING"
  case ready = "READY"
  /// The prefetch missed its ceiling, or a re-fetch failed after an earlier
  /// success (`status.problem` says why): reads serve the last decisions
  /// fetched, if any, with reason `STALE`.
  case stale = "STALE"
  /// The prefetch failed with nothing good to serve (`status.problem` says
  /// why); reads serve their defaults with an `ERROR` decision.
  case error = "ERROR"
  /// The configuration was refused: an app's `startFireweave` (which never
  /// throws), or the core after `startFireweave` returned. `status.problem`
  /// says why; reads serve their defaults.
  case failed = "FAILED"
  /// `fw.shutdown()` ran. Reads serve their defaults (`AlreadyClosed`) until
  /// the next `startFireweave`.
  case shutdown = "SHUTDOWN"
}

/// Why the start is not serving decisions. The message is the core's
/// redacted, fixed message: never a key.
public struct FireweaveStartProblem: Sendable, Equatable {
  public let kind: ErrorKind
  public let message: String
}

/// What `startFireweave` decided and how it is going. It never contains the
/// key, so it is safe to log or send to a crash reporter.
///
/// ```swift
/// print("fireweave:", fw.status)
/// ```
public struct FireweaveStatus: Sendable, Equatable {
  public var state: FireweaveStartState
  /// Nil until a start resolved one.
  public var profile: FireweaveProfile?
  public var mode: Mode?
  /// Why that mode: the `mode` option, a key, or the environment name.
  public var modeSource: FireweaveModeSource?
  /// This SDK build's release channel, which chooses the default endpoint.
  public var channel: FireweaveChannel
  public var sdkVersion: String
  /// The fw-server host name only (remote mode): never a path or a
  /// credential.
  public var host: String?
  /// Where the endpoint came from: an option, a variable or Info.plist key,
  /// or "SDK channel (…)".
  public var endpointSource: String?
  /// The option, variable or Info.plist key the key came from; "none" in
  /// local mode.
  public var keySource: String?
  /// The environment name, when it chose local mode.
  public var environment: String?
  public var flagCount: Int
  public var problem: FireweaveStartProblem?
  /// The kind of the latest failed fw-server request (`.authentication`,
  /// `.authorization`, `.rateLimited`, `.network`, …; SP-27). It stays after
  /// a later success, which clears `problem`, so a key that was refused once
  /// is still visible. Nil until a request fails.
  public var lastErrorKind: ErrorKind?
}
