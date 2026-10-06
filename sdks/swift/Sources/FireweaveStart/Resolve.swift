import Fireweave
import Foundation

// The pure start-profile resolver: options, lookups and the build channel
// in, one resolved configuration (or a Configuration error) out. It does no
// I/O and touches no global state: the environment, Info.plist and the debug
// flag arrive as injected lookups (`StartEnvironment.swift` holds the live
// ones), so every rule here is unit-tested through `resolveStart` alone.
//
// Precedence for every value: the `startFireweave` option, then the source
// for the profile (Info.plist for an app, the process environment for a
// server), then a legacy name with one warning, then the default. Empty and
// whitespace-only values count as unset. Messages name the option, variable
// or Info.plist key at fault, never its value.

/// Why a mode was chosen: the `mode` option, a key that was found, or a
/// development environment name.
public enum FireweaveModeSource: String, Sendable, Equatable {
  case option
  case key
  case environment
}

/// A trimmed, non-empty value and the option, variable or Info.plist key it
/// came from.
struct Sourced: Sendable, Equatable {
  var value: String
  var source: String
}

/// Where the resolver may look. Each lookup returns nil for an unset, empty
/// or whitespace-only value.
struct StartLookups: Sendable {
  var env: @Sendable (String) -> String?
  var infoPlist: @Sendable (String) -> String?
  /// `FIREWEAVE_START_DEBUG`: this target was compiled in a debug
  /// configuration. Consulted by the app profile only.
  var isDebugBuild: Bool
}

/// One start decision. `key` is held only to hand it to the core; it is
/// never logged and never part of `FireweaveStatus`.
struct ResolvedStart: Sendable {
  var profile: FireweaveProfile
  var mode: Mode
  var modeSource: FireweaveModeSource
  var controlPoints: FireweaveLocalControlPoints
  var channel: FireweaveChannel
  var sdkVersion: String
  /// Remote only.
  var url: String?
  var urlSource: String?
  /// Remote only, and nil for the channel default (the core's own list
  /// admits both channel hosts).
  var allowedHosts: [String]?
  var key: String?
  var keySource = "none"
  /// Set when an environment name chose local mode.
  var environment: String?
  var environmentSource: String?
  /// Lines to log once each: legacy names, an ignored key.
  var warnings: [String] = []
}

