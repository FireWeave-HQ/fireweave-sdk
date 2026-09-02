import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

FireweaveClient client() =>
    FireweaveClient(FireweaveRuntime(InMemoryAdapter()));

void main() {
  group('FireweaveClient', () {
    test('flags alias shares identity with controlPoints', () {
      final fw = client();
      // ignore: deprecated_member_use_from_same_package
      expect(identical(fw.flags, fw.controlPoints), isTrue);
    });

    test('invokeCapability degrades unsupported', () async {
      final fw = client();
      await fw.initialize();
      final result = fw.invokeCapability('releases.teleport');
      expect(result.ok, isFalse);
      expect(result.degraded, isTrue);
      expect(result.errorKind, ErrorKind.unsupportedCapability);
      expect(result.errorCode, 'GENERAL');
      expect(result.errorMessage, 'unsupported capability');
    });

    test('details returns a Decision, value returns the bare value', () async {
      final fw = client();
      await fw.initialize();
      final value = fw.controlPoints.getBooleanValue('absent', false);
      final details = fw.controlPoints.getBooleanDetails('absent', false);
      expect(value, isFalse);
      expect(details.value, isFalse);
      expect(details.reason, DecisionReason.error);
    });

    test('typed getters fall back to the default on the wrong shape', () async {
      final fw = FireweaveClient(
        FireweaveRuntime(
          InMemoryAdapter.fromFlagsJson({
            's': {'type': 'string', 'enabled': true, 'value': 'dark'},
            'n': {'type': 'number', 'enabled': true, 'value': 2.5},
            'o': {
              'type': 'object',
              'enabled': true,
              'value': {'mode': 'safe'},
            },
          }),
        ),
      );
      await fw.initialize();
      final cp = fw.controlPoints;
      expect(cp.getStringValue('s', 'light'), 'dark');
      expect(cp.getNumberValue('n', 0), 2.5);
      expect(cp.getObjectValue('o', const <String, Object?>{}), {
        'mode': 'safe',
      });
      expect(cp.getBooleanValue('s', false), isFalse);
      expect(cp.getNumberValue('s', 7), 7);
      expect(cp.getStringValue('n', 'x'), 'x');
    });

    test('registerTarget exists with local mode recorded and traced', () async {
      final fw = await initFireweave(InitFireweaveOptions.local(log: (_) {}));
      final result = await fw.registerTarget('user_1');
      expect(result.ok, isTrue);
    });

    /// Reachable from the SANCTIONED entry point: an accessor that exists
    /// only on a concrete infrastructure type must be reachable via the real
    /// `initFireweave` -> `client.runtime.backendAdapter` path.
    test(
      'registered target is readable through the sanctioned entry point',
      () async {
        final fw = await initFireweave(InitFireweaveOptions.local(log: (_) {}));
        final result = await fw.registerTarget(
          'user_42',
          options: const RegisterTargetOptions(properties: {'plan': 'pro'}),
        );
        expect(result.ok, isTrue);

        final adapter = fw.runtime.backendAdapter;
        expect(adapter, isA<FireweaveLocalAdapter>());
        final recorded = (adapter as FireweaveLocalAdapter).registeredTargets();
        expect(recorded, hasLength(1));
        expect(recorded.single.targetingKey, 'user_42');
        expect(recorded.single.properties['plan'], 'pro');
      },
    );

    test(
      'identify registers and re-prefetches under the stable targeting key',
      () async {
        final fw = await initFireweave(
          InitFireweaveOptions.local(controlPoints: {'f': true}, log: (_) {}),
        );
        final result = await fw.identify('user_9');
        expect(result.ok, isTrue);
        expect(fw.controlPoints.getBooleanValue('f', false), isTrue);
      },
    );

    test('setContext + refresh re-prefetches; context layers merge', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'gated': {
          'type': 'boolean',
          'enabled': true,
          'value': true,
          'matchAttribute': {'tier': 'gold'},
        },
      });
      final fw = FireweaveClient(FireweaveRuntime(adapter));
      await fw.initialize(context: EvaluationContext(targetingKey: 'u'));
      expect(fw.controlPoints.getBooleanValue('gated', false), isFalse);
      fw.setContext(EvaluationContext(attributes: {'tier': 'gold'}));
      await fw.runtime.refresh();
      expect(fw.controlPoints.getBooleanValue('gated', false), isTrue);
    });
  });
}
