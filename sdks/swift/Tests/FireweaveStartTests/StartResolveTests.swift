import Foundation
import Testing

@testable import FireweaveStart

/// The pure resolver (`Resolve.swift`): precedence, the mode rule, key
/// families, the endpoint and its allowlist, for both profiles. Mirrors the
/// Go and Node resolver tables row for row where the rules are shared.
private func resolve(
  _ options: FireweaveStartOptions = FireweaveStartOptions(),
  profile: FireweaveProfile = .server,
  env: [String: String] = [:],
  plist: [String: String] = [:],
  debug: Bool = false,
  channel: FireweaveChannel = .production
) throws -> ResolvedStart {
  let lookups = StartLookups(
    env: { name in nonBlank(env[name]) },
    infoPlist: { name in nonBlank(plist[name]) },
    isDebugBuild: debug
  )
  return try resolveStart(
    options,
    profile: profile,
    lookups: lookups,
    channel: channel,
    sdkVersion: "2.2.0"
  )
}

private func failure(
  _ options: FireweaveStartOptions = FireweaveStartOptions(),
  profile: FireweaveProfile = .server,
  env: [String: String] = [:],
  plist: [String: String] = [:],
  debug: Bool = false
) -> FireweaveError? {
  startError {
    _ = try resolve(options, profile: profile, env: env, plist: plist, debug: debug)
  }
}

@Suite("Start profile: server resolution")
struct ServerResolveTests {
  @Test func aKeyFromTheEnvironmentMeansRemoteOnTheChannelHost() throws {
    let config = try resolve(env: ["FIREWEAVE_KEY": testProjectKey])
    #expect(config.profile == .server)
    #expect(config.mode == .remote)
    #expect(config.modeSource == .key)
    #expect(config.key == testProjectKey)
    #expect(config.keySource == "FIREWEAVE_KEY")
    #expect(config.url == "https://app-server.fireweave.ai")
    #expect(config.urlSource == "SDK channel (production)")
    #expect(config.allowedHosts == nil)
    #expect(config.warnings.isEmpty)
  }

  @Test func aStagingBuildDefaultsToTheStagingHost() throws {
    let config = try resolve(env: ["FIREWEAVE_KEY": testProjectKey], channel: .staging)
    #expect(config.url == "https://staging-app-server.fireweave.ai")
    #expect(config.urlSource == "SDK channel (staging)")
    #expect(config.allowedHosts == nil)
  }

  @Test func theKeyOptionBeatsTheEnvironment() throws {
    let options = FireweaveStartOptions(key: "project-api-key_option")
    let config = try resolve(options, env: ["FIREWEAVE_KEY": testProjectKey])
    #expect(config.key == "project-api-key_option")
    #expect(config.keySource == "startFireweave(key:)")
  }

  @Test func blankValuesAreUnsetAndLegacyNamesWarn() throws {
    let env = [
      "FIREWEAVE_KEY": "   ",
      "FW_PROJECT_API_KEY": testProjectKey,
      "FW_API_URL": "https://flags.example.com/",
    ]
    let config = try resolve(env: env)
    #expect(config.key == testProjectKey)
    #expect(config.keySource == "FW_PROJECT_API_KEY")
    #expect(config.url == "https://flags.example.com")
    #expect(config.urlSource == "FW_API_URL")
    #expect(config.warnings.count == 2)
    let keyWarning = config.warnings.first { $0.contains("FW_PROJECT_API_KEY is a legacy name") }
    #expect(keyWarning?.contains("Rename it to FIREWEAVE_KEY") == true)
  }

  @Test func fireweaveURLBeatsTheLegacyNames() throws {
    let env = [
      "FIREWEAVE_KEY": testProjectKey,
      "FIREWEAVE_URL": "https://flags.example.com",
      "FW_ATTEST_URL": "https://old.example.com",
    ]
    let config = try resolve(env: env)
    #expect(config.urlSource == "FIREWEAVE_URL")
    #expect(config.warnings.isEmpty)
  }

  @Test func explicitLocalIgnoresAKeyWithOneWarning() throws {
    let options = FireweaveStartOptions(mode: .local)
    let config = try resolve(options, env: ["FIREWEAVE_KEY": testProjectKey, "APP_ENV": "prod"])
    #expect(config.mode == .local)
    #expect(config.modeSource == .option)
    #expect(config.key == nil)
    #expect(config.url == nil)
    #expect(config.keySource == "none")
    #expect(config.warnings.count == 1)
    #expect(config.warnings.first?.contains("ignores the key from FIREWEAVE_KEY") == true)
  }

  @Test func explicitRemoteWithAKeyIsRemoteFromTheOption() throws {
    let options = FireweaveStartOptions(mode: .remote)
    let env = ["FIREWEAVE_KEY": testProjectKey, "FIREWEAVE_ENV": "development"]
    let config = try resolve(options, env: env)
    #expect(config.mode == .remote)
    #expect(config.modeSource == .option)
  }

