import Fireweave

/// One row of `contracts/README.md`'s compatibility-report schema — the
/// SAME shape every language writes.
struct ResultRow {
  let fixtureId: String
  let suite: String
  let status: String
  let limitation: String?
  let message: String?

  func toJSON() -> JSONValue {
    .object([
      "fixtureId": .string(fixtureId),
      "suite": .string(suite),
      "language": .string("swift"),
      "status": .string(status),
      "limitation": limitation.map(JSONValue.string) ?? .null,
      "message": message.map(JSONValue.string) ?? .null,
    ])
  }
}

enum Status {
  static let pass = "pass"
  static let fail = "fail"
  static let skippedWithDocumentedLimitation = "skipped-with-documented-limitation"
  static let skippedV1OutOfScope = "skipped-v1-out-of-scope"
}

struct Report {
  var results: [ResultRow] = []

  mutating func add(_ row: ResultRow) {
    results.append(row)
  }

  func summary() -> [String: Int] {
    var counts: [String: Int] = [
      Status.pass: 0, Status.fail: 0, Status.skippedWithDocumentedLimitation: 0,
      Status.skippedV1OutOfScope: 0,
    ]
    for row in results {
      counts[row.status, default: 0] += 1
    }
    return counts
  }

  func toJSON() -> JSONValue {
    .object([
      "schemaVersion": 1,
      "generatedAt": "EXCLUDED",
      "results": .array(results.map { $0.toJSON() }),
      "summary": .object(summary().mapValues { JSONValue.number(Double($0)) }),
    ])
  }
}
