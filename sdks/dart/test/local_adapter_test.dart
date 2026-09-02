import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

void main() {
  group('FireweaveLocalAdapter', () {
    test('seeded flag resolves STATIC', () async {
      final adapter = FireweaveLocalAdapter(devFlags: {'on-flag': true});
      final result = await adapter.prefetch(EvaluationContext());
      final resolution = result['on-flag']!;
      expect(resolution.found, isTrue);
      expect(resolution.value, isTrue);
      expect(resolution.variant, 'on');
      expect(resolution.reason, DecisionReason.staticReason);
    });

    test(
      'unseeded flag is absent from the batch; missReason is DEFAULT',
      () async {
        final adapter = FireweaveLocalAdapter();
        final result = await adapter.prefetch(EvaluationContext());
        expect(result['absent'], isNull);
        expect(adapter.missReason, DecisionReason.defaultReason);
      },
    );

    test('registerTarget records and traces', () async {
      final lines = <String>[];
      final adapter = FireweaveLocalAdapter(log: lines.add);
      final result = await adapter.registerTarget(
        'user-1',
        options: const RegisterTargetOptions(properties: {'plan': 'pro'}),
      );
      expect(result.ok, isTrue);
      expect(adapter.registeredTargets(), hasLength(1));
      expect(adapter.registeredTargets().single.properties, {'plan': 'pro'});
      expect(adapter.registeredTargets().single.kind, TargetKind.user);
      expect(lines, hasLength(1));
      expect(lines.single, startsWith('[fireweave:local]'));
      expect(lines.single, contains('NOT sent to fw-server'));
      expect(lines.single, contains('{"plan":"pro"}'));
    });
  });
}
