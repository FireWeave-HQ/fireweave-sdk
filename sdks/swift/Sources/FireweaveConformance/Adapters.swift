import Fireweave
import Foundation

/// Wraps an adapter so every `prefetch()` throws a fixed error —
/// `contracts/security`/`faults` fixtures that declare a protocol fault but
/// run on the in-memory backend (mirrors node/go/java/python/rust's
/// `_FaultyAdapter`/`FaultyAdapter`). Faults at PREFETCH time, the one place
/// this architecture's adapter does I/O — see `Ports.swift`'s doc comment.
final class FaultyAdapter: ControlPointsBackendAdapter, @unchecked Sendable {
  private let inner: any ControlPointsBackendAdapter
  private let error: FireweaveError

  init(inner: any ControlPointsBackendAdapter, error: FireweaveError) {
    self.inner = inner
    self.error = error
  }

  var missReason: DecisionReason? { inner.missReason }
  func initialize() async throws { try await inner.initialize() }
  func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult
  {
    throw error
  }
  func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult
  {
    await inner.registerTarget(targetingKey: targetingKey, options: options)
  }
  func shutdown() async { await inner.shutdown() }
}

/// Wraps an adapter, counting `prefetch()` calls
/// (`expect.networkCalls` fixtures: `sec-deep-nesting-reject`,
/// `sec-oversized-reject` — both assert that a REJECTED evaluate() causes no
/// network activity, which this architecture already guarantees structurally
/// since `evaluate()` never touches the adapter at all; this wrapper counts
/// prefetch calls made strictly AFTER construction, i.e. relative to a
/// snapshot taken right before the assertion, so it measures "did evaluate()
/// itself cause a prefetch" rather than the one legitimate prefetch made
/// during initialize()).
final class CountingAdapter: ControlPointsBackendAdapter, @unchecked Sendable {
  private let inner: any ControlPointsBackendAdapter
  private let counter = Counter()

  init(inner: any ControlPointsBackendAdapter) {
    self.inner = inner
  }

  var missReason: DecisionReason? { inner.missReason }
  func initialize() async throws { try await inner.initialize() }
  func prefetch(context: EvaluationContext, options: PrefetchOptions?) async throws
    -> PrefetchResult
  {
    counter.increment()
    return try await inner.prefetch(context: context, options: options)
  }
  func registerTarget(targetingKey: String, options: RegisterTargetOptions?) async
    -> RegisterTargetResult
  {
    await inner.registerTarget(targetingKey: targetingKey, options: options)
  }
  func shutdown() async { await inner.shutdown() }

  func resetCount() { counter.reset() }
  func count() -> Int { counter.value() }
}

// Plain synchronous methods (never called from inside an `async` function
// body directly), so raw `lock()`/`unlock()` needs no wrapper here — this
// type's own `Fireweave.NSLock.withLock` equivalent is `internal` to that
// module and not visible across the target boundary, which is fine: the
// restriction it works around only matters lexically inside `async` code.
private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func increment() {
    lock.lock()
    n += 1
    lock.unlock()
  }
  func reset() {
    lock.lock()
    n = 0
    lock.unlock()
  }
  func value() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return n
  }
}
