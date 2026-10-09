import Testing

@testable import Fireweave

@Suite("Errors")
struct ErrorsTests {
  @Test func redactsKeyShapedValues() {
    #expect(redactSecrets("key phc_SUPERSECRET0000 leaked") == "key [REDACTED] leaked")
    #expect(redactSecrets("phs_abc-DEF_123") == "[REDACTED]")
    // A prefix with no value after it is prose (`rules.redaction.value`).
    #expect(redactSecrets("phx_") == "phx_")
  }

  @Test func redactsBearerTokensButKeepsTheWord() {
    #expect(
      redactSecrets("Authorization: Bearer abc.def.ghi") == "Authorization: Bearer [REDACTED]"
    )
  }

  @Test func redactsTheValueOfANamedAssignmentButKeepsTheName() {
    #expect(redactSecrets("FW_PROJECT_API_KEY=supersecret") == "FW_PROJECT_API_KEY=[REDACTED]")
    #expect(
      redactSecrets("FW_PROJECT_API_KEY : supersecret") == "FW_PROJECT_API_KEY : [REDACTED]"
    )
    #expect(redactSecrets("FIREWEAVE_KEY='abc', next") == "FIREWEAVE_KEY='[REDACTED]', next")
    // No assignment marker: the name alone stays.
    #expect(redactSecrets("FW_PROJECT_API_KEY is unset") == "FW_PROJECT_API_KEY is unset")
  }

  @Test func redactsURLUserinfoOnly() {
    #expect(
      redactSecrets("GET http://key@localhost:3000/v1") == "GET http://[REDACTED]@localhost:3000/v1"
    )
    // An `@` after the path is not userinfo.
    let noUserinfo = "https://fw.example.com/v1?to=a@b"
    #expect(redactSecrets(noUserinfo) == noUserinfo)
  }

  @Test func redactionLeavesWhitespaceAloneAndErrorsCollapseIt() {
    #expect(redactSecrets("  a   b  ") == "  a   b  ")
    let error = FireweaveError(kind: .network, message: "  a   b\n\tc  ")
    #expect(error.message == "a b c")
  }

  @Test func errorMessagesAreRedacted() {
    let error = FireweaveError(kind: .authentication, message: "FIREWEAVE_KEY=fw_org_abc refused")
    #expect(error.message == "FIREWEAVE_KEY=[REDACTED] refused")
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
