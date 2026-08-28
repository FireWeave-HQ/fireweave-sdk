import Foundation

/// Outcome of racing a prefetch against its ceiling (`FireweaveRuntime.refresh`).
enum PrefetchRaceOutcome: Sendable {
  case prefetched(PrefetchResult)
  case failed(FireweaveError)
  case timedOut
}

/// One-shot, thread-safe rendezvous between a prefetch task and a ceiling
/// timer — whichever settles first wins the race.
///
/// **Why not a `TaskGroup`.** A `TaskGroup`/`withThrowingTaskGroup` is
/// structured concurrency: when its body returns, Swift implicitly awaits
/// EVERY child task to completion first, cancellation or not (cancellation
/// is cooperative — it sets a flag, it does not force-terminate a task
/// blocked in `URLSession` I/O). Racing the prefetch and the ceiling as two
/// children of one group would therefore make `refresh()` block on the
/// SLOWER of the two, exactly backwards from the point of having a ceiling
/// at all: ADR-0009's "fail-open, not fail-silent" requires a hung backend
/// to NOT block boot. This gate instead races two plain, UNSTRUCTURED
/// `Task { }` values (never added to any group) — whichever loses keeps
/// running independently, and `wait()` returns the instant either one
/// settles, with no implicit wait on the loser. This mirrors `sdks/web`'s
/// `Promise.race` + `void prefetch.catch(() => undefined)`: the loser's
/// eventual result, if it's the prefetch, is simply discarded — no auto-heal
/// on a late win, matching the studied precedent exactly (the NEXT explicit
/// `refresh()`/`setContext()` call is what gets a fresh attempt).
final class PrefetchRaceGate: @unchecked Sendable {
  private let lock = NSLock()
  private var settled = false
  private var pendingOutcome: PrefetchRaceOutcome?
  private var continuation: CheckedContinuation<PrefetchRaceOutcome, Never>?

  /// Resolves the race with `outcome`. First caller wins; every
  /// subsequent call is a silent no-op (the loser's late result is
  /// discarded, per the type doc comment).
  func resolve(_ outcome: PrefetchRaceOutcome) {
    let waiting: CheckedContinuation<PrefetchRaceOutcome, Never>? = lock.withLock {
      guard !settled else { return nil }
      settled = true
      let waiting = continuation
      continuation = nil
      if waiting == nil { pendingOutcome = outcome }
      return waiting
    }
    waiting?.resume(returning: outcome)
  }

  /// Suspends until `resolve` is called (by whichever task gets there
  /// first). Safe to call before OR after `resolve` has already fired.
  func wait() async -> PrefetchRaceOutcome {
    let already: PrefetchRaceOutcome? = lock.withLock { pendingOutcome }
    if let already { return already }
    return await withCheckedContinuation { (k: CheckedContinuation<PrefetchRaceOutcome, Never>) in
      // This closure is SYNCHRONOUS (not async), so `lock.lock()`/
      // `unlock()` are unrestricted here even without `withLock` — see
      // `Locking.swift`'s doc comment for why that distinction matters.
      lock.lock()
      if let outcome = pendingOutcome {
        lock.unlock()
        k.resume(returning: outcome)
        return
      }
      continuation = k
      lock.unlock()
    }
  }
}
