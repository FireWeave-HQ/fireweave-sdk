import Foundation

@testable import Fireweave

/// Test-only adapter whose `prefetch` can be delayed and/or made to fail —
/// used to exercise `FireweaveRuntime.refresh()`'s ceiling race
/// deterministically (`RuntimeConcurrencyTests`), without depending on real
/// network timing.
final class SlowFakeAdapter: ControlPointsBackendAdapter, @unchecked Sendable {
  private let lock = NSLock()
  private var delayNs: UInt64
  private var result: PrefetchResult
  private var shouldFail: FireweaveError?
  private(set) var prefetchCallCount = 0

  init(delayNs: UInt64, result: PrefetchResult = [:], shouldFail: FireweaveError? = nil) {
    self.delayNs = delayNs
    self.result = result
    self.shouldFail = shouldFail
  }

  let missReason: DecisionReason? = nil

  func initialize() async throws {}

  func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult
  {
    lock.withLock { prefetchCallCount += 1 }
    try await Task.sleep(nanoseconds: delayNs)
    if let shouldFail {
      throw shouldFail
    }
    return result
  }

  func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult
  {
    .success()
  }

  func shutdown() async {}

  func callCount() -> Int { lock.withLock { prefetchCallCount } }
}
