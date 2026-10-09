import Foundation

extension NSLock {
  /// Runs `body` while holding the lock.
  ///
  /// A plain synchronous function, so it can be called from async code:
  /// Swift 6 marks `NSLock.lock()` `noasync`, because holding a blocking lock
  /// across a suspension point invites priority inversion. Nothing in this
  /// module ever awaits, logs or calls into the core while holding a lock.
  /// (The core's own `withLock` helper is internal to the core module.)
  func locked<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}

/// Runs async operations one at a time, in the order they were enqueued.
///
/// Identity changes on the app profile (`identify`, `reset`, `forget`) each
/// end in a re-prefetch, and the last call must win. A Swift `actor` cannot
/// promise that: actors are re-entrant across `await` (SE-0306), so two
/// operations would interleave. Each operation here waits for the one before
/// it to finish, and the tail is swapped under a lock, so the order is the
/// order the calls reached `enqueue`.
///
/// `@unchecked Sendable`: `tail` is the only mutable state and is guarded by
/// `lock`.
final class OperationChain: @unchecked Sendable {
  private let lock = NSLock()
  private var tail: Task<Void, Never>?

  func enqueue<T: Sendable>(
    _ operation: @escaping @Sendable () async -> T
  ) -> Task<T, Never> {
    lock.locked { () -> Task<T, Never> in
      let previous = tail
      let task = Task { () async -> T in
        if let previous {
          await previous.value
        }
        return await operation()
      }
      tail = Task {
        _ = await task.value
      }
      return task
    }
  }
}

/// A gate that opens once and releases every waiter, past and future.
///
/// `ready(timeout:)` races the start task against a timer through this
/// instead of a task group: a task group waits for all its children before
/// returning, and the start task cannot be cancelled.
///
/// `@unchecked Sendable`: `isOpen` and `waiters` are guarded by `lock`, and
/// continuations are resumed only after it is released.
final class OneShotGate: @unchecked Sendable {
  private let lock = NSLock()
  private var isOpen = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func open() {
    let released = lock.locked { () -> [CheckedContinuation<Void, Never>] in
      if isOpen { return [] }
      isOpen = true
      let all = waiters
      waiters = []
      return all
    }
    for waiter in released {
      waiter.resume()
    }
  }

  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let resumeNow = lock.locked { () -> Bool in
        if isOpen { return true }
        waiters.append(continuation)
        return false
      }
      if resumeNow {
        continuation.resume()
      }
    }
  }
}

/// `duration` in whole nanoseconds, clamped at zero.
func nanoseconds(of duration: Duration) -> UInt64 {
  let (seconds, attoseconds) = duration.components
  let total = Double(seconds) * 1e9 + Double(attoseconds) / 1e9
  if total <= 0 { return 0 }
  return UInt64(min(total, 1e18))
}
