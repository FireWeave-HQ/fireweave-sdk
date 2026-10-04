import 'dart:async';
import 'dart:math' as math;

import '../domain/context.dart';
import '../domain/decision.dart';
import '../domain/errors.dart';
import '../domain/types.dart';
import '../domain/validation.dart';
import 'ports.dart';

/// Ceiling on a prefetch so a hung backend cannot block boot
/// (`ADR-0009` "Fail-open, not fail-silent").
const int defaultFlagsReadyTimeoutMs = 5000;

/// Provider lifecycle state (`spec/modes.md`).
///
/// [uninitialized] and [initializing] share the SAME wire name
/// (`"NOT_READY"` — contracts never distinguish "never started" from
/// "starting up"); [wireName] is the explicit many-to-one mapping.
enum LifecycleState {
  uninitialized('NOT_READY'),
  initializing('NOT_READY'),
  ready('READY'),
  stale('STALE'),

  /// A transient, retriable failure reached from `refresh()`'s prefetch
  /// failing for a non-timeout reason (a real adapter-reported error, not a
  /// ceiling loss, which goes to [stale] instead). A later `refresh()` can
  /// recover from this.
  error('ERROR'),

  /// A non-recoverable-without-reconstruction boot failure:
  /// `adapter.initialize()` itself threw (`contracts/` wire name `"FATAL"`,
  /// distinct from [error] — `life-init-fail-configuration` pins exactly
  /// this distinction).
  fatal('FATAL'),
  shutdown('CLOSED');

  const LifecycleState(this.wireName);

  /// The provider-state name `contracts/` fixtures compare against.
  final String wireName;
}

/// Construction-time configuration for [FireweaveRuntime].
class RuntimeConfig {
  const RuntimeConfig({
    this.limits = defaultContextLimits,
    this.reservedAttributeKeys = const <String>{},
    this.requireTargetingKey = false,
    this.flagsReadyTimeoutMs = defaultFlagsReadyTimeoutMs,
    this.globalContext,
    this.flagKeys,
  });

  final ContextLimits limits;

  /// Extra reserved attribute keys, ON TOP OF the canonical
  /// [defaultReservedAttributeKeys] pair (`targetingKey`, `kind`).
  final Set<String> reservedAttributeKeys;
  final bool requireTargetingKey;
  final int flagsReadyTimeoutMs;
  final EvaluationContext? globalContext;

  /// Restrict prefetch to a known set of control points.
  final List<String>? flagKeys;
}

sealed class _RaceOutcome {
  const _RaceOutcome();
}

final class _Prefetched extends _RaceOutcome {
  const _Prefetched(this.result);
  final PrefetchResult result;
}

final class _Failed extends _RaceOutcome {
  const _Failed(this.error);
  final FireweaveError error;
}

final class _TimedOut extends _RaceOutcome {
  const _TimedOut();
}

/// [FireweaveRuntime]: shared engine behind `FireweaveClient`.
///
/// ## The sync/async seam ("web's shape, not node's")
///
/// [initialize]/[refresh] are `async` and populate the cache
/// ([setClientContext] itself is a plain synchronous setter — a caller who
/// wants the new context reflected in the cache calls [refresh] afterwards,
/// exactly like `FireweaveClient.identify` does); [evaluate] is a pure,
/// SYNCHRONOUS read of whatever the cache currently holds. That split is
/// what lets nine synchronous methods sit on top of an architecture that
/// talks to a real network backend, without a caller ever awaiting inside
/// `build()`.
///
/// ## Concurrency
///
/// Dart isolates are single-threaded: a synchronous [evaluate] can never
/// observe a half-applied cache, because the prefetch's result is applied
/// in one synchronous step after its `await` completes, and no other Dart
/// code runs in between. There is nothing to lock — the swift/go/rust
/// mutexes have no counterpart here, by construction rather than omission.
/// A prefetch in flight on the event loop and an [evaluate] from a widget's
/// `build()` interleave only at `await` boundaries the prefetch owns.
class FireweaveRuntime {
  FireweaveRuntime(
    this._adapter, {
    RuntimeConfig config = const RuntimeConfig(),
  }) : _limits = config.limits,
       _reservedAttributeKeys = config.reservedAttributeKeys,
       _requireTargetingKey = config.requireTargetingKey,
       _flagsReadyTimeoutMs = config.flagsReadyTimeoutMs,
       _flagKeys = config.flagKeys,
       _globalContext = config.globalContext;

