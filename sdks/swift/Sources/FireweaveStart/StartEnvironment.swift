import Foundation

#if canImport(Glibc)
  import Glibc
#elseif canImport(Musl)
  import Musl
#elseif canImport(Darwin)
  import Darwin
#endif

// The ONLY file in this module that reads the process environment, Info.plist
// (`Bundle.main`) or the host name. The core reads none of them
// (spec/modes.md); the start profile is the documented exception
// (docs/adr/0012-start-profile.md), and
// Tests/FireweaveStartTests/StartGuardTests.swift pins every such read to this
// file. UserDefaults has its own seam, `DeviceIdStore.swift`.

/// Everything the start profile reads from the process it runs in. `live` is
/// the real process; tests build their own, so app-profile rules run on
/// Linux too.
struct StartSources: Sendable {
  /// One process-environment variable, trimmed; nil when unset or blank.
  var env: @Sendable (String) -> String?
  /// One Info.plist string value, trimmed; nil when absent or blank. An
  /// undefined `$(SETTING)` expands to an empty string, so it counts as unset.
  var infoPlist: @Sendable (String) -> String?
  /// The POSIX host name, or nil when the OS will not say.
  var hostName: @Sendable () -> String?
  /// The profile `startFireweave` uses when no `profile` option is passed.
  var platformProfile: FireweaveProfile
  /// `FIREWEAVE_START_DEBUG`: this target was compiled in a debug configuration.
  var isDebugBuild: Bool
  var channel: FireweaveChannel
  var sdkVersion: String
  /// The device-id store for the app profile.
  var makeStore: @Sendable () -> any DeviceIdStoring
}

extension StartSources {
  /// The running process.
  static let live = StartSources(
    env: { name in nonBlank(ProcessInfo.processInfo.environment[name]) },
    infoPlist: { name in
      nonBlank(Bundle.main.object(forInfoDictionaryKey: name) as? String)
    },
    hostName: { posixHostName() },
    platformProfile: livePlatformProfile(),
    isDebugBuild: compiledForDebug,
    channel: .current,
    sdkVersion: BuildInfo.sdkVersion,
    makeStore: { liveDeviceIdStore() }
  )
}

#if FIREWEAVE_START_DEBUG
  private let compiledForDebug = true
#else
  private let compiledForDebug = false
#endif

/// iOS, iPadOS and Mac Catalyst processes are apps. On macOS a process is an
/// app when it runs from a `.app` or `.appex` bundle (app extensions and
/// widgets included); a bare executable is a server. Everything else (Linux)
/// is a server.
private func livePlatformProfile() -> FireweaveProfile {
  #if os(iOS)
    return .app
  #elseif os(macOS)
    let bundleExtension = Bundle.main.bundleURL.pathExtension
    return bundleExtension == "app" || bundleExtension == "appex" ? .app : .server
  #else
    return .server
  #endif
}

/// `gethostname(2)`. Deliberately not `ProcessInfo.hostName`, which can
/// block on a reverse DNS lookup on macOS.
private func posixHostName() -> String? {
  #if canImport(Glibc) || canImport(Musl) || canImport(Darwin)
    let size = 256
    var buffer = [CChar](repeating: 0, count: size)
    // One byte short, so the name is always NUL-terminated.
    guard gethostname(&buffer, size - 1) == 0 else { return nil }
    buffer[size - 1] = 0
    let name = buffer.withUnsafeBufferPointer { pointer -> String? in
      guard let base = pointer.baseAddress else { return nil }
      return String(cString: base)
    }
    return nonBlank(name)
  #else
    return nil
  #endif
}
