import Foundation
import Testing

@testable import FireweaveStart

// The shared start-profile suite (`contracts/start/`, `spec/start-profile.md`)
// on Swift. Drives the pure resolver, the instance-key derivation,
// `defineControlPoints` and the channel rule with each case's inputs, and compares
// by the rules in `contracts/start/README.md`. A port of the Node reference
// runner (`sdks/node/test/unit/start-contracts.test.ts`). It writes no
// report: nothing consumes a Swift start report yet.

private let contractLanguage = "swift"

/// The variable and Info.plist names the start profile reads. A source that
/// is one of these stays as it is; any other option label becomes `option`.
private let knownSourceNames: Set<String> = [
  "FIREWEAVE_KEY",
  "FIREWEAVE_URL",
  "FIREWEAVE_ENV",
  "APP_ENV",
  "FW_PROJECT_API_KEY",
  "FW_API_URL",
  "FW_ATTEST_URL",
  "FIREWEAVE_BROWSER_KEY",
  "FWApiUrl",
]

/// How the app profile labels an Info.plist source (`Info.plist NAME`).
private let plistLabelPrefix = "Info.plist "

private func contractsDirectory() -> URL {
  URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()  // FireweaveStartTests/
    .deletingLastPathComponent()  // Tests/
    .deletingLastPathComponent()  // sdks/swift/
    .deletingLastPathComponent()  // sdks/
    .deletingLastPathComponent()  // repository root
    .appendingPathComponent("contracts/start")
}

private func isFixtureFile(_ url: URL) -> Bool {
  let name = url.lastPathComponent
  guard name.hasPrefix("start-"), name.hasSuffix(".json") else { return false }
  return name != "start-fixture.schema.json"
}

/// Every fixture file, sorted, without the schema.
private func fixtureFiles() throws -> [URL] {
  let entries = try FileManager.default.contentsOfDirectory(
    at: contractsDirectory(),
    includingPropertiesForKeys: nil
  )
  let fixtures = entries.filter(isFixtureFile)
  return fixtures.sorted { $0.lastPathComponent < $1.lastPathComponent }
}

// MARK: - Fixture shape (start-fixture.schema.json)

/// Read first, for every fixture: a fixture this language does not run may
/// hold inputs Swift cannot decode (`start-flags-untyped`).
private struct FixtureHeader: Decodable {
  var id: String
  var compatibility: [String: String]
}

private struct StartFixture: Decodable {
  var id: String
  var profile: String
  var cases: [StartCase]
}

private struct StartCase: Decodable {
  var name: String
  var appliesTo: [String]?
  var when: CaseInput
  var expect: CaseExpectation
}

private struct CanonicalOptions: Decodable {
  var key: String?
  var url: String?
  var environment: String?
  var mode: String?
  var instanceId: String?
}

private struct CanonicalFlag: Decodable {
  var local: Bool
  var description: String?
}

private struct CaseInput: Decodable {
  var operation: String
  var options: CanonicalOptions?
  var env: [String: String]?
  var build: [String: String]?
  var channel: String?
  var hostName: String?
  var controlPoints: [String: CanonicalFlag]?
  var version: String?
}

private struct NameChecks: Decodable {
  var mention: [String]?
  var mustNotMention: [String]?
}

private struct ExpectedError: Decodable {
  var kind: String
  var mentions: [String]?
  var mustNotMention: [String]?
}

/// `expect`. Only the fields present are checked, so `allowedHosts` keeps
/// "absent" apart from `null` (no allowlist).
private struct CaseExpectation: Decodable {
  /// The exactly compared string fields, plus `prefix`, by canonical name.
  var strings: [String: String] = [:]
  var hasAllowedHosts = false
  var allowedHosts: [String]?
  var ok: Bool?
  var warnings: NameChecks?
  var error: ExpectedError?

  private enum CodingKeys: String, CodingKey {
    case mode
    case modeSource
    case url
    case urlSource
    case allowedHosts
    case keySource
    case environment
    case environmentSource
    case warnings
    case error
    case ok
    case value
    case prefix
    case channel
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let stringKeys: [CodingKeys] = [
      .mode,
      .modeSource,
      .url,
      .urlSource,
      .keySource,
      .environment,
      .environmentSource,
      .value,
      .prefix,
      .channel,
    ]
    for key in stringKeys {
      if let text = try container.decodeIfPresent(String.self, forKey: key) {
        strings[key.rawValue] = text
      }
    }
    hasAllowedHosts = container.contains(.allowedHosts)
    allowedHosts = try container.decodeIfPresent([String].self, forKey: .allowedHosts)
    ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
    warnings = try container.decodeIfPresent(NameChecks.self, forKey: .warnings)
    error = try container.decodeIfPresent(ExpectedError.self, forKey: .error)
  }
}

