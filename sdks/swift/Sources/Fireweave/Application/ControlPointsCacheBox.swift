import Foundation

/// Provider lifecycle state (`spec/modes.md`).
///
/// Not a `String`-backed `RawRepresentable` enum: `.uninitialized` and
/// `.initializing` share the SAME wire name (`"NOT_READY"` — contracts never
/// distinguish "never started" from "starting up"), which a raw-value enum
/// cannot express (Swift requires unique raw values per case). `wireName`
/// below is the explicit many-to-one mapping instead, mirroring rust's
/// `LifecycleState::wire_name()` match function.
public enum LifecycleState: Sendable, Equatable {
  case uninitialized
  case initializing
  case ready
  case stale
  /// A transient, retriable failure reached from `refresh()`'s prefetch
  /// failing for a non-timeout reason (a real adapter-reported error, not
  /// a ceiling loss, which goes to `.stale` instead) BEFORE any prefetch has
  /// succeeded. A failure after an earlier success goes to `.stale` and
  /// keeps the last good decisions instead. A later `refresh()` can recover
  /// from this.
  case error
  /// A non-recoverable-without-reconstruction boot failure: `adapter
  /// .initialize()` itself threw (`contracts/` wire name `"FATAL"`,
  /// distinct from `.error` — `life-init-fail-configuration` pins exactly
  /// this distinction). Mirrors rust's `LifecycleState::Fatal`.
  case fatal
  case shutdown

  /// The provider-state name `contracts/` fixtures compare against.
  public var wireName: String {
    switch self {
    case .uninitialized, .initializing: return "NOT_READY"
    case .ready: return "READY"
    case .stale: return "STALE"
    case .error: return "ERROR"
    case .fatal: return "FATAL"
    case .shutdown: return "CLOSED"
    }
  }
}

/// The synchronous read path's entire concurrency story
/// (`FireweaveRuntime.evaluate`).
///
/// A plain `final class` guarded by a single `NSLock`, NOT an `actor`.
/// Swift's `actor` type gives mutual exclusion but every access from OUTSIDE
/// the actor's own isolation domain is `async` — exactly the property the
/// controller ruling forbids ("No `@MainActor`-only APIs on the read
/// surface" / "the nine methods" must stay synchronous). An `NSLock`-guarded
/// class gives the same mutual exclusion with a genuinely SYNCHRONOUS,
/// callable-from-anywhere read: `evaluate()` takes one `snapshot()` (a
/// single lock/unlock pair, no I/O ever happens while the lock is held) and
/// then does all further work — validation, cache lookup, `Decision`
/// construction — as pure, already-unlocked computation.
///
/// **Why this cannot deadlock a render path.** The lock's only critical
/// sections are `snapshot()` (copy two small values out) and `apply`/
/// `setState` (write two small values in) — never a network call, never a
/// re-entrant call back into this class, never an `await`. A read from the
/// main actor and a concurrent `apply()` from a background prefetch `Task`
/// can only ever contend for a few nanoseconds of pointer-copy work; neither
/// side can be blocked waiting on the OTHER side's I/O, because neither
/// side's critical section contains any. This is the same guarantee
/// `Mutex`/`RwLock`-guarded state gives the other server SDKs (go/java/
/// rust) — swift's read surface additionally requires that guarantee to
/// hold from the MAIN ACTOR specifically, which a plain lock (not an actor,
/// not `@MainActor`) satisfies by construction: it has no actor affinity, so
/// calling into it never hops executors and never awaits.
final class ControlPointsCacheBox: @unchecked Sendable {
  private let lock = NSLock()
  private var state: LifecycleState = .uninitialized
  private var cache: PrefetchResult = [:]
  private var initError: FireweaveError?
  private var refreshError: FireweaveError?
  /// At least one prefetch succeeded: from then on `cache` holds the last
  /// good decisions, and a failed re-fetch keeps them
  /// (`spec/control-points.md` "A failed re-fetch keeps the last good
  /// decisions").
  private var hasLastGood = false

  /// Consistent (state, cache) pair as of one instant — never two separate
  /// lock acquisitions, which could observe a torn update.
  func snapshot() -> (state: LifecycleState, cache: PrefetchResult, initError: FireweaveError?) {
    lock.withLock { (state, cache, initError) }
  }

  func currentState() -> LifecycleState {
    lock.withLock { state }
  }

  /// The error of the most recent prefetch when it failed; nil once one
  /// succeeds. A ceiling loss leaves it as it was.
  func lastRefreshError() -> FireweaveError? {
    lock.withLock { refreshError }
  }

  func setState(_ newState: LifecycleState) {
    lock.withLock { state = newState }
  }

  /// Successful prefetch: replace the cache and enter `.ready`. Discarded
  /// after shutdown: closed stays closed.
  func apply(_ newCache: PrefetchResult) {
    lock.withLock {
      guard state != .shutdown else { return }
      cache = newCache
      state = .ready
      initError = nil
      refreshError = nil
      hasLastGood = true
    }
  }

  /// A prefetch failure (real error, not a ceiling timeout). With no
  /// earlier success: enter `.error`, remembering why, so reads serve their
  /// defaults. After one: keep the last good decisions and enter `.stale`,
  /// so reads serve them with reason `STALE` instead of every read falling
  /// back to its default on one 429, 5xx or network blip. Either way a
  /// later `refresh()` can recover. Discarded after shutdown.
  func fail(_ error: FireweaveError) {
    lock.withLock {
      guard state != .shutdown else { return }
      refreshError = error
      if hasLastGood {
        state = .stale
      } else {
        state = .error
        initError = error
      }
    }
  }

  /// The prefetch lost the race against its ceiling: `.stale`, keeping
  /// whatever the cache holds (the last good decisions, or nothing).
  /// Discarded after shutdown.
  func timeOut() {
    lock.withLock {
      guard state != .shutdown else { return }
      state = .stale
    }
  }

  /// `adapter.initialize()` itself failed: enter `.fatal` — a boot
  /// failure, not a transient one (see `LifecycleState.fatal`'s doc
  /// comment).
  func failFatal(_ error: FireweaveError) {
    lock.withLock {
      state = .fatal
      initError = error
    }
  }

  /// Test/fixture hook: force a specific state directly (mirrors rust's
  /// `force_state`/`mark_stale` conformance hooks — `given.providerState`
  /// fixtures need to pin a state without a real prefetch happening).
  func forceState(_ newState: LifecycleState) {
    lock.withLock { state = newState }
  }

  func clear() {
    lock.withLock {
      cache = [:]
      state = .shutdown
    }
  }
}