  final ControlPointsBackendAdapter _adapter;
  final ContextLimits _limits;
  final Set<String> _reservedAttributeKeys;
  final bool _requireTargetingKey;
  final int _flagsReadyTimeoutMs;
  final List<String>? _flagKeys;

  LifecycleState _state = LifecycleState.uninitialized;
  PrefetchResult _cache = const <String, AdapterResolution>{};
  FireweaveError? _initError;
  EvaluationContext? _globalContext;
  EvaluationContext? _clientContext;

  /// The concrete adapter backing this runtime — the SANCTIONED path back
  /// to a mode-specific accessor (e.g. `FireweaveLocalAdapter
  /// .registeredTargets()`) via a checked `is` cast, reachable from the
  /// sanctioned entry point (`initFireweave` -> `client.runtime.backendAdapter`).
  ControlPointsBackendAdapter get backendAdapter => _adapter;

  LifecycleState get state => _state;

  /// The stored [LifecycleState.error]/[LifecycleState.fatal] cause, if any
  /// — lets a caller (the conformance runner's `initialize` operation, in
  /// particular) inspect WHY a boot failed without that reason ever having
  /// been thrown (`spec/control-points.md` "initialise is the exception"
  /// applies to `initFireweave`, not this runtime, which is deliberately
  /// fail-open — see [initialize]).
  FireweaveError? get initializationError => _initError;

  Set<String> get _allReservedKeys => <String>{
    ..._reservedAttributeKeys,
    ...defaultReservedAttributeKeys,
  };

  // ---------------------------------------------------------------- context

  void setClientContext(EvaluationContext? context) {
    _clientContext = context;
  }

  EvaluationContext _mergedContext(EvaluationContext? invocation) =>
      mergeContexts(<EvaluationContext?>[
        _globalContext,
        _clientContext,
        invocation,
      ]);

  // -------------------------------------------------------------- lifecycle

  /// Bring the adapter up and populate the cache. Never throws — a hung or
  /// failing prefetch must not block app boot (`ADR-0009` "Fail-open, not
  /// fail-silent"). The four Configuration rows that MUST fail loudly
  /// (`spec/modes.md`) are validated by `initFireweave` BEFORE this is ever
  /// called (`validateInitOptions` + `assertHostAllowed`, both synchronous)
  /// — by the time control reaches here, only genuinely transient failures
  /// remain, and those degrade to `error`/`stale`, never a throw.
  Future<void> initialize({EvaluationContext? context}) async {
    if (_state == LifecycleState.shutdown) {
      return;
    }
    _state = LifecycleState.initializing;
    if (context != null) {
      _globalContext = mergeContexts(<EvaluationContext?>[
        _globalContext,
        context,
      ]);
    }

    try {
      await _adapter.initialize();
    } on Object catch (error) {
      // adapter.initialize() itself failing is a BOOT failure, not a
      // transient one — `fatal`, distinct from refresh()'s prefetch
      // failures below (`error`). Pinned by `life-init-fail-configuration`.
      _initError = error is FireweaveError
          ? error
          : FireweaveError(ErrorKind.backendUnavailable, initFatal: true);
      _state = LifecycleState.fatal;
      return;
    }
    await refresh();
  }

  /// Re-run the prefetch against the current global+client context, racing
  /// it against the ceiling. Whichever settles first wins; the loser's
  /// eventual result is discarded (no auto-heal on a late win — the next
  /// explicit [refresh]/`identify()` gets a fresh attempt), mirroring
  /// `sdks/web`'s `Promise.race` and swift's `PrefetchRaceGate`.
  Future<void> refresh() async {
    if (_state == LifecycleState.shutdown) {
      return;
    }

    final merged = mergeContexts(<EvaluationContext?>[
      _globalContext,
      _clientContext,
    ]);
    if (validateContext(
          merged,
          limits: _limits,
          reservedKeys: _allReservedKeys,
          requireTargetingKey: false,
        )
        case Invalid()) {
      _state = LifecycleState.error;
      return;
    }

    final options = _flagKeys == null
        ? null
        : PrefetchOptions(flagKeys: _flagKeys);

    final completer = Completer<_RaceOutcome>();
    Timer? ceiling;
    void settle(_RaceOutcome outcome) {
      if (completer.isCompleted) {
        return;
      }
      ceiling?.cancel();
      completer.complete(outcome);
    }

    Future<PrefetchResult> prefetch;
    try {
      prefetch = _adapter.prefetch(merged, options: options);
    } on Object catch (error) {
      prefetch = Future<PrefetchResult>.error(error);
    }
    unawaited(
      prefetch.then(
        (result) => settle(_Prefetched(result)),
        onError: (Object error) => settle(
          _Failed(
            error is FireweaveError ? error : FireweaveError(ErrorKind.network),
          ),
        ),
      ),
    );
    ceiling = Timer(
      Duration(milliseconds: math.max(_flagsReadyTimeoutMs, 0)),
      () => settle(const _TimedOut()),
    );

    switch (await completer.future) {
      case _Prefetched(:final result):
        _cache = Map<String, AdapterResolution>.unmodifiable(result);
        _state = LifecycleState.ready;
        _initError = null;
      case _Failed(:final error):
        _state = LifecycleState.error;
        _initError = error;
      case _TimedOut():
        // Fail OPEN (boot continues) but not SILENT: reads will carry STALE
        // and the lifecycle state says so.
        _state = LifecycleState.stale;
    }
  }