// MARK: - Running a case

/// What one case produced, in the README's canonical field names.
private struct Outcome {
  var strings: [String: String] = [:]
  var allowedHosts: [String]?
  var ok = false
  var warnings: [String] = []
  var error: FireweaveError?
  /// The runner could not express the case in Swift.
  var problem: String?
}

/// contracts/start/README.md "Comparing results": a variable or Info.plist
/// name stays as it is, an option label becomes `option`, the default
/// endpoint becomes `channel`, no key stays `none`.
private func normaliseSource(_ source: String?) -> String? {
  guard var name = source else { return nil }
  if name.hasPrefix(plistLabelPrefix) {
    name = String(name.dropFirst(plistLabelPrefix.count))
  }
  if name == "none" { return "none" }
  if name.hasPrefix("SDK channel") { return "channel" }
  if knownSourceNames.contains(name) { return name }
  return "option"
}

/// A server fixture runs against the server profile with `env` as the
/// process environment; a client fixture against the app profile with
/// `build` as Info.plist, as a release build (no debug fallback, SP-11).
private func runResolve(_ when: CaseInput, fixtureProfile: String) -> Outcome {
  let profile: FireweaveProfile
  switch fixtureProfile {
  case "server": profile = .server
  case "client": profile = .app
  default: return Outcome(problem: "a resolve case needs a server or client fixture")
  }
  var mode: Mode?
  if let raw = when.options?.mode {
    guard let parsed = Mode(rawValue: raw) else {
      return Outcome(problem: "mode \"\(raw)\" has no Swift spelling")
    }
    mode = parsed
  }
  let channel = when.channel.flatMap { FireweaveChannel(rawValue: $0) } ?? .production
  let envValues: [String: String] = profile == .server ? (when.env ?? [:]) : [:]
  let plistValues: [String: String] = profile == .app ? (when.build ?? [:]) : [:]
  let lookups = StartLookups(
    env: { name in nonBlank(envValues[name]) },
    infoPlist: { name in nonBlank(plistValues[name]) },
    isDebugBuild: false
  )
  let options = FireweaveStartOptions(
    mode: mode,
    environment: when.options?.environment,
    url: when.options?.url,
    key: when.options?.key
  )
  do {
    let resolved = try resolveStart(
      options,
      profile: profile,
      lookups: lookups,
      channel: channel,
      sdkVersion: "0.0.0-contract"
    )
    var outcome = Outcome()
    outcome.warnings = resolved.warnings
    outcome.strings["mode"] = resolved.mode.rawValue
    outcome.strings["modeSource"] = resolved.modeSource.rawValue
    outcome.strings["url"] = resolved.url
    outcome.strings["urlSource"] = normaliseSource(resolved.urlSource)
    outcome.strings["keySource"] = normaliseSource(resolved.keySource)
    outcome.strings["environment"] = resolved.environment
    outcome.strings["environmentSource"] = normaliseSource(resolved.environmentSource)
    outcome.allowedHosts = resolved.allowedHosts
    return outcome
  } catch let error as FireweaveError {
    return Outcome(error: error)
  } catch {
    return Outcome(problem: "resolveStart threw a non-Fireweave error: \(error)")
  }
}

/// The host name is injected; `env` replaces the process environment.
private func runInstanceKey(_ when: CaseInput) -> Outcome {
  let envValues = when.env ?? [:]
  let host = when.hostName
  let key = deriveInstanceKey(
    option: when.options?.instanceId,
    env: { name in envValues[name] },
    hostName: { host }
  )
  var outcome = Outcome()
  outcome.strings["value"] = key.value
  return outcome
}

/// `defineControlPoints` checks keys with an `assertionFailure`, which would stop a
/// debug test run, so the verdict comes from `normalizeControlPoints`: the check
/// `defineControlPoints` makes and `startFireweave` reports as a Configuration error.
/// `defineControlPoints` itself runs only on controlPoints that pass it.
private func runDefineFlags(_ when: CaseInput) -> Outcome {
  var controlPoints: FireweaveLocalControlPoints = [:]
  for (key, flag) in when.controlPoints ?? [:] {
    controlPoints[key] = FireweaveLocalControlPoint(localValue: flag.local, description: flag.description)
  }
  switch normalizeControlPoints(controlPoints) {
  case .failure(let error):
    return Outcome(error: error)
  case .success:
    var outcome = Outcome()
    outcome.ok = defineControlPoints(controlPoints) == controlPoints
    return outcome
  }
}

private func runChannelForVersion(_ when: CaseInput) -> Outcome {
  var outcome = Outcome()
  outcome.strings["channel"] = channelForVersion(when.version ?? "").rawValue
  return outcome
}

