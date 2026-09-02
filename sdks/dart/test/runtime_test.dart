import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

import 'support/test_doubles.dart';

void main() {
  group('FireweaveRuntime lifecycle + evaluation', () {
    test('evaluate before initialize is NotReady', () {
      final runtime = FireweaveRuntime(InMemoryAdapter());
      final decision = runtime.evaluate('any', FlagType.boolean, false);
      expect(decision.reason, DecisionReason.error);
      expect(decision.errorKind, ErrorKind.notReady);
      expect(decision.value, isFalse);
      expect(decision.flagMetadata, {'fireweave.errorKind': 'NotReady'});
    });

    test('evaluate after shutdown is AlreadyClosed', () async {
      final runtime = FireweaveRuntime(InMemoryAdapter());
      await runtime.initialize();
      await runtime.shutdown();
      final decision = runtime.evaluate('any', FlagType.boolean, false);
      expect(decision.errorKind, ErrorKind.alreadyClosed);
      expect(decision.errorCode, 'PROVIDER_NOT_READY');
    });

    test('shutdown is idempotent', () async {
      final runtime = FireweaveRuntime(InMemoryAdapter());
      await runtime.initialize();
      await runtime.shutdown();
      await runtime.shutdown();
      expect(runtime.state, LifecycleState.shutdown);
      expect(runtime.state.wireName, 'CLOSED');
    });

    test('matched flag resolves with TARGETING_MATCH', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'my-flag': {
          'type': 'boolean',
          'enabled': true,
          'variant': 'on',
          'value': true,
        },
      });
      final runtime = FireweaveRuntime(adapter);
      await runtime.initialize(context: EvaluationContext(targetingKey: 't1'));
      final decision = runtime.evaluate('my-flag', FlagType.boolean, false);
      expect(decision.value, isTrue);
      expect(decision.variant, 'on');
      expect(decision.reason, DecisionReason.targetingMatch);
    });

    test('absent key on InMemoryAdapter is FlagNotFound', () async {
      final runtime = FireweaveRuntime(InMemoryAdapter());
      await runtime.initialize(context: EvaluationContext(targetingKey: 't1'));
      final decision = runtime.evaluate('missing', FlagType.boolean, false);
      expect(decision.errorKind, ErrorKind.flagNotFound);
      expect(decision.errorCode, 'FLAG_NOT_FOUND');
      expect(decision.value, isFalse);
    });

    test('absent key on the local adapter is DEFAULT, not an error', () async {
      final runtime = FireweaveRuntime(FireweaveLocalAdapter());
      await runtime.initialize();
      final decision = runtime.evaluate('missing', FlagType.boolean, true);
      expect(decision.reason, DecisionReason.defaultReason);
      expect(decision.value, isTrue);
      expect(decision.errorKind, isNull);
    });

    /// A flag PRESENT in the batch whose conditions do not select the caller
    /// is DEFAULT, never FlagNotFound — for EVERY adapter, not just local.
    test(
      'present but non-matching condition is DEFAULT, not FlagNotFound',
      () async {
        final adapter = InMemoryAdapter.fromFlagsJson({
          'gated': {
            'type': 'boolean',
            'enabled': true,
            'value': true,
            'matchAttribute': {'tier': 'gold'},
          },
        });
        final runtime = FireweaveRuntime(adapter);
        await runtime.initialize(
          context: EvaluationContext(
            targetingKey: 't1',
            attributes: {'tier': 'bronze'},
          ),
        );
        final decision = runtime.evaluate('gated', FlagType.boolean, false);
        expect(decision.reason, DecisionReason.defaultReason);
        expect(decision.errorKind, isNull);
      },
    );

    test('vendor metadata emitted only when both keys are present', () async {
      final both = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': true,
          'value': true,
          'metadata': {'id': 1001, 'version': 3},
          'reason': {'code': 'condition_match', 'condition_index': 0},
        },
      });
      final runtimeBoth = FireweaveRuntime(both);
      await runtimeBoth.initialize(
        context: EvaluationContext(targetingKey: 't1'),
      );
      final decisionBoth = runtimeBoth.evaluate('f', FlagType.boolean, false);
      expect(decisionBoth.flagMetadata, {
        'fireweave.flagVersion': 3,
        'fireweave.vendorFlagId': 1001,
        'fireweave.reasonCode': 'condition_match',
      });

      final onlyOne = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': true,
          'value': true,
          'metadata': {'id': 1001},
        },
      });
      final runtimeOne = FireweaveRuntime(onlyOne);
      await runtimeOne.initialize(
        context: EvaluationContext(targetingKey: 't1'),
      );
      final decisionOne = runtimeOne.evaluate('f', FlagType.boolean, false);
      expect(
        decisionOne.flagMetadata.containsKey('fireweave.vendorFlagId'),
        isFalse,
      );
      expect(
        decisionOne.flagMetadata.containsKey('fireweave.reasonCode'),
        isFalse,
      );
    });

    test('type mismatch on the resolved value', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'f': {'type': 'string', 'enabled': true, 'value': 'not-a-bool'},
      });
      final runtime = FireweaveRuntime(adapter);
      await runtime.initialize(context: EvaluationContext(targetingKey: 't1'));
      final decision = runtime.evaluate('f', FlagType.boolean, false);
      expect(decision.errorKind, ErrorKind.typeMismatch);
      expect(decision.errorCode, 'TYPE_MISMATCH');
    });

    test(
      'default value of the wrong type is TypeMismatch before any lookup',
      () async {
        final runtime = FireweaveRuntime(InMemoryAdapter());
        await runtime.initialize();
        final decision = runtime.evaluate('f', FlagType.boolean, 'nope');
        expect(decision.errorKind, ErrorKind.typeMismatch);
        expect(decision.value, 'nope');
      },
    );

    test('disabled flag is DISABLED with its own value', () async {
      final adapter = InMemoryAdapter.fromFlagsJson({
        'f': {
          'type': 'boolean',
          'enabled': false,
          'variant': 'off',
          'value': false,
        },
      });
      final runtime = FireweaveRuntime(adapter);
      await runtime.initialize();
      final decision = runtime.evaluate('f', FlagType.boolean, true);
      expect(decision.reason, DecisionReason.disabled);
      expect(decision.value, isFalse);
      expect(decision.variant, 'off');
    });

    test(
      'payload is attached as a stable JSON string only when asked',
      () async {
        final adapter = InMemoryAdapter.fromFlagsJson({
          'f': {
            'type': 'boolean',
            'enabled': true,
            'value': true,
            'payload': {'rolloutId': 'r1', 'maxRetries': 2},
          },
        });
        final runtime = FireweaveRuntime(adapter);
        await runtime.initialize();
        final without = runtime.evaluate('f', FlagType.boolean, false);
        expect(without.flagMetadata.containsKey('fireweave.payload'), isFalse);
        final with_ = runtime.evaluate(
          'f',
          FlagType.boolean,
          false,
          options: const EvaluateOptions(includePayload: true),
        );
        expect(
          with_.flagMetadata['fireweave.payload'],
          '{"maxRetries":2,"rolloutId":"r1"}',
        );
      },
    );

    test('fault in prefetch enters ERROR (retriable), not FATAL', () async {
      final adapter = InMemoryAdapter();
      adapter.setFault(const InMemoryFault(ErrorKind.backendUnavailable));
      final runtime = FireweaveRuntime(adapter);
      await runtime.initialize(context: EvaluationContext(targetingKey: 't1'));
      expect(runtime.state, LifecycleState.error);
      final decision = runtime.evaluate('any', FlagType.boolean, false);
      expect(decision.errorKind, ErrorKind.backendUnavailable);

      // A later refresh recovers.
      adapter.setFault(null);
      await runtime.refresh();
      expect(runtime.state, LifecycleState.ready);
    });

    test('initialize failing in adapter.initialize() is FATAL', () async {
      final adapter = _InitThrowingAdapter();
      final runtime = FireweaveRuntime(adapter);
      await runtime.initialize();
      expect(runtime.state, LifecycleState.fatal);
      expect(runtime.state.wireName, 'FATAL');
      expect(runtime.initializationError?.kind, ErrorKind.configuration);
    });

    test(
      'reserved keys from config are honoured on top of the defaults',
      () async {
        final runtime = FireweaveRuntime(
          InMemoryAdapter(),
          config: const RuntimeConfig(reservedAttributeKeys: {'secret'}),
        );
        await runtime.initialize();
        final decision = runtime.evaluate(
          'f',
          FlagType.boolean,
          false,
          context: EvaluationContext(attributes: {'secret': 1}),
        );
        expect(decision.errorKind, ErrorKind.invalidContext);
        final decision2 = runtime.evaluate(
          'f',
          FlagType.boolean,
          false,
          context: EvaluationContext(attributes: {'kind': 'x'}),
        );
        expect(decision2.errorKind, ErrorKind.invalidContext);
      },
    );

    test('registerTarget is lifecycle-gated', () async {
      final runtime = FireweaveRuntime(FireweaveLocalAdapter(log: (_) {}));
      final before = await runtime.registerTarget('u');
      expect(before.ok, isFalse);
      expect(before.error?.kind, ErrorKind.notReady);
      await runtime.initialize();
      expect((await runtime.registerTarget('u')).ok, isTrue);
      await runtime.shutdown();
      expect(
        (await runtime.registerTarget('u')).error?.kind,
        ErrorKind.alreadyClosed,
      );
    });
  });

  group('FireweaveRuntime concurrency: prefetch ceiling + sync read', () {
    /// Ceiling loses the race against a slow prefetch: `refresh()` returns
    /// PROMPTLY (near the ceiling, not near the adapter's real delay), and
    /// the state is STALE, never blocking on the loser.
    test(
      'ceiling loss enters STALE without waiting for the slow adapter',
      () async {
        final adapter = SlowFakeAdapter(delay: const Duration(seconds: 2));
        final runtime = FireweaveRuntime(
          adapter,
          config: const RuntimeConfig(flagsReadyTimeoutMs: 50),
        );
        final stopwatch = Stopwatch()..start();
        await runtime.initialize();
        stopwatch.stop();
        expect(runtime.state, LifecycleState.stale);
        expect(stopwatch.elapsedMilliseconds, lessThan(500));

        final decision = runtime.evaluate('anything', FlagType.boolean, false);
        expect(decision.reason, DecisionReason.stale);
        expect(decision.variant, 'default');
        expect(decision.flagMetadata, {'fireweave.stale': true});
      },
    );

    /// The concurrency-safety claim itself: a synchronous `evaluate()`
    /// returns correctly WHILE a slow prefetch is still in flight — no
    /// deadlock, no blocking, exactly what a widget's build() needs.
    test(
      'evaluate while a prefetch is in flight returns immediately',
      () async {
        final adapter = SlowFakeAdapter(
          delay: const Duration(milliseconds: 300),
          result: {
            'f': const AdapterResolution(
              found: true,
              enabled: true,
              value: true,
              reason: DecisionReason.targetingMatch,
            ),
          },
        );
        final runtime = FireweaveRuntime(
          adapter,
          config: const RuntimeConfig(flagsReadyTimeoutMs: 5000),
        );

        final initFuture = runtime.initialize();
        final readWhilePending = runtime.evaluate('f', FlagType.boolean, false);
        expect(readWhilePending.errorKind, ErrorKind.notReady);
        expect(readWhilePending.value, isFalse);

        await initFuture;
        expect(runtime.state, LifecycleState.ready);
        final readAfterReady = runtime.evaluate('f', FlagType.boolean, false);
        expect(readAfterReady.value, isTrue);
        expect(readAfterReady.reason, DecisionReason.targetingMatch);
      },
    );

    test('a late-winning prefetch after a ceiling loss is discarded', () async {
      final adapter = SlowFakeAdapter(
        delay: const Duration(milliseconds: 120),
        result: {'f': const AdapterResolution(found: true, value: true)},
      );
      final runtime = FireweaveRuntime(
        adapter,
        config: const RuntimeConfig(flagsReadyTimeoutMs: 20),
      );
      await runtime.initialize();
      expect(runtime.state, LifecycleState.stale);
      await Future<void>.delayed(const Duration(milliseconds: 250));
      // Still STALE: the loser's result never auto-heals the cache.
      expect(runtime.state, LifecycleState.stale);
      expect(
        runtime.evaluate('f', FlagType.boolean, false).reason,
        DecisionReason.stale,
      );
      // The NEXT explicit refresh is what gets a fresh attempt.
      final runtime2 = FireweaveRuntime(
        adapter,
        config: const RuntimeConfig(flagsReadyTimeoutMs: 1000),
      );
      await runtime2.initialize();
      expect(runtime2.state, LifecycleState.ready);
    });
  });
}

class _InitThrowingAdapter implements ControlPointsBackendAdapter {
  @override
  DecisionReason? get missReason => null;

  @override
  Future<void> initialize() async => throw FireweaveError.configuration(
    'invalid configuration',
    initFatal: true,
  );

  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) async => const <String, AdapterResolution>{};

  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async => const RegisterTargetResult.success();

  @override
  Future<void> shutdown() async {}
}
