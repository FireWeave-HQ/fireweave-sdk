import Testing

@testable import Fireweave

@Suite("Host allowlist (SSRF guard)")
struct HostsTests {
  @Test func loopbackHttpIsAllowedByDefault() throws {
    try assertHostAllowed("http://127.0.0.1:3901", allowedHosts: nil, initFatal: true)
    try assertHostAllowed("http://localhost:3901", allowedHosts: nil, initFatal: true)
  }

  @Test func canonicalHttpsHostIsAllowedByDefault() throws {
    try assertHostAllowed("https://app-server.fireweave.ai", allowedHosts: nil, initFatal: true)
  }

  @Test func nonLoopbackHttpIsRejected() {
    #expect(throws: FireweaveError.self) {
      try assertHostAllowed("http://example.com", allowedHosts: nil, initFatal: true)
    }
  }

  @Test func hostOutsideAllowlistIsRejectedEvenWithExplicitList() {
    let allow = ["127.0.0.1", "localhost", "us.i.posthog.com"]
    #expect(throws: FireweaveError.self) {
      try assertHostAllowed("http://169.254.169.254", allowedHosts: allow, initFatal: true)
    }
  }

  @Test func wildcardOptsOutExplicitly() throws {
    try assertHostAllowed("https://anything.example.com", allowedHosts: ["*"], initFatal: true)
  }

  @Test func malformedUrlIsRejected() {
    #expect(throws: FireweaveError.self) {
      try assertHostAllowed("not-a-uri", allowedHosts: nil, initFatal: true)
    }
  }

  @Test func rejectionCarriesConfigurationKindAndNoHostEcho() {
    do {
      try assertHostAllowed("http://evil.example.com", allowedHosts: nil, initFatal: true)
      Issue.record("expected a throw")
    } catch let error as FireweaveError {
      #expect(error.kind == .configuration)
      #expect(error.message == "invalid configuration")
      #expect(!error.message.contains("evil.example.com"))
    } catch {
      Issue.record("unexpected error type")
    }
  }
}
