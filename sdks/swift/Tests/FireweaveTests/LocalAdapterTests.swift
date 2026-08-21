import Foundation
import Testing

@testable import Fireweave

@Suite("FireweaveLocalAdapter")
struct LocalAdapterTests {
  @Test func seededFlagResolvesStatic() async throws {
    let adapter = FireweaveLocalAdapter(devFlags: ["on-flag": true])
    let result = try await adapter.prefetch(context: EvaluationContext(), options: nil)
    let resolution = try #require(result["on-flag"])
    #expect(resolution.found)
    #expect(resolution.value == .bool(true))
    #expect(resolution.reason == .staticReason)
  }

  @Test func unseededFlagIsAbsentFromTheBatch() async throws {
    let adapter = FireweaveLocalAdapter(devFlags: [:])
    let result = try await adapter.prefetch(context: EvaluationContext(), options: nil)
    #expect(result["absent"] == nil)
  }

  @Test func registerTargetRecordsAndTraces() async {
    let traced = Traced()
    let adapter = FireweaveLocalAdapter(devFlags: [:], log: { traced.append($0) })
    let result = await adapter.registerTarget(targetingKey: "user-1", options: nil)
    #expect(result.ok)
    #expect(adapter.registeredTargets().count == 1)
    let lines = traced.lines()
    #expect(lines.count == 1)
    #expect(lines[0].hasPrefix("[fireweave:local]"))
    #expect(lines[0].contains("NOT sent to fw-server"))
  }

  private final class Traced: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []
    func append(_ line: String) { lock.withLock { storage.append(line) } }
    func lines() -> [String] { lock.withLock { storage } }
  }
}