  // --------------------------------------------- the synchronous read path

  /// Evaluate a flag. Never throws; failures return the default.
  ///
  /// Validates in the fixed order `spec/control-points.md` "Validation,
  /// before any I/O" names, stopping at the first failure: (1) key, (2)
  /// default vs type, (3) context, (4) lifecycle. Only once all four pass
  /// does this consult the cache — a pure, already-fetched read, never an
  /// adapter call.
  Decision evaluate(
    String key,
    FlagType type,
    JsonValue defaultValue, {
    EvaluationContext? context,
    EvaluateOptions? options,
  }) {
    if (validateControlPointKey(key) case Invalid(:final error)) {
      return _errorDecision(defaultValue, error);
    }
    if (validateDefaultValue(type, defaultValue) case Invalid(:final error)) {
      return _errorDecision(defaultValue, error);
    }

    final merged = _mergedContext(context);
    if (validateContext(
          merged,
          limits: _limits,
          reservedKeys: _allReservedKeys,
          requireTargetingKey: _requireTargetingKey,
        )
        case Invalid(:final error)) {
      return _errorDecision(defaultValue, error);
    }

    final lifecycleError = _lifecycleError();
    if (lifecycleError != null) {
      return _errorDecision(defaultValue, lifecycleError);
    }

    // Two DIFFERENT "no value" signals live here, and conflating them is a
    // real correctness hazard (see AdapterResolution's doc comment):
    //
    // 1. The key is PRESENT in the batch but `found == false` — the
    //    definition exists but its targeting conditions did not select this
    //    caller. ALWAYS `DEFAULT`, regardless of which adapter produced it.
    // 2. The key is ABSENT from the batch entirely — governed by
    //    `adapter.missReason`: local mode's unknown-key row is
    //    `default`/`DEFAULT` (`spec/modes.md`); every other adapter's absent
    //    key is `default`/`ERROR`/`FlagNotFound`.
    final resolution = _cache[key];
    if (resolution != null) {
      if (!resolution.found) {
        return Decision(
          value: defaultValue,
          reason: DecisionReason.defaultReason,
        );
      }
      return _decisionFromResolution(resolution, type, defaultValue, options);
    }

    if (_adapter.missReason == DecisionReason.defaultReason) {
      return Decision(
        value: defaultValue,
        reason: DecisionReason.defaultReason,
      );
    }
    // A cache miss while STALE is not a missing control point — it is an
    // unanswered question. Reporting FlagNotFound there would send a caller
    // hunting for a flag that may well exist.
    if (_state == LifecycleState.stale) {
      return Decision(
        value: defaultValue,
        variant: 'default',
        reason: DecisionReason.stale,
        flagMetadata: const <String, Object?>{'fireweave.stale': true},
      );
    }
    return _errorDecision(defaultValue, FireweaveError.flagNotFound());
  }