  @Test func explicitRemoteWithoutAKeyFailsAtStart() throws {
    let options = FireweaveStartOptions(mode: .remote)
    let error = try #require(failure(options, env: ["FIREWEAVE_ENV": "development"]))
    #expect(error.kind == .configuration)
    #expect(error.initFatal)
    #expect(error.openFeatureErrorCode == "PROVIDER_FATAL")
    #expect(error.message.contains("needs a key"))
    #expect(error.message.contains("FIREWEAVE_KEY"))
  }

  @Test func developmentEnvironmentNamesMeanLocal() throws {
    for name in ["development", "DEV", " Local ", "test"] {
      let config = try resolve(env: ["FIREWEAVE_ENV": name])
      #expect(config.mode == .local, "\(name)")
      #expect(config.modeSource == .environment)
      #expect(config.environment == name.trimmingCharacters(in: .whitespaces))
      #expect(config.environmentSource == "FIREWEAVE_ENV")
    }
  }

  @Test func appEnvIsTheFallbackEnvironmentName() throws {
    let config = try resolve(env: ["APP_ENV": "test"])
    #expect(config.mode == .local)
    #expect(config.environmentSource == "APP_ENV")
  }

  @Test func fireweaveEnvBeatsAppEnv() throws {
    let env = ["FIREWEAVE_ENV": "production", "APP_ENV": "development"]
    let error = try #require(failure(env: env))
    #expect(error.message.contains("\"production\" (from FIREWEAVE_ENV)"))
  }

  @Test func theEnvironmentOptionBeatsTheVariables() throws {
    let options = FireweaveStartOptions(environment: "development")
    let config = try resolve(options, env: ["FIREWEAVE_ENV": "production"])
    #expect(config.mode == .local)
    #expect(config.environmentSource == "startFireweave(environment:)")
  }

  @Test func noKeyAndNoEnvironmentFailsClosed() throws {
    let error = try #require(failure())
    #expect(error.kind == .configuration)
    #expect(error.message.contains("FIREWEAVE_KEY is not set"))
    #expect(error.message.contains("no environment name is set"))
  }

  @Test func fwEnvIsNotRead() throws {
    #expect(failure(env: ["FW_ENV": "development"]) != nil)
  }

  @Test func aDebugBuildDoesNotMakeAServerLocal() throws {
    #expect(failure(debug: true) != nil)
  }

  @Test func anEnvironmentNameThatLooksLikeAKeyIsNotEchoed() throws {
    let error = try #require(failure(env: ["FIREWEAVE_ENV": testProjectKey]))
    #expect(!error.message.contains(testProjectKey))
    #expect(error.message.contains("the environment name from FIREWEAVE_ENV"))
  }

  @Test func wrongKeyFamiliesFailNamingTheSourceNotTheValue() throws {
    let cases: [(key: String, expected: String)] = [
      ("fw_public_abc123", "browser key"),
      (vendorPrefix("c") + "abc123", "analytics vendor key"),
      ("fw_org_abc123", "organisation or CLI token"),
      ("cli_at_abc123", "organisation or CLI token"),
    ]
    for (key, expected) in cases {
      let error = try #require(failure(env: ["FIREWEAVE_KEY": key]))
      #expect(error.message.contains(expected), "\(expected)")
      #expect(error.message.contains("FIREWEAVE_KEY"))
      #expect(!error.message.contains(key))
    }
  }

  @Test func anUnknownKeyShapeIsLeftToFwServer() throws {
    let config = try resolve(env: ["FIREWEAVE_KEY": "opaque-key-123"])
    #expect(config.mode == .remote)
  }

  @Test func httpIsAllowedOnlyOnLoopback() throws {
    let insecure = ["FIREWEAVE_KEY": testProjectKey, "FIREWEAVE_URL": "http://flags.example.com"]
    let error = try #require(failure(env: insecure))
    #expect(error.message.contains("must use https"))
    #expect(error.message.contains("FIREWEAVE_URL"))
    #expect(!error.message.contains("flags.example.com"))

    let local = ["FIREWEAVE_KEY": testProjectKey, "FIREWEAVE_URL": "http://localhost:8080/"]
    let config = try resolve(env: local)
    #expect(config.url == "http://localhost:8080")
    #expect(config.allowedHosts == ["localhost", "127.0.0.1", "::1"])
  }

  @Test func anOverriddenEndpointAllowsItsHostPlusLoopback() throws {
    let options = FireweaveStartOptions(url: "https://Flags.Example.com//")
    let config = try resolve(options, env: ["FIREWEAVE_KEY": testProjectKey])
    #expect(config.url == "https://Flags.Example.com")
    #expect(config.urlSource == "startFireweave(url:)")
    #expect(config.allowedHosts == ["flags.example.com", "localhost", "127.0.0.1", "::1"])
  }

  @Test func malformedEndpointsFail() throws {
    for url in ["not a url", "ftp://flags.example.com", "https://", "flags.example.com"] {
      let env = ["FIREWEAVE_KEY": testProjectKey, "FIREWEAVE_URL": url]
      let error = try #require(failure(env: env), "\(url)")
      #expect(error.message.contains("is not a valid URL"), "\(url)")
    }
  }

