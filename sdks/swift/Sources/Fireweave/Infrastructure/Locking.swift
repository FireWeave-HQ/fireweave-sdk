import Foundation

extension NSLock {
  /// Executes `body` while holding this lock.
  ///
  /// Swift 6's SDK marks `NSLock.lock()`/`unlock()` `@available(*,
  /// noasync)` — calling either directly inside the body of an `async`
  /// function is a compile error, because holding a blocking lock across
  /// a suspension point is a priority-inversion hazard. Every lock-holding
  /// type in this package (`ControlPointsCacheBox`, `ContextBox`,
  /// `PrefetchRaceGate`, the adapters) is called from BOTH sync
  /// (`evaluate()`) and async (`initialize()`/`refresh()`/`prefetch()`)
  /// contexts, so every critical section goes through this helper — a
  /// plain, SYNCHRONOUS function — rather than raw `lock()`/`unlock()`
  /// calls. The restriction is about the LEXICAL context of the `.lock()`
  /// call site, not about who dynamically invokes the wrapper, so calling
  /// `someLock.withLock { ... }` from inside an `async func` is fine: by
  /// the time `.lock()` actually executes, it is lexically inside this
  /// synchronous closure-body, not inside the caller's `async` one. Every
  /// critical section in this package is a handful of pointer copies —
  /// never I/O, never a re-entrant call — so holding the lock for the
  /// duration of `body` is always safe and brief (see
  /// `ControlPointsCacheBox`'s doc comment for why that matters for the
  /// concurrency-safety story specifically).
  @inline(__always)
  func withLock<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}
