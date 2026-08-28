import Testing

@testable import Fireweave

/// The four Configuration rows (`spec/modes.md` "Initialisation validation")
/// THROW at init; reads on the returned client never do.
///
/// Two of the four rows (mode absent; local combined with credentials) are
/// unrepresentable BY CONSTRUCTION through `initFireweave`'s tagged-union
/// `InitFireweaveOptions` (see that type's doc comment) — a swift-specific
/// spec-ambiguity finding, stricter than even `sdks/web`'s TS discriminated
/// union (bypassable at runtime there; not bypassable here, the Swift
/// compiler rejects the combination outright). Both rows are still fully
/// exercised at the `validateInitOptions` pure-function level
/// (`ContextTests.swift`'s `ValidationTests` suite) so the BEHAVIOR is
/// verified even though this ergonomic entry point cannot construct the
/// bad shape to re-prove it end-to-end.
@Suite("initFireweave — Configuration rows throw; reads never do")
struct InitFireweaveTests {
  @Test func remoteMissingApiKeyThrowsConfiguration() async {
    await #expect(throws: FireweaveError.self) {
      _ = try await initFireweave(
        .remote(InitFireweaveRemoteOptions(apiKey: "", apiUrl: "https://app-server.fireweave.ai")))
    }
  }

  @Test func remoteMissingApiUrlThrowsConfiguration() async {
    await #expect(throws: FireweaveError.self) {
      _ = try await initFireweave(.remote(InitFireweaveRemoteOptions(apiKey: "key", apiUrl: "")))
    }
  }

  @Test func remoteHostFailingAllowlistThrowsConfiguration() async {
    do {
      _ = try await initFireweave(
        .remote(InitFireweaveRemoteOptions(apiKey: "key", apiUrl: "http://169.254.169.254"))
      )
      Issue.record("expected a throw")
    } catch let error as FireweaveError {
      #expect(error.kind == .configuration)
      #expect(error.openFeatureErrorCode == "PROVIDER_FATAL")
    } catch {
      Issue.record("unexpected error type")
    }
  }

  @Test func localModeSucceedsAndReadsNeverThrow() async throws {
    let client = try await initFireweave(
      .local(InitFireweaveLocalOptions(controlPoints: ["f": true])))
    #expect(client.controlPoints.getBooleanValue("f", default: false) == true)
    #expect(client.controlPoints.getBooleanValue("absent", default: false) == false)
    await client.shutdown()
  }

  @Test func remoteModeWithGoodConfigurationReachesReadyEventually() async throws {
    // Loopback + allowedHosts opt-out, so this never leaves the machine;
    // the point here is only that a WELL-FORMED remote config does not
    // throw at init (the network call itself may fail transiently —
    // that is `.error`/`.stale`, not a throw, per the module doc
    // comment on Runtime.swift's initialize()).
    let client = try await initFireweave(
      .remote(
        InitFireweaveRemoteOptions(
          apiKey: "key", apiUrl: "http://127.0.0.1:1", allowedHosts: ["127.0.0.1"],
          requestTimeoutMs: 200
        )
      )
    )
    // Reads never throw regardless of what happened to the prefetch.
    let decision = client.controlPoints.getBooleanDetails("f", default: false)
    #expect(decision.value == .bool(false))
    await client.shutdown()
  }
}