  @Test func badFlagKeysFailNamingTheKey() throws {
    let options = FireweaveStartOptions(controlPoints: ["": true], mode: .local)
    let error = try #require(failure(options))
    #expect(error.kind == .configuration)
    #expect(error.message.contains("controlPoints:"))
  }
}

@Suite("Start profile: app resolution")
struct AppResolveTests {
  @Test func aBrowserKeyFromInfoPlistMeansRemote() throws {
    let config = try resolve(profile: .app, plist: ["FIREWEAVE_BROWSER_KEY": testBrowserKey])
    #expect(config.profile == .app)
    #expect(config.mode == .remote)
    #expect(config.modeSource == .key)
    #expect(config.keySource == "Info.plist FIREWEAVE_BROWSER_KEY")
    #expect(config.url == "https://app-server.fireweave.ai")
  }

  @Test func theAppProfileDoesNotReadTheProcessEnvironment() throws {
    let env = ["FIREWEAVE_KEY": testProjectKey, "FIREWEAVE_ENV": "development"]
    let error = try #require(failure(profile: .app, env: env))
    #expect(error.message.contains("FIREWEAVE_BROWSER_KEY is not set"))
    #expect(error.message.contains("release build"))
  }

  @Test func aServerKeyInInfoPlistFailsWithARevokeInstruction() throws {
    let error = try #require(
      failure(profile: .app, plist: ["FIREWEAVE_BROWSER_KEY": testProjectKey])
    )
    #expect(error.message.contains("server key"))
    #expect(error.message.contains("revoke the key"))
    #expect(error.message.contains("Info.plist FIREWEAVE_BROWSER_KEY"))
    #expect(!error.message.contains(testProjectKey))
  }

  @Test func otherKeyFamiliesFail() throws {
    let cases: [(key: String, expected: String)] = [
      (vendorPrefix("c") + "abc123", "analytics vendor key"),
      ("fw_org_abc123", "organisation or CLI token"),
      ("cli_at_abc123", "organisation or CLI token"),
      ("opaque-key-123", "is not a FireWeave browser key"),
    ]
    for (key, expected) in cases {
      let error = try #require(failure(profile: .app, plist: ["FIREWEAVE_BROWSER_KEY": key]))
      #expect(error.message.contains(expected), "\(expected)")
      #expect(!error.message.contains(key))
    }
  }

  @Test func theKeyOptionMustAlsoBeABrowserKey() throws {
    let options = FireweaveStartOptions(key: testProjectKey)
    let error = try #require(failure(options, profile: .app))
    #expect(error.message.contains("startFireweave(key:)"))
  }

  @Test func aDebugBuildWithNoKeyIsLocal() throws {
    let config = try resolve(profile: .app, debug: true)
    #expect(config.mode == .local)
    #expect(config.modeSource == .environment)
    #expect(config.environment == "development")
    #expect(config.environmentSource?.contains("debug build") == true)
  }

  @Test func aReleaseBuildWithNoKeyFailsClosed() throws {
    let error = try #require(failure(profile: .app))
    #expect(error.message.contains("FIREWEAVE_BROWSER_KEY is not set in Info.plist"))
    #expect(error.message.contains("startFireweave(mode: .local)"))
  }

  @Test func anExplicitEnvironmentBeatsTheDebugFallback() throws {
    let plist = ["FIREWEAVE_ENV": "production"]
    #expect(failure(profile: .app, plist: plist, debug: true) != nil)
  }

  @Test func aDevelopmentNameInInfoPlistIsLocalInAnyBuild() throws {
    let config = try resolve(profile: .app, plist: ["FIREWEAVE_ENV": "development"])
    #expect(config.mode == .local)
    #expect(config.environmentSource == "Info.plist FIREWEAVE_ENV")
  }

  @Test func theRetiredPlistKeyIsNeverUsedAndIsReported() throws {
    let plist = ["FWProjectApiKey": testProjectKey]
    let error = try #require(failure(profile: .app, plist: plist))
    #expect(error.message.contains("FWProjectApiKey"))
    #expect(error.message.contains("revoke"))
    #expect(!error.message.contains(testProjectKey))

    let config = try resolve(profile: .app, plist: plist, debug: true)
    #expect(config.mode == .local)
    let warned = config.warnings.contains { $0.contains("FWProjectApiKey") }
    #expect(warned)
  }

  @Test func theEndpointComesFromInfoPlistAndTheLegacyNameWarns() throws {
    let plist = [
      "FIREWEAVE_BROWSER_KEY": testBrowserKey,
      "FWApiUrl": "https://flags.example.com",
    ]
    let config = try resolve(profile: .app, plist: plist)
    #expect(config.url == "https://flags.example.com")
    #expect(config.urlSource == "Info.plist FWApiUrl")
    let warned = config.warnings.contains { $0.contains("Info.plist FWApiUrl is a legacy name") }
    #expect(warned)
  }
}
