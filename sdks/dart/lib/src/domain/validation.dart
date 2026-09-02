/// Fireweave SDK validation — pure, total functions per
/// `spec/control-points.md` "Validation, before any I/O" and
/// `spec/modes.md` "Initialisation validation".
///
/// Every function below is pure (no I/O, no ambient state, no environment
/// reads) and total — the conformance runner can exercise all of these
/// offline, with no backend. `FireweaveRuntime.evaluate` runs the read-path
/// ones (key, default-vs-type, context) in the fixed order
/// `spec/control-points.md` names, stopping at the first failure, THEN
/// checks lifecycle (a runtime-state concern, not a pure function — it lives
/// on `FireweaveRuntime`, not here) before ever consulting the cache. Only
/// `validateInitOptions`'s failure is surfaced as a throw, by
/// `initFireweave`; every other validator's failure here is converted into a
/// default-valued `Decision` before it ever reaches a caller.
library;

import 'context.dart';
import 'errors.dart';
import 'mode.dart';
import 'types.dart';

/// Result of a pure validator: [Valid] or [Invalid] naming the
/// [FireweaveError] a caller should degrade to. Returning rather than
/// throwing is what makes "degrade to the caller's default" a type instead
/// of a convention.
sealed class Validated {
  const Validated();

  bool get isValid;

  /// The error, when [isValid] is false.
  FireweaveError? get error;
}

final class Valid extends Validated {
  const Valid();

  @override
  bool get isValid => true;

  @override
  FireweaveError? get error => null;
}

final class Invalid extends Validated {
  const Invalid(this.error);

  @override
  final FireweaveError error;

  @override
  bool get isValid => false;
}

// ---------------------------------------------------------------------------
// Rule 1 — validateControlPointKey

const int _maxControlPointKeyLength = 256;

bool _hasControlCharacters(String key) =>
    key.runes.any((rune) => rune <= 0x1F || (rune >= 0x7F && rune <= 0x9F));

/// key — non-empty, <=256 characters, no control characters
/// (`spec/control-points.md` rule 1, the first check in the fixed order).
///
/// No taxonomy kind names "malformed key" explicitly (the return-discipline
/// table's closest row is "key unknown to the backend" -> `FlagNotFound`):
/// a key that can never identify a flag is treated the same as one the
/// backend doesn't recognise, so this maps to [ErrorKind.flagNotFound] too
/// — the same controller-ruled interim mapping node/rust/swift carry.
Validated validateControlPointKey(String key) {
  if (key.isEmpty) {
    return Invalid(
      FireweaveError(
        ErrorKind.flagNotFound,
        message: 'control point key must be a non-empty string',
      ),
    );
  }
  if (key.runes.length > _maxControlPointKeyLength) {
    return Invalid(
      FireweaveError(
        ErrorKind.flagNotFound,
        message: 'control point key exceeds maximum length',
      ),
    );
  }
  if (_hasControlCharacters(key)) {
    return Invalid(
      FireweaveError(
        ErrorKind.flagNotFound,
        message: 'control point key contains control characters',
      ),
    );
  }
  return const Valid();
}

// ---------------------------------------------------------------------------
// Rule 2 — validateDefaultValue

/// default vs type — e.g. `getBooleanValue` with a non-boolean default is
/// [ErrorKind.typeMismatch] (`spec/control-points.md` rule 2, checked before
/// any I/O).
Validated validateDefaultValue(FlagType expectedType, Object? defaultValue) =>
    matchesExpectedType(defaultValue, expectedType)
    ? const Valid()
    : Invalid(FireweaveError(ErrorKind.typeMismatch));

// ---------------------------------------------------------------------------
// validateTargetingKey

/// targetingKey: "An SDK MUST NOT invent one: a missing targeting key is
/// InvalidContext where the evaluation needs it, never a generated anonymous
/// id" (`spec/control-points.md` "Context"). [required] is call-site policy
/// — the remote adapter's `registerTarget` always requires one; the generic
/// context pipeline (`validateContext`) only does when its caller opts in.
Validated validateTargetingKey(String? targetingKey, {required bool required}) {
  if (required && (targetingKey == null || targetingKey.isEmpty)) {
    return Invalid(FireweaveError.targetingKeyMissing());
  }
  return const Valid();
}

// ---------------------------------------------------------------------------
// Rule 3 — validateContext

int _maxDepth(Object? value) {
  if (value is Map) {
    var deepest = 0;
    for (final child in value.values) {
      final depth = _maxDepth(child);
      if (depth > deepest) {
        deepest = depth;
      }
    }
    return 1 + deepest;
  }
  if (value is List) {
    var deepest = 0;
    for (final child in value) {
      final depth = _maxDepth(child);
      if (depth > deepest) {
        deepest = depth;
      }
    }
    return 1 + deepest;
  }
  return 0;
}

/// Depth of the top-level attribute map itself (root = 1, matching
/// `spec/evaluation-context.schema.json` `bounds.maxDepth`'s doc comment).
int _maxDepthOfAttributes(Map<String, Object?> attributes) =>
    1 +
    attributes.values.fold<int>(0, (deepest, child) {
      final depth = _maxDepth(child);
      return depth > deepest ? depth : deepest;
    });

