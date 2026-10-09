import Foundation
import Testing

@testable import Fireweave

/// `contracts/errors.json` `rules.redaction`: every SDK's redactor turns
/// each vector's `in` into exactly its `out` (`contracts/errors.md` rule 2),
/// and its name and prefix lists are the contract's.
@Suite("Redaction contract")
struct RedactionContractTests {
  private static func redactionRules() throws -> [String: Any] {
    let path = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // FireweaveTests/
      .deletingLastPathComponent()  // Tests/
      .deletingLastPathComponent()  // sdks/swift/
      .deletingLastPathComponent()  // sdks/
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("contracts/errors.json")
    let data = try Data(contentsOf: path)
    let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
    let rules = root?["rules"] as? [String: Any]
    return try #require(rules?["redaction"] as? [String: Any])
  }

  @Test func everyVectorRedactsExactly() throws {
    let rules = try Self.redactionRules()
    let vectors = try #require(rules["vectors"] as? [[String: Any]])
    #expect(vectors.count >= 16)
    for vector in vectors {
      let input = try #require(vector["in"] as? String)
      let output = try #require(vector["out"] as? String)
      #expect(redactSecrets(input) == output, "in: \(input)")
    }
  }

  @Test func theNamesPrefixesAndPlaceholderAreTheContracts() throws {
    let rules = try Self.redactionRules()
    #expect(rules["placeholder"] as? String == redactionPlaceholder)
    #expect(rules["assignmentNames"] as? [String] == redactionAssignmentNames)
    #expect(rules["valuePrefixes"] as? [String] == redactionValuePrefixes)
  }
}
