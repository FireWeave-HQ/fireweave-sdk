import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

import 'support/test_doubles.dart';

/// The four Configuration rows (`spec/modes.md` "Initialisation validation")
/// THROW at init; reads on the returned client never do.
///
/// Two of the four rows (mode absent; local combined with credentials) are
/// unrepresentable BY CONSTRUCTION through `initFireweave`'s sealed
/// `InitFireweaveOptions` — both are still fully exercised at the
/// `validateInitOptions` pure-function level (`validation_test.dart`).
void main() {
  group('initFireweave — Configuration rows throw; reads never do', () {
    test('remote missing apiKey throws Configuration', () async {
      await expectLater(
        initFireweave(
          InitFireweaveOptions.remote(
            apiKey: '',
            apiUrl: 'https://app-server.fireweave.ai',
          ),
        ),
        throwsA(
          isA<FireweaveError>().having(
            (e) => e.kind,
            'kind',
            ErrorKind.configuration,
          ),
        ),
      );
    });

    test('remote missing apiUrl throws Configuration', () async {
      await expectLater(
        initFireweave(InitFireweaveOptions.remote(apiKey: 'key', apiUrl: '')),
        throwsA(isA<FireweaveError>()),
      );
    });

    test('remote host failing the allowlist throws Configuration', () async {
      try {
        await initFireweave(
          InitFireweaveOptions.remote(
            apiKey: 'key',
            apiUrl: 'http://169.254.169.254',
          ),
        );
        fail('expected a throw');
      } on FireweaveError catch (error) {
        expect(error.kind, ErrorKind.configuration);
        expect(error.openFeatureErrorCode, 'PROVIDER_FATAL');
      }
    });

    test('local mode succeeds and reads never throw', () async {
      final client = await initFireweave(
        InitFireweaveOptions.local(controlPoints: {'f': true}, log: (_) {}),
      );
      expect(client.controlPoints.getBooleanValue('f', false), isTrue);
      expect(client.controlPoints.getBooleanValue('absent', false), isFalse);
      expect(
        client.controlPoints.getBooleanDetails('absent', false).reason,
        DecisionReason.defaultReason,
      );
      await client.shutdown();
    });

    test('remote mode with a good configuration and an injected transport '
        'reaches READY', () async {
      final client = await initFireweave(
        InitFireweaveOptions.remote(
          apiKey: 'key',
          apiUrl: 'http://127.0.0.1:1',
          allowedHosts: const ['127.0.0.1'],
          context: EvaluationContext(targetingKey: 'anon'),
          httpTransport: FakeTransport(
            body: '{"decisions":[{"flagKey":"f","value":true,"found":true}]}',
          ),
        ),
      );
      expect(client.runtime.state, LifecycleState.ready);
      expect(client.controlPoints.getBooleanValue('f', false), isTrue);
      await client.shutdown();
    });

    test(
      'remote mode with a transient transport failure is ERROR, not a throw',
      () async {
        // Loopback + allowedHosts, so this never leaves the machine; the point
        // is only that a WELL-FORMED remote config does not throw at init —
        // the network call itself fails, which is `error`, not a throw.
        final client = await initFireweave(
          InitFireweaveOptions.remote(
            apiKey: 'key',
            apiUrl: 'http://127.0.0.1:1',
            allowedHosts: const ['127.0.0.1'],
            context: EvaluationContext(targetingKey: 'anon'),
            httpTransport: ThrowingTransport(FireweaveError(ErrorKind.network)),
          ),
        );
        expect(client.runtime.state, LifecycleState.error);
        final decision = client.controlPoints.getBooleanDetails('f', false);
        expect(decision.value, isFalse);
        expect(decision.errorKind, ErrorKind.network);
        await client.shutdown();
      },
    );

    test(
      'the platform default transport exists (io on the VM, fetch in the browser)',
      () async {
        // No transport injected: the platform transport is constructed. Port 1
        // on loopback refuses, so the prefetch degrades to ERROR/Network — and
        // nothing throws.
        final client = await initFireweave(
          InitFireweaveOptions.remote(
            apiKey: 'key',
            apiUrl: 'http://127.0.0.1:1',
            allowedHosts: const ['127.0.0.1'],
            requestTimeoutMs: 500,
            context: EvaluationContext(targetingKey: 'anon'),
          ),
        );
        expect(
          client.runtime.state,
          anyOf(LifecycleState.error, LifecycleState.stale),
        );
        await client.shutdown();
      },
    );

    test('options carry their mode', () {
      expect(InitFireweaveOptions.local().mode, Mode.local);
      expect(
        InitFireweaveOptions.remote(apiKey: 'k', apiUrl: 'u').mode,
        Mode.remote,
      );
    });
  });
}
