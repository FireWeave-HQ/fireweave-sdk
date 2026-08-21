import Testing

@testable import Fireweave

@Suite("Errors")
struct ErrorsTests {
  @Test func redactsProjectKeyPrefixes() {
    #expect(redactSecrets("key phc_SUPERSECRET0000 leaked") == "key [REDACTED] leaked")
    #expect(redactSecrets("phs_abc-DEF_123") == "[REDACTED]")
    #expect(redactSecrets("phx_") == "[REDACTED]")
  }

  @Test func redactsBearerTokens() {
    #expect(redactSecrets("Authorization: Bearer abc.def.ghi") == "Authorization: [REDACTED]")
  }

  @Test func redactsFwProjectApiKeyAssignment() {
    #expect(redactSecrets("FW_PROJECT_API_KEY=supersecret") == "[REDACTED]")
    #expect(redactSecrets("FW_PROJECT_API_KEY : supersecret") == "[REDACTED]")
    // No assignment marker -> not matched (mirrors the reference regex).
    #expect(redactSecrets("FW_PROJECT_API_KEY is unset") == "FW_PROJECT_API_KEY is unset")
  }

  @Test func collapsesWhitespaceAndTrims() {
    #expect(redactSecrets("  a   b\n\tc  ") == "a b c")
  }

  @Test func leavesOrdinaryTextAlone() {
    #expect(redactSecrets("invalid configuration") == "invalid configuration")
  }

  @Test func errorKindTaxonomyHasFifteenMembers() {
    #expect(ErrorKind.allCases.count == 15)
  }

  @Test func targetingKeyMissingOverridesTheErrorCode() {
    let err = FireweaveError.targetingKeyMissing()
    #expect(err.openFeatureErrorCode == "TARGETING_KEY_MISSING")
    #expect(err.kind == .invalidContext)
  }

  @Test func configurationInitFatalOverridesTheErrorCode() {
    let err = FireweaveError.configuration("bad host", initFatal: true)
    #expect(err.openFeatureErrorCode == "PROVIDER_FATAL")
    let runtimeErr = FireweaveError.configuration("bad host", initFatal: false)
    #expect(runtimeErr.openFeatureErrorCode == "GENERAL")
  }

  @Test func alreadyClosedMapsToProviderNotReady() {
    #expect(FireweaveError(kind: .alreadyClosed).openFeatureErrorCode == "PROVIDER_NOT_READY")
  }

  @Test func retryableKindsAreExactlyTheDocumentedFive() {
    let retryable: Set<ErrorKind> = [
      .notReady, .rateLimited, .timeout, .network, .backendUnavailable,
    ]
    for kind in ErrorKind.allCases {
      #expect(kind.isRetryable == retryable.contains(kind))
    }
  }
}
