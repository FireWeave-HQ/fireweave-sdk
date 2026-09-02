import '../../application/ports.dart';
import '../../domain/context.dart';
import '../../domain/decision.dart';
import '../../domain/target.dart';
import '../../domain/types.dart';

/// A target recorded by [FireweaveLocalAdapter.registerTarget].
class LocalRegisteredTarget {
  const LocalRegisteredTarget({
    required this.targetingKey,
    required this.kind,
    required this.properties,
    this.environment,
  });

  final String targetingKey;
  final TargetKind kind;
  final Map<String, Object?> properties;
  final String? environment;
}

// `print` is the one sink that reaches the Flutter console on every
// platform (a device's stderr does not). The spec's own reason for the trace
// is that a `[fireweave:local]` line in a production log is the signal that
// something booted in local mode by mistake — so it must go where logs go.
// ignore: avoid_print
void _defaultLogSink(String message) => print(message);

/// [FireweaveLocalAdapter] — the DEV substrate for a scaffolded harness.
///
/// Counterpart to `FireweaveRemoteAdapter`: prod evaluates control points
/// against fw-server; dev evaluates them here, in-process, with no network
/// and no credentials. Because it satisfies the same
/// [ControlPointsBackendAdapter] port, the dev branch of a harness runs
/// through the same `FireweaveRuntime` as prod.
///
/// Resolution policy is deliberately minimal (matches node/go/rust/swift's
/// own dev adapters):
///
/// - a key present in the seeded map resolves to its mapped value with
///   reason `STATIC` — the only supported way to turn a control point ON
///   (or force it OFF) on a laptop;
/// - every other key MISSES, which `FireweaveRuntime` turns into the
///   caller's own default with reason `DEFAULT` — not an error
///   (`spec/modes.md` "Behaviour per mode": local's unknown-key row is
///   deliberately `default`/`DEFAULT`, unlike remote's
///   `default`/`ERROR`/`FlagNotFound`).
class FireweaveLocalAdapter implements ControlPointsBackendAdapter {
  FireweaveLocalAdapter({
    Map<String, bool> devFlags = const <String, bool>{},
    LogSink? log,
  }) : _devFlags = Map<String, bool>.unmodifiable(devFlags),
       _log = log ?? _defaultLogSink;

  final Map<String, bool> _devFlags;
  final LogSink _log;
  final Map<String, LocalRegisteredTarget> _targets =
      <String, LocalRegisteredTarget>{};
  bool _closed = false;

  @override
  DecisionReason? get missReason => DecisionReason.defaultReason;

  /// Targets recorded this process, for assertions and dev inspection
  /// (`spec/modes.md`: "The recorded set MUST be readable ... so tests can
  /// assert registration without capturing stdout"). Reachable from the
  /// sanctioned entry point via
  /// `client.runtime.backendAdapter is FireweaveLocalAdapter`.
  List<LocalRegisteredTarget> registeredTargets() =>
      List<LocalRegisteredTarget>.unmodifiable(_targets.values);

  bool get isClosed => _closed;

  @override
  Future<void> initialize() async {
    _closed = false;
  }

  /// Every seeded key resolves to its boolean override, reason `STATIC` —
  /// no context-based matching in local mode (the override map is a flat
  /// `Map<String, bool>`, matching node/go/rust/swift's own dev-mode
  /// adapter, which likewise ignores context entirely).
  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) async {
    return <String, AdapterResolution>{
      for (final entry in _devFlags.entries)
        entry.key: AdapterResolution(
          found: true,
          enabled: true,
          value: entry.value,
          variant: entry.value ? 'on' : 'off',
          flagType: FlagType.boolean,
          reason: DecisionReason.staticReason,
        ),
    };
  }

  /// Records the target in-process and traces it, rather than reporting
  /// `UnsupportedCapability` (`spec/modes.md` "registerTarget in local
  /// mode").
  ///
  /// The failure being guarded against is a developer believing their
  /// targeting works because nothing objected. A recorded target plus an
  /// explicit `[fireweave:local]` line preserves that guarantee: nothing is
  /// silent, and local dev can exercise targeting rules offline instead of
  /// only in production. No network call is made and nothing reaches
  /// fw-server.
  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async {
    final kind = options?.kind ?? TargetKind.defaultKind;
    final properties = Map<String, Object?>.unmodifiable(
      options?.properties ?? const <String, Object?>{},
    );
    final environment = options?.environment;

    _targets[targetingKey] = LocalRegisteredTarget(
      targetingKey: targetingKey,
      kind: kind,
      properties: properties,
      environment: environment,
    );

    final propertiesJson = stableJsonString(properties);
    _log(
      '[fireweave:local] registerTarget ${kind.wireName} $targetingKey '
      '$propertiesJson — recorded in-process, NOT sent to fw-server',
    );

    return const RegisterTargetResult.success();
  }

  @override
  Future<void> shutdown() async {
    _closed = true;
  }
}
