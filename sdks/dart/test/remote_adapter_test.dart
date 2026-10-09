import 'dart:convert';

import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

import 'support/test_doubles.dart';

Future<FireweaveRemoteAdapter> readyAdapter(
  HttpTransport transport, {
  String apiUrl = 'http://127.0.0.1:9',
}) async {
  final adapter = FireweaveRemoteAdapter(
    RemoteAdapterConfig(apiUrl: apiUrl, apiKey: 'test-key'),
    transport: transport,
  );
  await adapter.initialize();
  return adapter;
}

void main() {
  group('FireweaveRemoteAdapter', () {
    test('vendor metadata surfaces when the server sends both keys', () async {
      final transport = FakeTransport(
        body:
            '{"decisions":[{"controlPointKey":"f","value":true,"variant":"on",'
            '"reason":"TARGETING_MATCH","found":true,"enabled":true,'
            '"controlPointMetadata":{"fireweave.vendorControlPointId":1001,'
            '"fireweave.reasonCode":"condition_match"}}]}',
      );
      final runtime = FireweaveRuntime(await readyAdapter(transport));
      await runtime.initialize(
        context: EvaluationContext(targetingKey: 'user-1'),
      );
      final decision = runtime.evaluate('f', FlagType.boolean, false);
      expect(decision.value, isTrue);
      expect(
        decision.controlPointMetadata['fireweave.vendorControlPointId'],
        1001,
      );
      expect(
        decision.controlPointMetadata['fireweave.reasonCode'],
        'condition_match',
      );
    });

    test('omits vendor metadata when only one key is present', () async {
      final transport = FakeTransport(
        body:
            '{"decisions":[{"controlPointKey":"f","value":true,"variant":"on",'
            '"reason":"TARGETING_MATCH","found":true,"enabled":true,'
            '"controlPointMetadata":{"fireweave.reasonCode":"condition_match"}}]}',
      );
      final runtime = FireweaveRuntime(await readyAdapter(transport));
      await runtime.initialize(
        context: EvaluationContext(targetingKey: 'user-1'),
      );
      final decision = runtime.evaluate('f', FlagType.boolean, false);
      expect(
        decision.controlPointMetadata.containsKey(
          'fireweave.vendorControlPointId',
        ),
        isFalse,
      );
      expect(
        decision.controlPointMetadata.containsKey('fireweave.reasonCode'),
        isFalse,
      );
    });

    test('absent key from decisions is ControlPointNotFound', () async {
      final runtime = FireweaveRuntime(
        await readyAdapter(FakeTransport(body: '{"decisions":[]}')),
      );
      await runtime.initialize(
        context: EvaluationContext(targetingKey: 'user-1'),
      );
      final decision = runtime.evaluate('missing', FlagType.boolean, false);
      expect(decision.errorKind, ErrorKind.controlPointNotFound);
    });

    test('HTTP status maps to the documented error kind', () async {
      const cases = <int, ErrorKind>{
        401: ErrorKind.authentication,
        403: ErrorKind.authorization,
        429: ErrorKind.rateLimited,
        500: ErrorKind.backendUnavailable,
      };
      for (final entry in cases.entries) {
        final runtime = FireweaveRuntime(
          await readyAdapter(FakeTransport(statusCode: entry.key, body: '{}')),
        );
        await runtime.initialize(
          context: EvaluationContext(targetingKey: 'user-1'),
        );
        expect(
          runtime.state,
          LifecycleState.error,
          reason: 'status ${entry.key}',
        );
        expect(
          runtime.initializationError?.kind,
          entry.value,
          reason: 'status ${entry.key}',
        );
      }
    });

    test('malformed JSON body is MalformedResponse', () async {
      final runtime = FireweaveRuntime(
        await readyAdapter(FakeTransport(body: 'not json')),
      );
      await runtime.initialize(
        context: EvaluationContext(targetingKey: 'user-1'),
      );
      expect(runtime.initializationError?.kind, ErrorKind.malformedResponse);
    });

    test(
      'transport Timeout/Network errors pass through as their kind',
      () async {
        final runtime = FireweaveRuntime(
          await readyAdapter(
            ThrowingTransport(FireweaveError(ErrorKind.timeout)),
          ),
        );
        await runtime.initialize(
          context: EvaluationContext(targetingKey: 'user-1'),
        );
        expect(runtime.initializationError?.kind, ErrorKind.timeout);
      },
    );

    /// A missing targetingKey at PREFETCH time returns an empty batch rather
    /// than throwing — what lets an anonymous pre-sign-in boot reach READY.
    test(
      'missing targeting key at prefetch returns an empty batch, no call',
      () async {
        final transport = FakeTransport(body: '{"decisions":[]}');
        final adapter = await readyAdapter(transport);
        final result = await adapter.prefetch(EvaluationContext());
        expect(result, isEmpty);
        expect(transport.calls, 0);
      },
    );

    test('registerTarget still hard-requires a targeting key', () async {
      final adapter = await readyAdapter(FakeTransport(body: '{}'));
      final result = await adapter.registerTarget('');
      expect(result.ok, isFalse);
      expect(result.error?.kind, ErrorKind.invalidContext);
    });

    test('host allowlist rejects non-loopback http at initialize', () async {
      final adapter = FireweaveRemoteAdapter(
        const RemoteAdapterConfig(
          apiUrl: 'http://169.254.169.254',
          apiKey: 'k',
        ),
        transport: FakeTransport(body: '{}'),
      );
      await expectLater(adapter.initialize(), throwsA(isA<FireweaveError>()));
    });

    test('registerTarget sends kind/properties with a bearer header', () async {
      final transport = FakeTransport(body: '{}');
      final adapter = await readyAdapter(transport);
      final result = await adapter.registerTarget(
        'user-1',
        options: const RegisterTargetOptions(
          kind: TargetKind.device,
          properties: {'plan': 'pro'},
        ),
      );
      expect(result.ok, isTrue);
      expect(
        transport.lastUrl.toString(),
        'http://127.0.0.1:9/v1/targets/register',
      );
      expect(transport.lastHeaders?['Authorization'], 'Bearer test-key');
      final sent = jsonDecode(transport.lastBody!) as Map;
      expect(sent['targetingKey'], 'user-1');
      expect(sent['kind'], 'device');
      expect(sent['properties'], {'plan': 'pro'});
    });

    test(
      'registerTarget retries once on a retryable failure, never on 401',
      () async {
        final retryable = FakeTransport(statusCode: 500, body: '{}');
        final adapter = await readyAdapter(retryable);
        final result = await adapter.registerTarget('user-1');
        expect(result.ok, isFalse);
        expect(retryable.calls, 2);

        final fatal = FakeTransport(statusCode: 401, body: '{}');
        final adapter2 = await readyAdapter(fatal);
        await adapter2.registerTarget('user-1');
        expect(fatal.calls, 1);
      },
    );

    test(
      'prefetch strips vendor hints and lifts groups into the body',
      () async {
        final transport = FakeTransport(body: '{"decisions":[]}');
        final adapter = await readyAdapter(transport);
        await adapter.prefetch(
          EvaluationContext(
            targetingKey: 'u',
            attributes: {
              'plan': 'pro',
              r'$geo': 'eu',
              'fireweave.groups': {'organization': 'org_1'},
            },
          ),
        );
        final sent = jsonDecode(transport.lastBody!) as Map;
        expect(sent['targetingKey'], 'u');
        expect(sent['attributes'], {'plan': 'pro'});
        expect(sent['groups'], {'organization': 'org_1'});
        expect(
          transport.lastUrl.toString(),
          'http://127.0.0.1:9/v1/control-points/evaluate',
        );
      },
    );

    test(
      'quota-limited empty batch is ControlPointNotFound with quotaLimited',
      () async {
        final adapter = await readyAdapter(
          FakeTransport(body: '{"decisions":[],"quotaLimited":true}'),
        );
        try {
          await adapter.prefetch(EvaluationContext(targetingKey: 'u'));
          fail('expected a throw');
        } on FireweaveError catch (error) {
          expect(error.kind, ErrorKind.controlPointNotFound);
          expect(error.quotaLimited, isTrue);
        }
      },
    );
  });
}
