@TestOn('browser')
library;

import 'package:fireweave/fireweave.dart';
import 'package:fireweave/src/infrastructure/transport/default_http_transport.dart';
import 'package:fireweave/src/infrastructure/transport/http_transport_web.dart'
    show WebHttpTransport;
import 'package:test/test.dart';

/// Browser leg (`dart test -p chrome`): the whole runtime compiled with
/// dart2js, plus the `fetch` transport the conditional export selects when
/// `dart:io` is absent. The VM leg (`dart test`) skips this file; the four
/// `@TestOn('vm')` files that read the filesystem are skipped here — every
/// other test file runs on BOTH legs, which is the actual portability proof.
void main() {
  test('the platform default transport is the fetch-backed web transport', () {
    expect(createDefaultHttpTransport(), isA<WebHttpTransport>());
  });

  test('a refused connection is a Network decision, never a throw', () async {
    // 127.0.0.1:1 refuses; the browser reports that as a rejected fetch.
    final client = await initFireweave(
      InitFireweaveOptions.remote(
        apiKey: 'key',
        apiUrl: 'http://127.0.0.1:1',
        allowedHosts: const ['127.0.0.1'],
        requestTimeoutMs: 2000,
        context: EvaluationContext(targetingKey: 'anon'),
      ),
    );
    expect(
      client.runtime.state,
      anyOf(LifecycleState.error, LifecycleState.stale),
    );
    final decision = client.controlPoints.getBooleanDetails('f', false);
    expect(decision.value, isFalse);
    expect(decision.reason, anyOf(DecisionReason.error, DecisionReason.stale));
    await client.shutdown();
  });

  test('local mode runs entirely in the browser', () async {
    final lines = <String>[];
    final client = await initFireweave(
      InitFireweaveOptions.local(
        controlPoints: const {'new-checkout': true},
        log: lines.add,
      ),
    );
    final result = await client.identify(
      'user_42',
      options: const RegisterTargetOptions(properties: {'plan': 'pro'}),
    );
    expect(result.ok, isTrue);
    expect(lines.single, startsWith('[fireweave:local]'));
    expect(client.controlPoints.getBooleanValue('new-checkout', false), isTrue);
    expect(
      client.controlPoints.getBooleanDetails('absent', false).reason,
      DecisionReason.defaultReason,
    );
    await client.shutdown();
  });
}
