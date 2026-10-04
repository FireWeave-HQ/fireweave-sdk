/// Every name the start profile reads, in one place, so the README, the error
/// messages and the guard tests cannot drift apart.
enum StartNames {
  // Server profile: the process environment.

  /// The project key (`project-api-key_…`).
  static let serverKey = "FIREWEAVE_KEY"
  static let url = "FIREWEAVE_URL"
  static let environment = "FIREWEAVE_ENV"
  /// Read after `FIREWEAVE_ENV` on the server profile. `FW_ENV` is not read.
  static let environmentFallback = "APP_ENV"
  static let instanceId = "FIREWEAVE_INSTANCE_ID"
  /// Read before the POSIX host name, as the Node SDK does, so one host
  /// gives one instance key in every SDK.
  static let hostName = "HOSTNAME"

  /// Names the scaffolded harness wrote. Read only when the replacement is
  /// unset, with one warning each, for the whole 2.x line.
  static let legacyServerKeyNames = ["FW_PROJECT_API_KEY"]
  static let legacyURLNames = ["FW_API_URL", "FW_ATTEST_URL"]

  // App profile: Info.plist values, normally `$(SETTING)` from an xcconfig.

  /// The browser key (`fw_public_…`).
  static let browserKey = "FIREWEAVE_BROWSER_KEY"
  /// The scaffolded harness's endpoint key. Read only when FIREWEAVE_URL is
  /// unset, with one warning.
  static let legacyPlistURLNames = ["FWApiUrl"]
  /// The scaffolded harness's key. It held a server-family key, which must
  /// never ship inside an app, so it is never used: it is detected only to
  /// say so.
  static let retiredPlistKey = "FWProjectApiKey"

  // Rules.

  /// Environment names that mean "local development" when no key is set.
  /// Compared trimmed and case-insensitively.
  static let devEnvironments: Set<String> = ["development", "dev", "local", "test"]
  /// Hosts allowed beside a custom endpoint, so local stacks keep working.
  static let loopbackHosts = ["localhost", "127.0.0.1", "::1"]
  static let browserKeyPrefix = "fw_public_"
  static let serverKeyPrefix = "project-api-key_"
  static let tokenPrefixes = ["fw_org_", "cli_at_"]

  // Identity.

  /// The UserDefaults key and value prefix the scaffolded harness used, so
  /// an app that migrates keeps every install in the same ramp bucket.
  static let deviceIdDefaultsKey = "fireweave.device-id"
  static let deviceIdPrefix = "dev_"
  static let instanceKeyPrefix = "inst_"

  /// Where an app's flags live by convention; named in the local-mode
  /// "missing key" warning.
  static let flagsFile = "FireweaveFlags.swift"

  // Option names, as messages and `FireweaveStatus` sources spell them.

  static let keyOption = "startFireweave(key:)"
  static let urlOption = "startFireweave(url:)"
  static let environmentOption = "startFireweave(environment:)"
}
