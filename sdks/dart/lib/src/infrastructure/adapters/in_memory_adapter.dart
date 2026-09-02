import '../../application/ports.dart';
import '../../domain/context.dart';
import '../../domain/decision.dart';
import '../../domain/errors.dart';
import '../../domain/types.dart';

/// One flag definition, as loaded from a fixture or constructed directly.
class FlagDefinition {
  const FlagDefinition({
    this.enabled = true,
    this.variant,
    this.value,
    this.payload,
    this.reasonCode,
    this.conditionIndex,
    this.version,
    this.vendorFlagId,
    this.fireweaveReason,
    this.fromCache = false,
    this.matchTargetingKey,
    this.matchAttribute,
    this.matchGroups,
    this.matchPerson,
  });

  /// Builds a definition from the raw fixture JSON shape
  /// (`given.flags: {key: {...}}`, `contracts/README.md`).
  factory FlagDefinition.fromJson(Object? json) {
    final obj = json is Map ? json : const <Object?, Object?>{};
    final reason = obj['reason'];
    final reasonMap = reason is Map ? reason : const <Object?, Object?>{};
    final metadata = obj['metadata'];
    final metadataMap = metadata is Map ? metadata : const <Object?, Object?>{};
    final enabled = obj['enabled'];
    final variant = obj['variant'];
    final reasonCode = reasonMap['code'];
    final conditionIndex = reasonMap['condition_index'];
    final version = metadataMap['version'];
    final vendorFlagId = metadataMap['id'];
    final fireweaveReason = obj['fireweaveReason'];
    final matchTargetingKey = obj['matchTargetingKey'];
    return FlagDefinition(
      enabled: enabled is bool ? enabled : true,
      variant: variant is String ? variant : null,
      value: obj['value'],
      payload: obj['payload'],
      reasonCode: reasonCode is String ? reasonCode : null,
      conditionIndex: conditionIndex is num ? conditionIndex.toInt() : null,
      version: version is num ? version.toInt() : null,
      vendorFlagId: vendorFlagId is num ? vendorFlagId.toInt() : null,
      fireweaveReason: fireweaveReason is String
          ? DecisionReason.fromWireName(fireweaveReason)
          : null,
      fromCache: obj['fromCache'] == true,
      matchTargetingKey: matchTargetingKey is String ? matchTargetingKey : null,
      matchAttribute: _objectOrNull(obj['matchAttribute']),
      matchGroups: _objectOrNull(obj['matchGroups']),
      matchPerson: _objectOrNull(obj['matchPerson']),
    );
  }

  final bool enabled;
  final String? variant;
  final JsonValue value;
  final JsonValue payload;
  final String? reasonCode;
  final int? conditionIndex;
  final int? version;
  final int? vendorFlagId;
  final DecisionReason? fireweaveReason;
  final bool fromCache;
  final String? matchTargetingKey;
  final Map<String, Object?>? matchAttribute;
  final Map<String, Object?>? matchGroups;
  final Map<String, Object?>? matchPerson;

  static Map<String, Object?>? _objectOrNull(Object? value) {
    if (value is! Map) {
      return null;
    }
    return <String, Object?>{
      for (final entry in value.entries) entry.key.toString(): entry.value,
    };
  }
}

/// A fault to raise on every [InMemoryAdapter.prefetch] call —
/// protocol-fault fixtures (`contracts/security/*.json`) that declare a
/// fault but run on the in-memory backend (mirrors node/go/java/rust/swift's
/// built-in `InMemoryFault`). Faults at PREFETCH time, not at per-call read
/// time — the one place this architecture's adapter does I/O at all.
class InMemoryFault {
  const InMemoryFault(this.kind);

  final ErrorKind kind;
}

/// Deterministic in-memory adapter for tests and conformance fixtures.
///
/// Resolution is purely definition-driven — no hashing, no percentage
/// bucketing. A flag definition is shaped like `contracts/README.md`'s
/// fixture `given.flags.<key>` entries.
///
/// `matchPerson` is intentionally identical to `matchAttribute` (both
/// deep-equality-check plain context attributes) — this mirrors node/go/
/// rust/swift's `InMemoryAdapter`, which implement the two conditions with
/// the same equality check under two names for descriptive fixture
/// authoring (`contracts/context/ctx-person-and-groups.json`).
///
/// **Conditions are matched against the context available AT PREFETCH
/// time** (global + client layers), never per-call invocation context —
/// this is the architectural line a synchronous read surface draws: a
/// synchronous `evaluate()` never touches this adapter, so a caller's
/// invocation-only attributes cannot retroactively change which cached
/// decision is served. This is exactly why the six context-suite fixtures
/// whose matching is invocation-context-driven are
/// `skipped-with-documented-limitation` in the conformance runner rather
/// than run for real — see `conformance/runner.dart`.
class InMemoryAdapter implements ControlPointsBackendAdapter {
  InMemoryAdapter([
    Map<String, FlagDefinition> definitions = const <String, FlagDefinition>{},
  ]) : _definitions = Map<String, FlagDefinition>.of(definitions);

