import 'types.dart';

/// Evaluation-context value type: merge order (global -> client ->
/// invocation) over the canonical attribute map.
///
/// Bounds are enforced in `validateContext` (`spec/control-points.md`
/// "Validation, before any I/O" rule 3).
///
/// [attributes] is an unmodifiable copy of what the caller passed, so
/// evaluation can never mutate a caller's map (`ctx-immutability`). The copy
/// is shallow: nested maps/lists are the caller's own objects, which the SDK
/// only ever reads.
class EvaluationContext {
  EvaluationContext({this.targetingKey, Map<String, Object?>? attributes})
    : attributes = Map<String, Object?>.unmodifiable(
        attributes ?? const <String, Object?>{},
      );

  final String? targetingKey;
  final Map<String, Object?> attributes;

  EvaluationContext withTargetingKey(String key) =>
      EvaluationContext(targetingKey: key, attributes: attributes);

  EvaluationContext withAttribute(String key, Object? value) =>
      EvaluationContext(
        targetingKey: targetingKey,
        attributes: <String, Object?>{...attributes, key: value},
      );

  /// `$`-prefixed attributes: vendor pass-through options.
  Map<String, Object?> get vendorHints => <String, Object?>{
    for (final entry in attributes.entries)
      if (entry.key.startsWith(r'$')) entry.key: entry.value,
  };

  /// Attributes minus vendor hints (`$`-prefixed keys).
  Map<String, Object?> get plainAttributes => <String, Object?>{
    for (final entry in attributes.entries)
      if (!entry.key.startsWith(r'$')) entry.key: entry.value,
  };

  /// Group memberships from `fireweave.groups` or the plain `groups` alias.
  Map<String, Object?>? get groups =>
      _objectAt('fireweave.groups') ?? _objectAt('groups');

  /// Group properties from `fireweave.groupProperties` or the plain
  /// `groupProperties` alias.
  Map<String, Object?>? get groupProperties =>
      _objectAt('fireweave.groupProperties') ?? _objectAt('groupProperties');

  Map<String, Object?>? _objectAt(String key) {
    final value = attributes[key];
    if (value is Map) {
      return <String, Object?>{
        for (final entry in value.entries) entry.key.toString(): entry.value,
      };
    }
    return null;
  }

  /// Plain-JSON snapshot (`{targetingKey?, attributes?}`), matching the
  /// shape conformance fixtures compare against.
  Map<String, Object?> toJson() => <String, Object?>{
    if (targetingKey != null) 'targetingKey': targetingKey,
    if (attributes.isNotEmpty) 'attributes': attributes,
  };

  @override
  bool operator ==(Object other) =>
      other is EvaluationContext &&
      other.targetingKey == targetingKey &&
      jsonEquals(other.attributes, attributes);

  @override
  int get hashCode => Object.hash(targetingKey, attributes.length);

  @override
  String toString() =>
      'EvaluationContext(targetingKey=$targetingKey attributes=$attributes)';
}

/// Sanctioned `fireweave.*` carriers (`spec/evaluation-context.schema.json`):
/// the ONLY `fireweave.*` context keys callers may set. Canonical spelling
/// for group memberships / group properties; plain `groups`/`groupProperties`
/// remain accepted as a documented alias.
const Set<String> allowedFireweaveContextKeys = <String>{
  'fireweave.groups',
  'fireweave.groupProperties',
};

/// Attribute keys reserved at the evaluation-context boundary
/// (`spec/evaluation-context.schema.json` `reservedKeys`, restricted here to
/// the attribute-level pair `validateContext` checks; `targetingKey` itself
/// is a top-level field, never an attribute key).
const Set<String> defaultReservedAttributeKeys = <String>{
  'targetingKey',
  'kind',
};

/// Context bounds (`spec/evaluation-context.schema.json`).
class ContextLimits {
  const ContextLimits({
    required this.maxAttributeCount,
    required this.maxKeyBytes,
    required this.maxValueBytes,
    required this.maxNestingDepth,
    required this.maxSerializedBytes,
  });

  final int maxAttributeCount;
  final int maxKeyBytes;
  final int maxValueBytes;
  final int maxNestingDepth;
  final int maxSerializedBytes;

  ContextLimits copyWith({
    int? maxAttributeCount,
    int? maxKeyBytes,
    int? maxValueBytes,
    int? maxNestingDepth,
    int? maxSerializedBytes,
  }) => ContextLimits(
    maxAttributeCount: maxAttributeCount ?? this.maxAttributeCount,
    maxKeyBytes: maxKeyBytes ?? this.maxKeyBytes,
    maxValueBytes: maxValueBytes ?? this.maxValueBytes,
    maxNestingDepth: maxNestingDepth ?? this.maxNestingDepth,
    maxSerializedBytes: maxSerializedBytes ?? this.maxSerializedBytes,
  );
}

/// Ratified default bounds (`contracts/README.md` "Ratified context limits").
const ContextLimits defaultContextLimits = ContextLimits(
  maxAttributeCount: 128,
  maxKeyBytes: 256,
  maxValueBytes: 4096,
  maxNestingDepth: 6,
  maxSerializedBytes: 65536,
);

/// Merges context layers; later layers win per attribute key.
///
/// Order: global -> client -> invocation (`spec/control-points.md`
/// "Context"). `targetingKey` from the latest layer that sets one wins.
/// Merge is shallow per top-level attribute key. `null` layers are skipped.
EvaluationContext mergeContexts(Iterable<EvaluationContext?> layers) {
  String? targetingKey;
  final attributes = <String, Object?>{};
  for (final layer in layers) {
    if (layer == null) {
      continue;
    }
    if (layer.targetingKey != null) {
      targetingKey = layer.targetingKey;
    }
    attributes.addAll(layer.attributes);
  }
  return EvaluationContext(targetingKey: targetingKey, attributes: attributes);
}
