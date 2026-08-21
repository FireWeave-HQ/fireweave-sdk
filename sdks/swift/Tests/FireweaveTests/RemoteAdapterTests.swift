import Foundation
import Testing

@testable import Fireweave

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// Injectable fake transport (`RemoteHTTPTransport`) — no real sockets, no
/// `URLProtocol` registration quirks across platforms. Returns a fixed
/// status/body for every request, recording what was sent for assertions.
final class FakeTransport: RemoteHTTPTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var statusCode: Int
  private var body: Data
  private(set) var lastRequest: URLRequest?

  init(statusCode: Int = 200, bodyJSON: String) {
    self.statusCode = statusCode
    self.body = Data(bodyJSON.utf8)
  }

  func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
    lock.withLock { lastRequest = request }
    let response = HTTPURLResponse(
      url: request.url!, statusCode: statusCode, httpVersion: "HTTP/1.1", headerFields: nil
    )!
    return (body, response)
  }
}

@Suite("FireweaveRemoteAdapter")
struct RemoteAdapterTests {
  private func makeReadyAdapter(
    transport: RemoteHTTPTransport, apiUrl: String = "http://127.0.0.1:9"
  ) async throws
    -> FireweaveRemoteAdapter
  {
    let adapter = FireweaveRemoteAdapter(
      config: RemoteAdapterConfig(apiUrl: apiUrl, apiKey: "test-key"), transport: transport
    )
    try await adapter.initialize()
    return adapter
  }

  @Test func vendorMetadataSurfacesWhenServerSendsBothKeys() async throws {
    let transport = FakeTransport(
      bodyJSON: """
        {"decisions":[{"flagKey":"f","value":true,"variant":"on","reason":"TARGETING_MATCH","found":true,\
        "enabled":true,"flagMetadata":{"fireweave.vendorFlagId":1001,"fireweave.reasonCode":"condition_match"}}]}
        """
    )
    let adapter = try await makeReadyAdapter(transport: transport)
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "user-1"))
    let decision = runtime.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))

    #expect(decision.value == .bool(true))
    #expect(decision.flagMetadata["fireweave.vendorFlagId"] == .number(1001))
    #expect(decision.flagMetadata["fireweave.reasonCode"] == .string("condition_match"))
  }

  @Test func omitsVendorMetadataWhenOnlyOneKeyPresent() async throws {
    let transport = FakeTransport(
      bodyJSON: """
        {"decisions":[{"flagKey":"f","value":true,"variant":"on","reason":"TARGETING_MATCH","found":true,\
        "enabled":true,"flagMetadata":{"fireweave.reasonCode":"condition_match"}}]}
        """
    )
    let adapter = try await makeReadyAdapter(transport: transport)
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "user-1"))
    let decision = runtime.evaluate(key: "f", type: .boolean, defaultValue: .bool(false))

    #expect(decision.flagMetadata["fireweave.vendorFlagId"] == nil)
    #expect(decision.flagMetadata["fireweave.reasonCode"] == nil)
  }

  @Test func absentKeyFromDecisionsIsFlagNotFound() async throws {
    let transport = FakeTransport(bodyJSON: #"{"decisions":[]}"#)
    let adapter = try await makeReadyAdapter(transport: transport)
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "user-1"))
    let decision = runtime.evaluate(key: "missing", type: .boolean, defaultValue: .bool(false))
    #expect(decision.errorKind == .flagNotFound)
  }

  @Test func httpStatusMapsToTheDocumentedErrorKind() async throws {
    let cases: [(Int, ErrorKind)] = [
      (401, .authentication), (403, .authorization), (429, .rateLimited),
      (500, .backendUnavailable),
    ]
    for (status, expectedKind) in cases {
      let transport = FakeTransport(statusCode: status, bodyJSON: "{}")
      let adapter = try await makeReadyAdapter(transport: transport)
      let runtime = FireweaveRuntime(adapter: adapter)
      await runtime.initialize(context: EvaluationContext(targetingKey: "user-1"))
      #expect(runtime.state() == .error, "status \(status)")
      #expect(runtime.initializationError()?.kind == expectedKind, "status \(status)")
    }
  }

  @Test func malformedJsonBodyIsMalformedResponse() async throws {
    let transport = FakeTransport(bodyJSON: "not json")
    let adapter = try await makeReadyAdapter(transport: transport)
    let runtime = FireweaveRuntime(adapter: adapter)
    await runtime.initialize(context: EvaluationContext(targetingKey: "user-1"))
    #expect(runtime.initializationError()?.kind == .malformedResponse)
  }

  /// A missing targetingKey at PREFETCH time returns an empty batch
  /// rather than throwing (see `RemoteAdapter.swift`'s `prefetch()` doc
  /// comment for the full reasoning) — this is what lets an anonymous
  /// pre-sign-in boot reach `.ready` with an empty cache instead of
  /// getting stuck unable to initialize at all.
  @Test func missingTargetingKeyAtPrefetchReturnsEmptyBatchNotAThrow() async throws {
    let transport = FakeTransport(bodyJSON: #"{"decisions":[]}"#)
    let adapter = try await makeReadyAdapter(transport: transport)
    let result = try await adapter.prefetch(context: EvaluationContext(), options: nil)
    #expect(result.isEmpty)
  }

  /// `registerTarget` still hard-requires a targeting key — registering
  /// an anonymous target has no meaning, unlike a prefetch.
  @Test func missingTargetingKeyAtRegisterTargetStillFails() async throws {
    let transport = FakeTransport(bodyJSON: "{}")
    let adapter = try await makeReadyAdapter(transport: transport)
    let result = await adapter.registerTarget(targetingKey: "", options: nil)
    #expect(!result.ok)
    #expect(result.error?.kind == .invalidContext)
  }

  @Test func hostAllowlistRejectsNonLoopbackHttp() async {
    let adapter = FireweaveRemoteAdapter(
      config: RemoteAdapterConfig(apiUrl: "http://169.254.169.254", apiKey: "k"),
      transport: FakeTransport(bodyJSON: "{}")
    )
    await #expect(throws: FireweaveError.self) {
      try await adapter.initialize()
    }
  }

  @Test func registerTargetSendsPropertiesAndSucceeds() async throws {
    let transport = FakeTransport(bodyJSON: "{}")
    let adapter = try await makeReadyAdapter(transport: transport)
    let result = await adapter.registerTarget(
      targetingKey: "user-1", options: RegisterTargetOptions(properties: ["plan": "pro"])
    )
    #expect(result.ok)
  }
}
