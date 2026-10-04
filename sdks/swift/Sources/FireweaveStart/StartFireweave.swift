import Fireweave

/// Which kind of process is starting FireWeave. It decides where
/// configuration is read from and what the anonymous targeting key is.
public enum FireweaveProfile: String, Sendable, Equatable {
  /// An iOS, iPadOS, Mac Catalyst or macOS app, or an app extension. Reads
  /// Info.plist (`FIREWEAVE_BROWSER_KEY`, `FIREWEAVE_URL`, `FIREWEAVE_ENV`),
  /// accepts browser keys (`fw_public_…`) only, and prefetches under a
  /// per-install device id until `fw.identify`.
  case app
  /// A server, worker or command-line tool on Linux or macOS. Reads the
  /// process environment (`FIREWEAVE_KEY`, `FIREWEAVE_URL`, `FIREWEAVE_ENV`,
  /// `APP_ENV`, `FIREWEAVE_INSTANCE_ID`), accepts project keys, and
  /// prefetches under `fw.instanceKey()`.
  case server
}

/// Where the app profile keeps its device id.
public enum FireweavePersistence: String, Sendable, Equatable {
  /// `fireweave.device-id` in UserDefaults: one id per install, so a 10% ramp
  /// means 10% of installs.
  case userDefaults
  /// Nothing is written: a new id every launch, until
  /// `fw.setPersistence(.userDefaults)` (for example once consent is given).
  case memory
}

/// Everything `startFireweave` accepts. Every field is optional; the default
/// value reads everything from Info.plist (app) or the environment (server).
public struct FireweaveStartOptions: Sendable {
  /// Every control point the app reads, with its local value
  /// (`defineFlags`). Served in local mode only.
  public var flags: FireweaveFlags
  /// Forces a mode. Nil: a key means remote; no key means local only when
  /// the environment name is development, dev, local or test.
  public var mode: Mode?
  /// The environment name used to infer the mode, instead of
  /// `FIREWEAVE_ENV` (or, on a server, `APP_ENV`).
  public var environment: String?
  /// The fw-server endpoint. Default: `FIREWEAVE_URL`, else this SDK build's
  /// channel host. https is required except on localhost.
  public var url: String?
  /// The key. App: a browser key (`fw_public_…`), default Info.plist
  /// `FIREWEAVE_BROWSER_KEY`. Server: the project key, default
  /// `FIREWEAVE_KEY`.
  public var key: String?
  /// Overrides the profile chosen from the platform.
  public var profile: FireweaveProfile?
  /// App: an app-owned anonymous id (for example your analytics id), used
  /// verbatim and never stored.
  public var deviceId: String?
  /// App: where the device id is kept. Default `.userDefaults`.
  public var persistence: FireweavePersistence
  /// Server: the value of `fw.instanceKey()`. Default:
  /// `FIREWEAVE_INSTANCE_ID`, else a hash of the host name.
  public var instanceId: String?
  /// Receives every `[fireweave]` line. Default: the unified log on Apple
  /// platforms, standard error elsewhere. Not part of the idempotency check.
  public var log: LogSink?
  /// Replaces the process environment for every variable the server
  /// profile reads: tests, and apps that load configuration themselves.
  /// Return nil for unset.
  public var env: (@Sendable (String) -> String?)?
  /// Replaces `Bundle.main` Info.plist lookups for the app profile (tests).
  /// Return nil for absent.
  public var infoPlist: (@Sendable (String) -> String?)?
  /// Replaces the HTTP transport in remote mode (tests, or a custom
  /// `URLSession` configuration). Not part of the idempotency check.
  public var transport: (any RemoteHTTPTransport)?

  public init(
    flags: FireweaveFlags = [:],
    mode: Mode? = nil,
    environment: String? = nil,
    url: String? = nil,
    key: String? = nil,
    profile: FireweaveProfile? = nil,
    deviceId: String? = nil,
    persistence: FireweavePersistence = .userDefaults,
    instanceId: String? = nil,
    log: LogSink? = nil,
    env: (@Sendable (String) -> String?)? = nil,
    infoPlist: (@Sendable (String) -> String?)? = nil,
    transport: (any RemoteHTTPTransport)? = nil
  ) {
    self.flags = flags
    self.mode = mode
    self.environment = environment
    self.url = url
    self.key = key
    self.profile = profile
    self.deviceId = deviceId
    self.persistence = persistence
    self.instanceId = instanceId
    self.log = log
    self.env = env
    self.infoPlist = infoPlist
    self.transport = transport
  }
}

/// The process-wide FireWeave handle. It exists before `startFireweave`, is
/// the object `startFireweave` returns, and stays the same object across
/// `fw.shutdown()` and a later start, so a reference captured early never
/// goes stale. Write `FireweaveStart.fw` if an app symbol shadows `fw`.
///
/// Link `FireweaveStart` into exactly one binary image: an app and an
/// embedded framework that both link it statically each get their own `fw`.
public let fw = FireweaveHandle(core: StartCore(sources: .live))

/// Starts FireWeave for this process. Call it once, at launch: first thing
/// in a SwiftUI `App.init()`, UIKit `application(_:didFinishLaunchingWithOptions:)`,
/// Vapor `configure(_:)` or `main`.
///
/// ```swift
/// init() { try! startFireweave(flags: appFlags) }
/// ```
///
/// Synchronous: it resolves the configuration, throws on a misconfiguration
/// before any I/O, and starts the first prefetch in the background. Await
/// `fw.ready()` to wait for it. A second call with the same configuration
/// is a no-op; a different one throws and leaves the running client alone.
/// After `fw.shutdown()` any configuration starts fresh.
///
/// Mode rule: `mode` wins (`.local` ignores a key, with one warning;
/// `.remote` without a key throws). Otherwise a key means remote; no key and
/// an environment name of development, dev, local or test means local; an
/// app's debug build with no environment name counts as development.
/// Anything else throws, so a release build that lost its key fails at
/// launch instead of silently serving defaults.
///
/// - Throws: `FireweaveError` of kind `.configuration` (`PROVIDER_FATAL`),
///   naming the option, variable or Info.plist key at fault, never its value.
@discardableResult
public func startFireweave(
  flags: FireweaveFlags = [:],
  mode: Mode? = nil,
  environment: String? = nil,
  url: String? = nil,
  key: String? = nil,
  profile: FireweaveProfile? = nil,
  deviceId: String? = nil,
  persistence: FireweavePersistence = .userDefaults,
  instanceId: String? = nil,
  log: LogSink? = nil
) throws -> FireweaveHandle {
  let options = FireweaveStartOptions(
    flags: flags,
    mode: mode,
    environment: environment,
    url: url,
    key: key,
    profile: profile,
    deviceId: deviceId,
    persistence: persistence,
    instanceId: instanceId,
    log: log
  )
  return try startFireweave(options)
}

/// `startFireweave` with every option, including the test seams (`env`,
/// `infoPlist`, `transport`).
@discardableResult
public func startFireweave(_ options: FireweaveStartOptions) throws -> FireweaveHandle {
  try fw.core.start(options)
  return fw
}

/// For tests only: shuts down and forgets the process-wide start, warnings,
/// log sink and instance key included, so the next `startFireweave` begins
/// as in a new process.
public func resetFireweaveForTesting() async {
  await fw.core.resetForTesting()
}