  /// Builds an adapter from the raw fixture JSON shape
  /// (`given.flags: {key: {...}}`).
  factory InMemoryAdapter.fromFlagsJson(Map<String, Object?> flagsJson) =>
      InMemoryAdapter(<String, FlagDefinition>{
        for (final entry in flagsJson.entries)
          entry.key: FlagDefinition.fromJson(entry.value),
      });

  Map<String, FlagDefinition> _definitions;
  InMemoryFault? _fault;
  bool _closed = false;

  @override
  DecisionReason? get missReason => null;

  void setFlags(Map<String, FlagDefinition> definitions) {
    _definitions = Map<String, FlagDefinition>.of(definitions);
  }

  /// Every [prefetch] call raises this fault instead of resolving
  /// (protocol-fault fixtures exercised on the in-memory backend).
  void setFault(InMemoryFault? fault) {
    _fault = fault;
  }

  bool get isClosed => _closed;

  static bool _conditionsMatch(
    FlagDefinition definition,
    EvaluationContext context,
  ) {
    final expectedKey = definition.matchTargetingKey;
    if (expectedKey != null && context.targetingKey != expectedKey) {
      return false;
    }
    final matchAttribute = definition.matchAttribute;
    if (matchAttribute != null) {
      for (final entry in matchAttribute.entries) {
        if (!jsonEquals(context.attributes[entry.key], entry.value)) {
          return false;
        }
      }
    }
    final matchPerson = definition.matchPerson;
    if (matchPerson != null) {
      for (final entry in matchPerson.entries) {
        if (!jsonEquals(context.attributes[entry.key], entry.value)) {
          return false;
        }
      }
    }
    final matchGroups = definition.matchGroups;
    if (matchGroups != null) {
      final groups = context.groups;
      for (final entry in matchGroups.entries) {
        if (!jsonEquals(groups?[entry.key], entry.value)) {
          return false;
        }
      }
    }
    return true;
  }

  @override
  Future<void> initialize() async {
    _closed = false;
  }

  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) async {
    final fault = _fault;
    if (fault != null) {
      throw FireweaveError(fault.kind);
    }

    final result = <String, AdapterResolution>{};
    for (final entry in _definitions.entries) {
      final definition = entry.value;
      final matched = _conditionsMatch(definition, context);
      // Ruling 11 gate (spec/decision.schema.json standardMetadataKeys):
      // fireweave.vendorFlagId + fireweave.reasonCode are emitted only when
      // the fixture reports a vendor flag id, a matched-condition index, AND
      // a reason code together — this adapter is the one place that raw
      // "condition index" signal exists, so it applies the gate itself
      // before constructing the AdapterResolution the (adapter-agnostic)
      // runtime reads.
      int? vendorFlagId;
      String? reasonCode;
      if (definition.vendorFlagId != null &&
          definition.conditionIndex != null &&
          definition.reasonCode != null) {
        vendorFlagId = definition.vendorFlagId;
        reasonCode = definition.reasonCode;
      }
      result[entry.key] = AdapterResolution(
        found: matched,
        enabled: definition.enabled,
        value: definition.value,
        variant: definition.variant,
        reason: definition.fireweaveReason,
        reasonCode: reasonCode,
        version: definition.version,
        vendorFlagId: vendorFlagId,
        payload: definition.payload,
        fromCache: definition.fromCache,
      );
    }
    return result;
  }

  /// No registration capability — the in-memory adapter degrades via the
  /// port's default-shaped failure (mirrors go/rust/swift's fixture
  /// adapter).
  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async => RegisterTargetResult.failure(
    FireweaveError(ErrorKind.unsupportedCapability),
  );

  @override
  Future<void> shutdown() async {
    _closed = true;
  }
}