private func run(_ when: CaseInput, fixtureProfile: String) -> Outcome {
  switch when.operation {
  case "resolve":
    return runResolve(when, fixtureProfile: fixtureProfile)
  case "instanceKey":
    return runInstanceKey(when)
  case "defineControlPoints":
    return runDefineFlags(when)
  case "channelForVersion":
    return runChannelForVersion(when)
  default:
    return Outcome(problem: "operation \(when.operation) is not applicable to Swift")
  }
}

// MARK: - Comparing

private func anyLine(_ lines: [String], mentions name: String) -> Bool {
  lines.contains { line in line.contains(name) }
}

private func errorDifferences(_ wanted: ExpectedError, _ outcome: Outcome) -> [String] {
  guard let error = outcome.error else {
    return ["expected a \(wanted.kind) error, got \(outcome.strings)"]
  }
  var diffs: [String] = []
  if error.kind.rawValue != wanted.kind {
    diffs.append("error kind \(error.kind.rawValue), expected \(wanted.kind)")
  }
  for name in wanted.mentions ?? [] where !error.message.contains(name) {
    diffs.append("error does not mention \(name): \(error.message)")
  }
  for name in wanted.mustNotMention ?? [] where error.message.contains(name) {
    diffs.append("error mentions \(name)")
  }
  return diffs
}

/// The differences between `expect` and `outcome`; empty when the case
/// passes.
private func differences(_ expect: CaseExpectation, _ outcome: Outcome) -> [String] {
  if let problem = outcome.problem { return [problem] }
  if let wanted = expect.error { return errorDifferences(wanted, outcome) }
  if let error = outcome.error {
    return ["unexpected \(error.kind.rawValue) error: \(error.message)"]
  }
  var diffs: [String] = []
  for (field, wanted) in expect.strings.sorted(by: { $0.key < $1.key }) {
    if field == "prefix" {
      let value = outcome.strings["value"] ?? ""
      if !value.hasPrefix(wanted) {
        diffs.append("value \(value) does not start with \(wanted)")
      }
      continue
    }
    let got = outcome.strings[field]
    if got != wanted {
      diffs.append("\(field) \(got ?? "null"), expected \(wanted)")
    }
  }
  if expect.hasAllowedHosts {
    let wanted = expect.allowedHosts.map { Set($0) }
    let got = outcome.allowedHosts.map { Set($0) }
    if wanted != got {
      let gotText = outcome.allowedHosts.map { "\($0)" } ?? "null"
      let wantedText = expect.allowedHosts.map { "\($0)" } ?? "null"
      diffs.append("allowedHosts \(gotText), expected \(wantedText)")
    }
  }
  if let wanted = expect.ok, outcome.ok != wanted {
    diffs.append("ok \(outcome.ok), expected \(wanted)")
  }
  if let checks = expect.warnings {
    for name in checks.mention ?? [] where !anyLine(outcome.warnings, mentions: name) {
      diffs.append("no warning mentions \(name)")
    }
    for name in checks.mustNotMention ?? [] where anyLine(outcome.warnings, mentions: name) {
      diffs.append("a warning mentions \(name)")
    }
  }
  return diffs
}

/// Nil when the case passes or does not apply to Swift (`appliesTo`).
private func caseFailure(of testCase: StartCase, in fixture: StartFixture) -> String? {
  if let languages = testCase.appliesTo, !languages.contains(contractLanguage) {
    return nil
  }
  let outcome = run(testCase.when, fixtureProfile: fixture.profile)
  let diffs = differences(testCase.expect, outcome)
  return diffs.isEmpty ? nil : "\(testCase.name): \(diffs.joined(separator: "; "))"
}

@Suite("Start profile: shared contracts (contracts/start)")
struct StartContractsTests {
  @Test func theSharedSuiteIsPresent() throws {
    let files = try fixtureFiles()
    #expect(files.count >= 10)
  }

  /// One expectation per fixture whose `compatibility.swift` is `pass`: every
  /// case that applies to Swift passes.
  @Test func everyFixtureDeclaredPassForSwiftPasses() throws {
    var declared = 0
    for file in try fixtureFiles() {
      let data = try Data(contentsOf: file)
      let header = try JSONDecoder().decode(FixtureHeader.self, from: data)
      guard header.compatibility[contractLanguage] == "pass" else { continue }
      declared += 1
      let fixture = try JSONDecoder().decode(StartFixture.self, from: data)
      let failures = fixture.cases.compactMap { caseFailure(of: $0, in: fixture) }
      #expect(failures.isEmpty, "\(fixture.id): \(failures.joined(separator: " | "))")
    }
    #expect(declared > 0)
  }
}
