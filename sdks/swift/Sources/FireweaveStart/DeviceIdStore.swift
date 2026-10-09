import Foundation

// The ONLY file in this module that touches UserDefaults
// (Tests/FireweaveStartTests/StartGuardTests.swift pins that).

/// Where the app profile keeps its anonymous device id between launches.
protocol DeviceIdStoring: Sendable {
  /// The stored id, verbatim, or nil when none is stored (or it is blank).
  func load() -> String?
  func save(_ deviceId: String)
  func remove()
}

/// `fireweave.device-id` in UserDefaults: the key and `dev_<UUID>` format the
/// scaffolded harness used, so an app that migrates keeps every install in
/// the same ramp bucket. UserDefaults rather than the Keychain on purpose:
/// the id is not a secret, and it must not survive an uninstall.
///
/// `@unchecked Sendable`: this class has no mutable state of its own, and
/// UserDefaults is documented as thread-safe, but not every SDK this
/// package builds against marks it `Sendable`.
final class UserDefaultsDeviceIdStore: DeviceIdStoring, @unchecked Sendable {
  private let defaults: UserDefaults

  init(defaults: UserDefaults) {
    self.defaults = defaults
  }

  func load() -> String? {
    guard let stored = defaults.string(forKey: StartNames.deviceIdDefaultsKey) else {
      return nil
    }
    return nonBlank(stored) == nil ? nil : stored
  }

  func save(_ deviceId: String) {
    defaults.set(deviceId, forKey: StartNames.deviceIdDefaultsKey)
  }

  func remove() {
    defaults.removeObject(forKey: StartNames.deviceIdDefaultsKey)
  }
}

/// The server profile's store: it keeps nothing, so a server never touches
/// UserDefaults.
struct DiscardingDeviceIdStore: DeviceIdStoring {
  func load() -> String? { nil }
  func save(_ deviceId: String) {}
  func remove() {}
}

/// The store a real app uses: `UserDefaults.standard`.
func liveDeviceIdStore() -> any DeviceIdStoring {
  UserDefaultsDeviceIdStore(defaults: .standard)
}

/// A fresh anonymous id, `dev_<UUID>`.
func mintDeviceId() -> String {
  StartNames.deviceIdPrefix + UUID().uuidString
}
