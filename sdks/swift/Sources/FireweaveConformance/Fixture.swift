import Fireweave
import Foundation

/// One `contracts/<suite>/*.json` fixture (or one `cases[]` entry within
/// one), as a plain `JSONValue` tree — mirrors python/rust's own dynamic
/// JSON-tree approach to fixture consumption rather than fixed `Codable`
/// structs, since fixture shapes vary meaningfully across the six suites.
struct Fixture {
  let id: String
  let suite: String
  let json: JSONValue

  var given: JSONValue { json.objectValue?["given"] ?? .object([:]) }
  var when: JSONValue { json.objectValue?["when"] ?? .object([:]) }
  var expect: JSONValue { json.objectValue?["expect"] ?? .object([:]) }
  var cases: [JSONValue]? { json.objectValue?["cases"]?.arrayValue }
}

enum FixtureLoader {
  static let suites = ["evaluation", "context", "lifecycle", "faults", "security", "extensions"]

  static func loadAll(contractsDir: URL) throws -> [Fixture] {
    var fixtures: [Fixture] = []
    for suite in suites {
      let dir = contractsDir.appendingPathComponent(suite)
      let entries =
        (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
        ?? []
      for file in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
      where file.pathExtension == "json" {
        let data = try Data(contentsOf: file)
        let json = try JSONValue.parse(data: data)
        guard let id = json.objectValue?["id"]?.stringValue else { continue }
        fixtures.append(Fixture(id: id, suite: suite, json: json))
      }
    }
    return fixtures
  }
}

extension JSONValue {
  subscript(key: String) -> JSONValue? { objectValue?[key] }
}