  Decision _decisionFromResolution(
    AdapterResolution resolution,
    FlagType type,
    JsonValue defaultValue,
    EvaluateOptions? options,
  ) {
    final value = resolution.value;
    if (!matchesExpectedType(value, type)) {
      return _errorDecision(
        defaultValue,
        FireweaveError(ErrorKind.typeMismatch),
      );
    }

    final metadata = <String, Object?>{};
    if (resolution.version != null) {
      metadata['fireweave.flagVersion'] = resolution.version;
    }
    // Detailed enrichment (ruling 11): emit both keys, or neither. The gate
    // itself is applied by the adapter that holds the raw "condition index"
    // signal (InMemoryAdapter); this is a pass-through of a pre-gated pair.
    final vendorFlagId = resolution.vendorFlagId;
    final reasonCode = resolution.reasonCode;
    if (vendorFlagId != null && reasonCode != null) {
      metadata['fireweave.vendorFlagId'] = vendorFlagId;
      metadata['fireweave.reasonCode'] = reasonCode;
    }
    if (resolution.fromCache) {
      metadata['fireweave.fromCache'] = true;
    }
    if (options?.includePayload == true && resolution.payload != null) {
      final payload = resolution.payload;
      metadata['fireweave.payload'] = payload is String
          ? payload
          : stableJsonString(payload);
    }

    final DecisionReason reason;
    if (resolution.enabled == false) {
      reason = DecisionReason.disabled;
    } else if (resolution.reason != null) {
      reason = resolution.reason!;
    } else if (resolution.fromCache || _state == LifecycleState.stale) {
      reason = DecisionReason.stale;
    } else {
      reason = DecisionReason.targetingMatch;
    }

    return Decision(
      value: value,
      variant: resolution.variant,
      reason: reason,
      flagMetadata: Map<String, Object?>.unmodifiable(metadata),
    );
  }

  // ---------------------------------------------------- target registration

  /// Register a target. Resolves rather than throwing — this runs in
  /// sign-in paths, where a targeting concern must not break authentication
  /// (`spec/modes.md` "registerTarget in local mode").
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async {
    final lifecycleError = _lifecycleError();
    if (lifecycleError != null) {
      return RegisterTargetResult.failure(lifecycleError);
    }
    try {
      return await _adapter.registerTarget(targetingKey, options: options);
    } on Object catch (error) {
      return RegisterTargetResult.failure(
        error is FireweaveError
            ? error
            : FireweaveError(ErrorKind.backendUnavailable),
      );
    }
  }

  /// Extension-call lifecycle gate (kept for `invokeCapability`, even
  /// though v1's supported-capabilities set is empty and never reaches it
  /// today — ruling 17, mirrored from rust/web/swift): READY/STALE pass
  /// (`null`); after shutdown the gate is `AlreadyClosed`; any pre-ready
  /// state degrades with `UnsupportedCapability`.
  FireweaveError? extensionLifecycleGate() {
    switch (_state) {
      case LifecycleState.ready:
      case LifecycleState.stale:
        return null;
      case LifecycleState.shutdown:
        return FireweaveError(ErrorKind.alreadyClosed);
      case LifecycleState.uninitialized:
      case LifecycleState.initializing:
      case LifecycleState.error:
      case LifecycleState.fatal:
        return FireweaveError(ErrorKind.unsupportedCapability);
    }
  }

  /// Test/fixture hook: pin the lifecycle state directly (used by the
  /// conformance runner's `given.providerState` provisioning, and by unit
  /// tests — mirrors rust/swift's `force_state`/`forceState`).
  void forceState(LifecycleState state) {
    _state = state;
  }

  /// Deterministic, idempotent shutdown; never throws.
  Future<void> shutdown() async {
    if (_state == LifecycleState.shutdown) {
      return;
    }
    try {
      await _adapter.shutdown();
    } on Object {
      // never throw from shutdown
    }
    _cache = const <String, AdapterResolution>{};
    _state = LifecycleState.shutdown;
  }

  // ---------------------------------------------------------------- helpers

  FireweaveError? _lifecycleError() {
    switch (_state) {
      case LifecycleState.ready:
      case LifecycleState.stale:
        return null;
      case LifecycleState.shutdown:
        return FireweaveError(ErrorKind.alreadyClosed);
      case LifecycleState.error:
      case LifecycleState.fatal:
        return _initError ?? FireweaveError(ErrorKind.backendUnavailable);
      case LifecycleState.uninitialized:
      case LifecycleState.initializing:
        return FireweaveError(ErrorKind.notReady);
    }
  }

  static Decision _errorDecision(JsonValue defaultValue, FireweaveError error) {
    final metadata = <String, Object?>{
      flagMetadataErrorKindKey: error.kind.wireName,
      if (error.kind == ErrorKind.flagNotFound && error.quotaLimited)
        'fireweave.quotaLimited': true,
    };
    return Decision(
      value: defaultValue,
      reason: DecisionReason.error,
      errorCode: error.openFeatureErrorCode,
      errorMessage: error.message,
      errorKind: error.kind,
      flagMetadata: Map<String, Object?>.unmodifiable(metadata),
    );
  }
}
