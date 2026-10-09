import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

void main() {
  group('mergeContexts', () {
    test('later layers win', () {
      final global = EvaluationContext(
        targetingKey: 'g',
        attributes: {'tier': 'bronze'},
      );
      final client = EvaluationContext(attributes: {'tier': 'silver'});
      final invocation = EvaluationContext(attributes: {'tier': 'gold'});

      final merged = mergeContexts([global, client, invocation]);
      expect(merged.targetingKey, 'g');
      expect(merged.attributes['tier'], 'gold');
    });

    test('skips absent layers', () {
      final merged = mergeContexts([
        null,
        null,
        EvaluationContext(targetingKey: 'only'),
      ]);
      expect(merged.targetingKey, 'only');
    });

    test('never mutates the caller\'s map', () {
      final attrs = <String, Object?>{'plan': 'pro'};
      final ctx = EvaluationContext(targetingKey: 't', attributes: attrs);
      final merged = mergeContexts([
        ctx,
        EvaluationContext(attributes: {'x': 1}),
      ]);
      expect(merged.attributes, {'plan': 'pro', 'x': 1});
      expect(attrs, {'plan': 'pro'});
      expect(() => ctx.attributes['y'] = 2, throwsUnsupportedError);
    });
  });

  group('EvaluationContext accessors', () {
    test(
      'groups and groupProperties read through aliases and canonical keys',
      () {
        final ctx = EvaluationContext(
          attributes: {
            'fireweave.groups': {'organization': 'org_1'},
            'groupProperties': {
              'organization': {'plan': 'enterprise'},
            },
          },
        );
        expect(ctx.groups?['organization'], 'org_1');
        expect(
          (ctx.groupProperties?['organization'] as Map)['plan'],
          'enterprise',
        );
      },
    );

    test('vendor hints are the \$-prefixed attributes', () {
      final ctx = EvaluationContext(attributes: {r'$geo': 'eu', 'plan': 'pro'});
      expect(ctx.vendorHints, {r'$geo': 'eu'});
      expect(ctx.plainAttributes, {'plan': 'pro'});
    });

    test('toJson omits absent fields', () {
      expect(EvaluationContext().toJson(), isEmpty);
      expect(EvaluationContext(targetingKey: 't').toJson(), {
        'targetingKey': 't',
      });
    });
  });
}