/// `value` trimmed, or nil when it is nil, empty or only whitespace.
func nonBlank(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

/// Wraps a caller-supplied lookup so its values are trimmed and blank
/// counts as unset.
func trimmingLookup(
  _ lookup: @escaping @Sendable (String) -> String?
) -> @Sendable (String) -> String? {
  return { name in nonBlank(lookup(name)) }
}

/// Sentence parts joined with single spaces, so long messages stay readable
/// in source.
func phrase(_ parts: String...) -> String {
  parts.joined(separator: " ")
}

/// A Configuration error raised by `startFireweave`, before any I/O. It
/// carries `PROVIDER_FATAL`, like every row of the core's initialisation
/// table.
func startConfigurationError(_ message: String) -> FireweaveError {
  .configuration("[fireweave] " + message, initFatal: true)
}

/// Applies the start profile's rules. Throws a Configuration
/// `FireweaveError` naming the source at fault.
///
/// Mode rule: an explicit `mode` wins (local ignores a key, with one
/// warning; remote without a key is an error). Otherwise a key means remote;
/// no key and an environment name of development, dev, local or test means
/// local; anything else fails closed, so a build that forgot its key never
/// turns into silent local evaluation.
func resolveStart(
  _ options: FireweaveStartOptions,
  profile: FireweaveProfile,
  lookups: StartLookups,
  channel: FireweaveChannel,
  sdkVersion: String
) throws -> ResolvedStart {
  let controlPoints = try normalizeControlPoints(options.controlPoints).get()
  var warnings = retiredKeyWarnings(profile, lookups)
  let keySources = keyOrigins(profile, lookups)

  if options.mode == .local {
    // The key is ignored. Look only to say so.
    var ignored: [String] = []
    let found = pick(
      option: options.key,
      optionLabel: StartNames.keyOption,
      origins: keySources,
      warnings: &ignored
    )
    if let found {
      warnings.append(
        "[fireweave] startFireweave(mode: .local) ignores the key from \(found.source);"
          + " nothing is sent to fw-server."
      )
    }
    return ResolvedStart(
      profile: profile,
      mode: .local,
      modeSource: .option,
      controlPoints: controlPoints,
      channel: channel,
      sdkVersion: sdkVersion,
      warnings: warnings
    )
  }

  let key = pick(
    option: options.key,
    optionLabel: StartNames.keyOption,
    origins: keySources,
    warnings: &warnings
  )
  if let key {
    try checkKeyFamily(key, profile: profile)
    let endpoint = try resolveEndpoint(
      options.url,
      profile: profile,
      lookups: lookups,
      channel: channel,
      warnings: &warnings
    )
    return ResolvedStart(
      profile: profile,
      mode: .remote,
      modeSource: options.mode == .remote ? .option : .key,
      controlPoints: controlPoints,
      channel: channel,
      sdkVersion: sdkVersion,
      url: endpoint.url,
      urlSource: endpoint.source,
      allowedHosts: endpoint.allowedHosts,
      key: key.value,
      keySource: key.source,
      warnings: warnings
    )
  }

  if options.mode == .remote {
    throw startConfigurationError(remoteNeedsKeyMessage(profile))
  }

  let environment = resolveEnvironment(options.environment, profile: profile, lookups: lookups)
  if let environment, StartNames.devEnvironments.contains(environment.value.lowercased()) {
    return ResolvedStart(
      profile: profile,
      mode: .local,
      modeSource: .environment,
      controlPoints: controlPoints,
      channel: channel,
      sdkVersion: sdkVersion,
      environment: environment.value,
      environmentSource: environment.source,
      warnings: warnings
    )
  }
  throw startConfigurationError(missingKeyMessage(profile, environment: environment, lookups))
}

// MARK: - Sources

/// One place a setting may come from, after the option.
private struct Origin {
  var name: String
  /// How messages and `FireweaveStatus` name it.
  var label: String
  /// Set for a legacy name: the name that replaces it.
  var replacement: String?
  var lookup: @Sendable (String) -> String?
}

private func envOrigin(
  _ name: String,
  _ lookups: StartLookups,
  replacing replacement: String? = nil
) -> Origin {
  Origin(name: name, label: name, replacement: replacement, lookup: lookups.env)
}

private func plistOrigin(
  _ name: String,
  _ lookups: StartLookups,
  replacing replacement: String? = nil
) -> Origin {
  Origin(
    name: name,
    label: "Info.plist " + name,
    replacement: replacement,
    lookup: lookups.infoPlist
  )
}

/// The first set value among the option and `origins`, in order. A legacy
/// origin adds one warning naming its replacement.
private func pick(
  option: String?,
  optionLabel: String,
  origins: [Origin],
  warnings: inout [String]
) -> Sourced? {
  if let value = nonBlank(option) {
    return Sourced(value: value, source: optionLabel)
  }
  for origin in origins {
    guard let value = nonBlank(origin.lookup(origin.name)) else { continue }
    if let replacement = origin.replacement {
      warnings.append(
        "[fireweave] \(origin.label) is a legacy name and will stop being read in the next"
          + " major version (v3). Rename it to \(replacement); the value does not change."
      )
    }
    return Sourced(value: value, source: origin.label)
  }
  return nil
}

/// The app profile reads Info.plist only; the server profile reads the
/// process environment only.
private func keyOrigins(_ profile: FireweaveProfile, _ lookups: StartLookups) -> [Origin] {
  switch profile {
  case .app:
    return [plistOrigin(StartNames.browserKey, lookups)]
  case .server:
    let legacy = StartNames.legacyServerKeyNames.map { name in
      envOrigin(name, lookups, replacing: StartNames.serverKey)
    }
    return [envOrigin(StartNames.serverKey, lookups)] + legacy
  }
}

private func urlOrigins(_ profile: FireweaveProfile, _ lookups: StartLookups) -> [Origin] {
  switch profile {
  case .app:
    let legacy = StartNames.legacyPlistURLNames.map { name in
      plistOrigin(name, lookups, replacing: StartNames.url)
    }
    return [plistOrigin(StartNames.url, lookups)] + legacy
  case .server:
    let legacy = StartNames.legacyURLNames.map { name in
      envOrigin(name, lookups, replacing: StartNames.url)
    }
    return [envOrigin(StartNames.url, lookups)] + legacy
  }
}

/// The environment name that may choose local mode. An app's debug build
/// with no name counts as development; a release build never does.
private func resolveEnvironment(
  _ option: String?,
  profile: FireweaveProfile,
  lookups: StartLookups
) -> Sourced? {
  let origins: [Origin]
  switch profile {
  case .app:
    origins = [plistOrigin(StartNames.environment, lookups)]
  case .server:
    origins = [
      envOrigin(StartNames.environment, lookups),
      envOrigin(StartNames.environmentFallback, lookups),
    ]
  }
  var unused: [String] = []
  let found = pick(
    option: option,
    optionLabel: StartNames.environmentOption,
    origins: origins,
    warnings: &unused
  )
  if let found { return found }
  if profile == .app && lookups.isDebugBuild {
    return Sourced(value: "development", source: "a debug build (FIREWEAVE_START_DEBUG)")
  }
  return nil
}

/// The scaffolded harness put a server-family key in Info.plist. It is never
/// used, but it ships inside the app, so say so.
private func retiredKeyWarnings(_ profile: FireweaveProfile, _ lookups: StartLookups) -> [String] {
  guard profile == .app, nonBlank(lookups.infoPlist(StartNames.retiredPlistKey)) != nil else {
    return []
  }
  return [retiredKeySentence(prefix: "[fireweave] ")]
}

private func retiredKeySentence(prefix: String) -> String {
  let sentence = phrase(
    "Info.plist \(StartNames.retiredPlistKey) holds a server-family key, which ships inside",
    "the app where anyone can read it. Remove it and revoke that key; the app profile reads",
    "a browser key (fw_public_…) from \(StartNames.browserKey)."
  )
  return prefix + sentence
}

// MARK: - Keys

/// Analytics-vendor key shapes: two letters, one lower-case letter, then an
/// underscore. A pattern rather than literal prefixes, so no vendor key
/// prefix appears in this file or in an error.
func isAnalyticsVendorKey(_ value: String) -> Bool {
  let scalars = Array(value.unicodeScalars.prefix(4))
  guard scalars.count == 4, scalars[0] == "p", scalars[1] == "h", scalars[3] == "_" else {
    return false
  }
  return (0x61...0x7A).contains(scalars[2].value)
}

/// Checks the key family before any request. Messages name the source,
/// never the value.
func checkKeyFamily(_ key: Sourced, profile: FireweaveProfile) throws {
  let value = key.value
  let from = "The key from \(key.source)"
  let isToken = StartNames.tokenPrefixes.contains { value.hasPrefix($0) }
  switch profile {
  case .app:
    if value.hasPrefix(StartNames.browserKeyPrefix) { return }
    if value.hasPrefix(StartNames.serverKeyPrefix) {
      throw startConfigurationError(
        "\(from) is a server key (project-api-key_…), which must never ship inside an app."
          + " Use a browser key (fw_public_…) from Project settings, API keys."
          + " If a build with this key was distributed, revoke the key."
      )
    }
    if isAnalyticsVendorKey(value) {
      throw startConfigurationError(
        "\(from) is an analytics vendor key, not a FireWeave browser key (fw_public_…)."
      )
    }
    if isToken {
      throw startConfigurationError(
        "\(from) is an organisation or CLI token, not a FireWeave browser key (fw_public_…)."
      )
    }
    throw startConfigurationError("\(from) is not a FireWeave browser key (fw_public_…).")
  case .server:
    if value.hasPrefix(StartNames.browserKeyPrefix) {
      throw startConfigurationError(
        "\(from) is a browser key (fw_public_…). Server apps need a project key"
          + " (project-api-key_…) from Project settings, API keys."
      )
    }
    if isAnalyticsVendorKey(value) {
      throw startConfigurationError(
        "\(from) is an analytics vendor key, not a FireWeave project key."
          + " Use the project key (project-api-key_…)."
      )
    }
    if isToken {
      throw startConfigurationError(
        "\(from) is an organisation or CLI token, not a project key."
          + " Use the project key (project-api-key_…)."
      )
    }
  }
}

private func remoteNeedsKeyMessage(_ profile: FireweaveProfile) -> String {
  switch profile {
  case .app:
    return phrase(
      "startFireweave(mode: .remote) needs a browser key. Set \(StartNames.browserKey) in",
      "Info.plist or pass \(StartNames.keyOption)."
    )
  case .server:
    return phrase(
      "startFireweave(mode: .remote) needs a key. Set \(StartNames.serverKey) or pass",
      "\(StartNames.keyOption)."
    )
  }
}

/// A short plain token that does not look like a key, so it is safe to
/// quote back in an error.
func isEchoable(_ value: String) -> Bool {
  guard (1...32).contains(value.unicodeScalars.count) else { return false }
  let plain = value.unicodeScalars.allSatisfy { scalar in
    switch scalar.value {
    case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x2E, 0x5F: return true
    default: return false
    }
  }
  if !plain || isAnalyticsVendorKey(value) { return false }
  return !value.hasPrefix(StartNames.serverKeyPrefix) && !value.hasPrefix("fw_")
}

private func missingKeyMessage(
  _ profile: FireweaveProfile,
  environment: Sourced?,
  _ lookups: StartLookups
) -> String {
  let situation: String
  if let environment, isEchoable(environment.value) {
    situation = phrase(
      "the environment is \"\(environment.value)\" (from \(environment.source)), which is",
      "not a development name"
    )
  } else if let environment {
    situation = "the environment name from \(environment.source) is not a development name"
  } else if profile == .app {
    situation = phrase(
      "this is a release build with no environment name (checked",
      "\(StartNames.environmentOption) and Info.plist \(StartNames.environment))"
    )
  } else {
    situation = phrase(
      "no environment name is set (checked \(StartNames.environmentOption),",
      "\(StartNames.environment) and \(StartNames.environmentFallback))"
    )
  }
  switch profile {
  case .app:
    let message = phrase(
      "\(StartNames.browserKey) is not set in Info.plist and \(situation). Add an Info.plist",
      "entry \(StartNames.browserKey) with the value $(\(StartNames.browserKey)), set that",
      "build setting to a browser key (fw_public_…), or pass startFireweave(mode: .local)",
      "for local work."
    )
    guard nonBlank(lookups.infoPlist(StartNames.retiredPlistKey)) != nil else {
      return message
    }
    return message + retiredKeySentence(prefix: " ")
  case .server:
    return phrase(
      "\(StartNames.serverKey) is not set and \(situation). Set \(StartNames.serverKey) to",
      "the project's server key (project-api-key_…), or for local development set",
      "\(StartNames.environment) to development or pass startFireweave(mode: .local)."
    )
  }
}

// MARK: - Endpoint

/// The fw-server endpoint and the host allowlist that goes with it.
struct Endpoint: Sendable, Equatable {
  var url: String
  var source: String
  var allowedHosts: [String]?
}

/// The default is this build's channel host, which the core's default
/// allowlist already admits. An override gets an allowlist of its own host
/// plus loopback.
private func resolveEndpoint(
  _ option: String?,
  profile: FireweaveProfile,
  lookups: StartLookups,
  channel: FireweaveChannel,
  warnings: inout [String]
) throws -> Endpoint {
  let picked = pick(
    option: option,
    optionLabel: StartNames.urlOption,
    origins: urlOrigins(profile, lookups),
    warnings: &warnings
  )
  guard let picked else {
    return Endpoint(
      url: channel.defaultURL,
      source: "SDK channel (\(channel.rawValue))",
      allowedHosts: nil
    )
  }
  return try checkedEndpoint(picked)
}

/// https is required except on loopback. The check reuses the core's own
/// host parsing (`assertHostAllowed`), so the start profile and the core can
/// never disagree about a URL.
func checkedEndpoint(_ picked: Sourced) throws -> Endpoint {
  var raw = picked.value
  while raw.hasSuffix("/") { raw.removeLast() }
  guard
    let components = URLComponents(string: raw),
    let scheme = components.scheme?.lowercased(),
    scheme == "http" || scheme == "https",
    let host = components.host?.lowercased(),
    !host.isEmpty
  else {
    throw startConfigurationError("The endpoint from \(picked.source) is not a valid URL.")
  }
  if scheme == "http" && !isLoopbackHostname(host) {
    throw startConfigurationError(
      "The endpoint from \(picked.source) must use https (http is allowed only for localhost)."
    )
  }
  let hosts = [host] + StartNames.loopbackHosts.filter { $0 != host }
  do {
    try assertHostAllowed(raw, allowedHosts: hosts, initFatal: true)
  } catch {
    throw startConfigurationError("The endpoint from \(picked.source) is not a valid URL.")
  }
  return Endpoint(url: raw, source: picked.source, allowedHosts: hosts)
}