bool _anyKeyExceedsBytes(Object? value, int limit) {
  if (value is Map) {
    for (final entry in value.entries) {
      if (utf8ByteLength(entry.key.toString()) > limit ||
          _anyKeyExceedsBytes(entry.value, limit)) {
        return true;
      }
    }
    return false;
  }
  if (value is List) {
    return value.any((child) => _anyKeyExceedsBytes(child, limit));
  }
  return false;
}

bool _anyStringValueExceedsBytes(Object? value, int limit) {
  if (value is Map) {
    return value.values.any(
      (child) => _anyStringValueExceedsBytes(child, limit),
    );
  }
  if (value is List) {
    return value.any((child) => _anyStringValueExceedsBytes(child, limit));
  }
  if (value is String) {
    return utf8ByteLength(value) > limit;
  }
  return false;
}

/// context — depth, key count, value size, reserved keys
/// (`evaluation-context.schema.json`) (`spec/control-points.md` rule 3).
/// Also enforces [requireTargetingKey] via [validateTargetingKey].
///
/// Carries no cycle check: `EvaluationContext.attributes` is a Dart `Map`
/// tree built from JSON-shaped values; a caller could in principle build a
/// self-referencing map, but `jsonEncode` (used by the serialized-size probe
/// below) throws `JsonCyclicError` on one, which this function turns into
/// `InvalidContext` rather than letting it escape a read path.
Validated validateContext(
  EvaluationContext context, {
  required ContextLimits limits,
  required Set<String> reservedKeys,
  required bool requireTargetingKey,
}) {
  final attrs = context.attributes;

  for (final key in attrs.keys) {
    if (reservedKeys.contains(key)) {
      return Invalid(FireweaveError(ErrorKind.invalidContext));
    }
    if (key.startsWith('fireweave.') &&
        !allowedFireweaveContextKeys.contains(key)) {
      return Invalid(FireweaveError(ErrorKind.invalidContext));
    }
  }

  if (attrs.length > limits.maxAttributeCount) {
    return Invalid(
      FireweaveError(
        ErrorKind.invalidContext,
        message: 'context exceeds maximum attribute count',
      ),
    );
  }

  if (attrs.entries.any(
    (entry) =>
        utf8ByteLength(entry.key) > limits.maxKeyBytes ||
        _anyKeyExceedsBytes(entry.value, limits.maxKeyBytes),
  )) {
    return Invalid(
      FireweaveError(
        ErrorKind.invalidContext,
        message: 'context key exceeds maximum size',
      ),
    );
  }

  if (attrs.values.any(
    (value) => _anyStringValueExceedsBytes(value, limits.maxValueBytes),
  )) {
    return Invalid(
      FireweaveError(
        ErrorKind.invalidContext,
        message: 'context value exceeds maximum size',
      ),
    );
  }

  if (_maxDepthOfAttributes(attrs) > limits.maxNestingDepth) {
    return Invalid(
      FireweaveError(
        ErrorKind.invalidContext,
        message: 'context exceeds maximum nesting depth',
      ),
    );
  }

  final String serialized;
  try {
    serialized = stableJsonString(<String, Object?>{
      'targetingKey': context.targetingKey,
      'attributes': attrs,
    });
  } on Object {
    return Invalid(
      FireweaveError(
        ErrorKind.invalidContext,
        message: 'context is not JSON-serializable',
      ),
    );
  }
  if (utf8ByteLength(serialized) > limits.maxSerializedBytes) {
    return Invalid(
      FireweaveError(
        ErrorKind.invalidContext,
        message: 'serialized context exceeds maximum size',
      ),
    );
  }

  return validateTargetingKey(
    context.targetingKey,
    required: requireTargetingKey,
  );
}

// ---------------------------------------------------------------------------
// validateInitOptions (spec/modes.md "Initialisation validation")

bool _isBlank(String? value) => value == null || value.trim().isEmpty;

/// Initialisation-validation table (`spec/modes.md`), the three rows
/// representable at this layer:
///
/// - `mode` absent (`null`) — "unrecognised" has no Dart analogue; see
///   `Mode`'s doc comment.
/// - `mode == remote` with `apiKey`/`apiUrl` missing/blank.
/// - `mode == local` with credentials supplied (a config half-migrated from
///   remote to local reads as neither, silently — reject it instead).
///
/// Row 3 ("apiUrl fails the host allowlist") is intentionally NOT checked
/// here — that check (`assertHostAllowed`) lives in `infrastructure/hosts.dart`
/// and is invoked directly by `initFireweave` before any adapter/network I/O
/// happens (a pure `domain/` function must not depend on it).
Validated validateInitOptions({
  required Mode? mode,
  String? apiKey,
  String? apiUrl,
}) {
  switch (mode) {
    case null:
      return Invalid(
        FireweaveError.configuration(
          'mode is required and must be "local" or "remote"',
          initFatal: true,
        ),
      );
    case Mode.remote:
      if (_isBlank(apiKey) || _isBlank(apiUrl)) {
        return Invalid(
          FireweaveError.configuration(
            'mode "remote" requires apiKey and apiUrl',
            initFatal: true,
          ),
        );
      }
      return const Valid();
    case Mode.local:
      if (!_isBlank(apiKey) || !_isBlank(apiUrl)) {
        return Invalid(
          FireweaveError.configuration(
            'mode "local" must not be combined with apiKey/apiUrl — the caller '
            'means one or the other',
            initFatal: true,
          ),
        );
      }
      return const Valid();
  }
}
