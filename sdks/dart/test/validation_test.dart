import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

extension on Validated {
  ErrorKind? get errorKind => error?.kind;
}

void main() {
  group('validateControlPointKey', () {
    test('must be non-empty', () {
      expect(validateControlPointKey('').isValid, isFalse);
      expect(validateControlPointKey('ok').isValid, isTrue);
    });

    test('length is counted in characters', () {
      expect(validateControlPointKey('k' * 257).isValid, isFalse);
      expect(validateControlPointKey('k' * 256).isValid, isTrue);
    });

    test('rejects control characters', () {
      expect(validateControlPointKey('badkey').isValid, isFalse);
      expect(
        validateControlPointKey('badkey').errorKind,
        ErrorKind.flagNotFound,
      );
    });
  });

  group('validateDefaultValue', () {
    test('type mismatch', () {
      expect(
        validateDefaultValue(FlagType.boolean, 'not-a-bool').errorKind,
        ErrorKind.typeMismatch,
      );
      expect(validateDefaultValue(FlagType.boolean, true).isValid, isTrue);
      expect(validateDefaultValue(FlagType.number, 2).isValid, isTrue);
      expect(validateDefaultValue(FlagType.number, 2.5).isValid, isTrue);
      expect(
        validateDefaultValue(FlagType.object, <Object?>[]).isValid,
        isTrue,
      );
      expect(validateDefaultValue(FlagType.object, 'x').isValid, isFalse);
    });
  });

  group('validateTargetingKey', () {
    test('required and missing', () {
      final result = validateTargetingKey(null, required: true);
      expect(result.error?.openFeatureErrorCode, 'TARGETING_KEY_MISSING');
      expect(validateTargetingKey(null, required: false).isValid, isTrue);
      expect(validateTargetingKey('x', required: true).isValid, isTrue);
      expect(validateTargetingKey('', required: true).isValid, isFalse);
    });
  });

  group('validateContext', () {
    Validated check(
      EvaluationContext ctx, {
      Set<String> reserved = defaultReservedAttributeKeys,
      bool requireTargetingKey = false,
      ContextLimits limits = defaultContextLimits,
    }) => validateContext(
      ctx,
      limits: limits,
      reservedKeys: reserved,
      requireTargetingKey: requireTargetingKey,
    );

    test('reserved keys rejected', () {
      final ctx = EvaluationContext(
        targetingKey: 't',
        attributes: {'targetingKey': 'dup'},
      );
      expect(check(ctx).errorKind, ErrorKind.invalidContext);
      expect(check(ctx).error?.message, 'invalid evaluation context');
    });

    test('fireweave carve-out keys allowed, others rejected', () {
      final ok = EvaluationContext(
        targetingKey: 't',
        attributes: {
          'fireweave.groups': {'organization': 'org_1'},
        },
      );
      expect(check(ok, reserved: {}).isValid, isTrue);
      final bad = EvaluationContext(
        targetingKey: 't',
        attributes: {
          'fireweave.evaluationContexts': ['production'],
        },
      );
      expect(check(bad, reserved: {}).isValid, isFalse);
    });

    test('nesting depth exceeded', () {
      Object? nested = {'d9': true};
      for (final name in ['d8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2', 'd1']) {
        nested = {name: nested};
      }
      final ctx = EvaluationContext(
        targetingKey: 't',
        attributes: (nested as Map).cast<String, Object?>(),
      );
      expect(
        check(ctx).error?.message,
        'context exceeds maximum nesting depth',
      );
    });

    test('a flat context at depth 1 and a nested map at depth 2 are fine', () {
      final ctx = EvaluationContext(
        targetingKey: 't',
        attributes: {
          'plan': 'pro',
          'nested': {'a': 1},
        },
      );
      expect(check(ctx).isValid, isTrue);
    });

    test('attribute count exceeded', () {
      final attrs = {for (var i = 0; i < 200; i += 1) 'a$i': i};
      final ctx = EvaluationContext(targetingKey: 't', attributes: attrs);
      expect(
        check(ctx).error?.message,
        'context exceeds maximum attribute count',
      );
    });

    test('key size exceeded (utf-8 bytes, at any depth)', () {
      final ctx = EvaluationContext(
        targetingKey: 't',
        attributes: {
          'outer': {'k' * 257: 'x'},
        },
      );
      expect(check(ctx).error?.message, 'context key exceeds maximum size');
    });

    test('value size exceeded (utf-8 bytes)', () {
      final ctx = EvaluationContext(
        targetingKey: 't',
        attributes: {'blob': 'é' * 2100},
      );
      expect(check(ctx).error?.message, 'context value exceeds maximum size');
    });

    test('serialized size exceeded', () {
      final attrs = {for (var i = 0; i < 40; i += 1) 'p$i': 'X' * 2000};
      final ctx = EvaluationContext(targetingKey: 't', attributes: attrs);
      expect(
        check(ctx).error?.message,
        'serialized context exceeds maximum size',
      );
    });

    test('targeting key required', () {
      final ctx = EvaluationContext(attributes: {'plan': 'pro'});
      final result = check(ctx, requireTargetingKey: true);
      expect(result.error?.openFeatureErrorCode, 'TARGETING_KEY_MISSING');
      expect(result.errorKind, ErrorKind.invalidContext);
    });
  });

  group('validateInitOptions', () {
    test('mode absent is Configuration / PROVIDER_FATAL', () {
      final result = validateInitOptions(mode: null);
      expect(result.errorKind, ErrorKind.configuration);
      expect(result.error?.openFeatureErrorCode, 'PROVIDER_FATAL');
    });

    test('remote requires credentials', () {
      expect(
        validateInitOptions(mode: Mode.remote, apiUrl: 'https://x').isValid,
        isFalse,
      );
      expect(
        validateInitOptions(
          mode: Mode.remote,
          apiKey: 'key',
          apiUrl: '  ',
        ).isValid,
        isFalse,
      );
      expect(
        validateInitOptions(
          mode: Mode.remote,
          apiKey: 'key',
          apiUrl: 'https://x',
        ).isValid,
        isTrue,
      );
    });

    test('local rejects stray credentials', () {
      expect(
        validateInitOptions(mode: Mode.local, apiKey: 'key').isValid,
        isFalse,
      );
      expect(validateInitOptions(mode: Mode.local).isValid, isTrue);
    });
  });
}
