@TestOn('vm')
library;

import 'dart:async';
import 'dart:io';

import 'package:fireweave/fireweave.dart' show FireweaveLocalAdapter;
import 'package:fireweave/server.dart';
import 'package:test/test.dart';

import 'support/loopback_fw_server.dart';
import 'support/start_doubles.dart';

/// The server start profile (`package:fireweave/server.dart`), driven
/// through its public API with an `env` map in place of the process
/// environment.
const String key = 'project-api-key_s3cr3tvalue';
const String url = 'https://flags.example.com';

final Map<String, LocalControlPoint> controlPoints =
    defineControlPoints(<String, LocalControlPoint>{
      'new-checkout': const LocalControlPoint.local(true),
      'dark-mode': const LocalControlPoint.local(false),
    });

Matcher throwsConfiguration(Object messageMatcher) => throwsA(
  isA<FireweaveError>()
      .having((e) => e.kind, 'kind', ErrorKind.configuration)
      .having((e) => e.openFeatureErrorCode, 'code', 'PROVIDER_FATAL')
      .having((e) => e.message, 'message', messageMatcher),
);

void main() {
  late LogCapture log;
  late RoutingTransport transport;

  setUp(() async {
    await Fireweave.debugResetForTests();
    log = LogCapture();
    transport = RoutingTransport(
      decisions: <String, Object?>{'new-checkout': true},
    );
  });

  tearDownAll(Fireweave.debugResetForTests);

  group('resolution', () {
    test(
      'FIREWEAVE_ENV=development and no key: local, serving the controlPoints',
      () async {
        await Fireweave.start(
          controlPoints: controlPoints,
          env: <String, String>{'FIREWEAVE_ENV': 'development'},
          log: log.call,
        );
        expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
        expect(fw.controlPoints.getBooleanValue('dark-mode', true), isFalse);
        expect(
          fw.controlPoints.getBooleanDetails('new-checkout', false).reason,
          DecisionReason.staticReason,
        );
        final status = fw.status;
        expect(status.state, StartState.ready);
        expect(status.mode, Mode.local);
        expect(status.modeSource, 'environment');
        expect(status.environment, 'development');
        expect(status.keySource, 'none');
        expect(status.controlPointCount, 2);
        expect(status.host, isNull);
        expect(log.containing('[fireweave:local] Local mode'), hasLength(1));
        expect(
          log.lines.single,
          contains("environment 'development' from FIREWEAVE_ENV"),
        );
      },
    );

    test('APP_ENV is the fallback; FIREWEAVE_ENV wins over it', () async {
      await Fireweave.start(
        env: <String, String>{'APP_ENV': ' Test '},
        log: log.call,
      );
      expect(fw.status.mode, Mode.local);
      expect(fw.status.environment, 'Test');
      await Fireweave.debugResetForTests();

      await expectLater(
        Fireweave.start(
          env: <String, String>{
            'FIREWEAVE_ENV': 'production',
            'APP_ENV': 'development',
          },
          log: log.call,
        ),
        throwsConfiguration(
          allOf(
            contains('FIREWEAVE_KEY is not set'),
            contains("'production' (from FIREWEAVE_ENV)"),
          ),
        ),
      );
    });

    test('the environment option wins over the environment', () async {
      await Fireweave.start(
        environment: 'local',
        env: <String, String>{'FIREWEAVE_ENV': 'production'},
        log: log.call,
      );
      expect(fw.status.mode, Mode.local);
      expect(fw.status.environment, 'local');
    });

    test(
      'no key and no environment name fails closed, then a corrected start runs',
      () async {
        await expectLater(
          Fireweave.start(env: const <String, String>{}, log: log.call),
          throwsConfiguration(
            allOf(
              contains('FIREWEAVE_KEY is not set'),
              contains('no environment name is set'),
              contains('FIREWEAVE_ENV'),
              contains('APP_ENV'),
            ),
          ),
        );
        expect(fw.status.state, StartState.notStarted);
        await Fireweave.start(
          mode: Mode.local,
          env: const <String, String>{},
          log: log.call,
        );
        expect(fw.status.state, StartState.ready);
      },
    );

    test('FW_ENV is not read; the error says to rename it', () async {
      await expectLater(
        Fireweave.start(
          env: <String, String>{'FW_ENV': 'development'},
          log: log.call,
        ),
        throwsConfiguration(
          contains('FW_ENV is no longer read; rename it to FIREWEAVE_ENV'),
        ),
      );
    });

    test(
      'FIREWEAVE_KEY means remote; the request carries it, the status never does',
      () async {
        await Fireweave.start(
          env: <String, String>{'FIREWEAVE_KEY': key, 'FIREWEAVE_URL': url},
          transport: transport,
          log: log.call,
        );
        expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
        final evaluate = transport.evaluates.single;
        expect(evaluate.url.toString(), '$url/v1/control-points/evaluate');
        expect(evaluate.headers['Authorization'], 'Bearer $key');
        expect(evaluate.body['targetingKey'], fw.instanceKey);

        final status = fw.status;
        expect(status.mode, Mode.remote);
        expect(status.modeSource, 'key');
        expect(status.keySource, 'FIREWEAVE_KEY');
        expect(status.host, 'flags.example.com');
        expect(status.endpointSource, 'FIREWEAVE_URL');
        expect(status.channel, SdkChannel.production);
        expect(status.sdkVersion, buildSdkVersion);
        expect(status.toString(), isNot(contains('s3cr3t')));
        expect(status.toJson().toString(), isNot(contains('s3cr3t')));
        expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
      },
    );

    test('without FIREWEAVE_URL the endpoint is the channel host', () async {
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_KEY': key},
        transport: transport,
        log: log.call,
      );
      expect(transport.evaluates.single.url.host, 'app-server.fireweave.ai');
      expect(fw.status.endpointSource, 'SDK channel (production)');
    });

    test('options win over the environment', () async {
      await Fireweave.start(
        key: 'project-api-key_option',
        url: 'https://option.example.com',
        env: <String, String>{'FIREWEAVE_KEY': key, 'FIREWEAVE_URL': url},
        transport: transport,
        log: log.call,
      );
      expect(
        transport.evaluates.single.headers['Authorization'],
        'Bearer project-api-key_option',
      );
      expect(fw.status.keySource, 'Fireweave.start(key:)');
      expect(fw.status.host, 'option.example.com');
    });

    test('empty and whitespace values count as unset', () async {
      await Fireweave.start(
        key: '  ',
        env: <String, String>{
          'FIREWEAVE_KEY': '',
          'FIREWEAVE_URL': ' ',
          'FIREWEAVE_ENV': 'dev',
        },
        log: log.call,
      );
      expect(fw.status.mode, Mode.local);
    });

    test(
      'legacy names are read with one warning each, after the new ones',
      () async {
        await Fireweave.start(
          env: <String, String>{'FW_PROJECT_API_KEY': key, 'FW_API_URL': url},
          transport: transport,
          log: log.call,
        );
        expect(fw.status.keySource, 'FW_PROJECT_API_KEY');
        expect(fw.status.endpointSource, 'FW_API_URL');
        expect(
          log.containing('FW_PROJECT_API_KEY is a legacy name'),
          hasLength(1),
        );
        expect(log.containing('Rename it to FIREWEAVE_KEY'), hasLength(1));
        expect(log.containing('FW_API_URL is a legacy name'), hasLength(1));
        await Fireweave.debugResetForTests();

        log = LogCapture();
        await Fireweave.start(
          env: <String, String>{
            'FIREWEAVE_KEY': key,
            'FW_PROJECT_API_KEY': 'project-api-key_legacy',
            'FW_ATTEST_URL': 'https://attest.example.com',
          },
          transport: transport,
          log: log.call,
        );
        expect(fw.status.keySource, 'FIREWEAVE_KEY');
        expect(fw.status.endpointSource, 'FW_ATTEST_URL');
        expect(log.containing('FW_PROJECT_API_KEY'), isEmpty);
        expect(log.containing('FW_ATTEST_URL is a legacy name'), hasLength(1));
      },
    );

    test(
      'Mode.local ignores a key with one warning; Mode.remote needs one',
      () async {
        await Fireweave.start(
          mode: Mode.local,
          env: <String, String>{'FIREWEAVE_KEY': key},
          log: log.call,
        );
        expect(fw.status.mode, Mode.local);
        expect(fw.status.modeSource, 'option');
        expect(
          log.containing('ignores the key from FIREWEAVE_KEY'),
          hasLength(1),
        );
        expect(transport.requests, isEmpty);
        await Fireweave.debugResetForTests();

        await expectLater(
          Fireweave.start(
            mode: Mode.remote,
            env: <String, String>{'FIREWEAVE_ENV': 'development'},
          ),
          throwsConfiguration(contains('Mode.remote needs a key')),
        );
      },
    );

    test(
      'key families are checked before any request, naming the source',
      () async {
        for (final bad in <String>[
          'fw_public_s3cr3t',
          'fw_org_s3cr3t',
          'cli_at_s3cr3t',
          '${'ph'}c_s3cr3t',
        ]) {
          await expectLater(
            Fireweave.start(
              env: <String, String>{'FIREWEAVE_KEY': bad},
              transport: transport,
            ),
            throwsConfiguration(
              allOf(contains('FIREWEAVE_KEY'), isNot(contains('s3cr3t'))),
            ),
            reason: bad,
          );
        }
        expect(transport.requests, isEmpty);
      },
    );

    test('an http endpoint off loopback is refused', () async {
      await expectLater(
        Fireweave.start(
          env: <String, String>{
            'FIREWEAVE_KEY': key,
            'FIREWEAVE_URL': 'http://flags.example.com',
          },
          transport: transport,
        ),
        throwsConfiguration(contains('FIREWEAVE_URL must use https')),
      );
    });

    test('an invalid controlPoints key throws Configuration', () async {
      await expectLater(
        Fireweave.start(
          controlPoints: <String, LocalControlPoint>{
            '': const LocalControlPoint.local(true),
          },
          env: <String, String>{'FIREWEAVE_ENV': 'dev'},
        ),
        throwsConfiguration(contains('controlPoints')),
      );
    });
  });

  group('local values', () {
    test(
      'a key missing from the control-points map gets its default and warns once',
      () async {
        await Fireweave.start(
          controlPoints: controlPoints,
          env: <String, String>{'FIREWEAVE_ENV': 'test'},
          log: log.call,
        );
        expect(fw.controlPoints.getBooleanValue('missing', true), isTrue);
        expect(fw.controlPoints.getBooleanValue('missing', false), isFalse);
        expect(
          fw.controlPoints.getBooleanDetails('missing', false).reason,
          DecisionReason.defaultReason,
        );
        final warnings = log.containing(
          "'missing' is not in your control points",
        );
        expect(warnings, hasLength(1));
        expect(warnings.single, contains('lib/fireweave/control_points.dart'));
      },
    );

    test('remote mode never serves local values', () async {
      transport.decisions = <String, Object?>{};
      await Fireweave.start(
        controlPoints: controlPoints,
        env: <String, String>{'FIREWEAVE_KEY': key},
        transport: transport,
        log: log.call,
      );
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isFalse);
      expect(
        fw.controlPoints.getBooleanDetails('new-checkout', false).errorKind,
        ErrorKind.controlPointNotFound,
      );
      expect(log.containing('not in your control points'), isEmpty);
    });
  });

  group('singleton', () {
    test('an identical second start is a no-op', () async {
      final env = <String, String>{'FIREWEAVE_KEY': key};
      await Fireweave.start(env: env, transport: transport, log: log.call);
      await Fireweave.start(
        env: env,
        transport: RoutingTransport(),
        log: (_) {},
      );
      expect(transport.evaluates, hasLength(1));
    });

    test('concurrent identical starts initialise once', () async {
      final env = <String, String>{'FIREWEAVE_KEY': key};
      await Future.wait(<Future<void>>[
        Fireweave.start(env: env, transport: transport),
        Fireweave.start(env: env, transport: transport),
      ]);
      expect(transport.evaluates, hasLength(1));
    });

    test('a different second start throws and keeps the first', () async {
      await Fireweave.start(
        controlPoints: controlPoints,
        env: <String, String>{'FIREWEAVE_ENV': 'dev'},
        log: log.call,
      );
      await expectLater(
        Fireweave.start(
          controlPoints: <String, LocalControlPoint>{
            'new-checkout': const LocalControlPoint.local(false),
          },
          env: <String, String>{'FIREWEAVE_ENV': 'dev'},
        ),
        throwsConfiguration(contains('different configuration')),
      );
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
    });

    test(
      'in remote mode the control-points map is not part of the check',
      () async {
        final env = <String, String>{'FIREWEAVE_KEY': key};
        await Fireweave.start(env: env, transport: transport);
        await Fireweave.start(
          controlPoints: controlPoints,
          env: env,
          transport: transport,
        );
        expect(transport.evaluates, hasLength(1));
      },
    );

    test('the first start keeps its log sink', () async {
      final second = LogCapture();
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_ENV': 'dev'},
        log: log.call,
      );
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_ENV': 'dev'},
        log: second.call,
      );
      fw.controlPoints.getBooleanValue('unknown-key', false);
      expect(second.lines, isEmpty);
      expect(log.containing('unknown-key'), hasLength(1));
    });

    test('changes reports starting then the settled state', () async {
      final states = <StartState>[];
      final sub = fw.changes.listen(states.add);
      await Fireweave.start(env: <String, String>{'FIREWEAVE_ENV': 'dev'});
      await pumpEventQueue();
      await sub.cancel();
      expect(states, <StartState>[StartState.starting, StartState.ready]);
    });

    test('shutdown, then a fresh start', () async {
      await Fireweave.start(
        controlPoints: controlPoints,
        env: <String, String>{'FIREWEAVE_ENV': 'dev'},
      );
      await fw.shutdown();
      expect(fw.status.state, StartState.shutdown);
      expect(fw.client, isNull);
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isFalse);
      expect(
        fw.controlPoints.getBooleanDetails('new-checkout', false).errorKind,
        ErrorKind.alreadyClosed,
      );
      await Fireweave.start(
        controlPoints: <String, LocalControlPoint>{
          'new-checkout': const LocalControlPoint.local(false),
        },
        env: <String, String>{'FIREWEAVE_ENV': 'dev'},
      );
      expect(fw.status.state, StartState.ready);
      expect(fw.controlPoints.getBooleanValue('new-checkout', true), isFalse);
    });
  });

  group('reads', () {
    test('before start: the default with NotReady, and one warning', () {
      // Before any start the default sink (print) is in use.
      final printed = <String>[];
      runZoned(
        () {
          expect(
            fw.controlPoints.getBooleanValue('new-checkout', true),
            isTrue,
          );
          final d = fw.controlPoints.getBooleanDetails('new-checkout', false);
          expect(d.value, isFalse);
          expect(d.reason, DecisionReason.error);
          expect(d.errorKind, ErrorKind.notReady);
          expect(d.errorCode, 'PROVIDER_NOT_READY');
          fw.controlPoints.getStringValue('other', 'd');
        },
        zoneSpecification: ZoneSpecification(
          print: (_, _, _, line) => printed.add(line),
        ),
      );
      expect(printed, hasLength(1));
      expect(printed.single, contains('read before Fireweave.start()'));
      expect(printed.single, contains('every isolate'));
      expect(fw.status.state, StartState.notStarted);
      expect(fw.status.mode, isNull);
      expect(fw.status.keySource, isNull);
    });

    test('before start, validation runs first', () {
      final d = fw.controlPoints.getBooleanDetails('', false);
      expect(d.errorKind, ErrorKind.controlPointNotFound);
      final t = fw.controlPoints.evaluate('k', FlagType.boolean, 'not a bool');
      expect(t.errorKind, ErrorKind.typeMismatch);
    });

    test('never throw, for any input or state', () async {
      void readAll() {
        final cp = fw.controlPoints;
        expect(cp.getBooleanValue('', true), isTrue);
        expect(cp.getStringValue('k', 'd'), 'd');
        expect(cp.getNumberValue('k', 7), 7);
        expect(
          cp.getObjectValue('k', const <String, Object?>{'a': 1}),
          <String, Object?>{'a': 1},
        );
        expect(cp.getStringDetails('k', 'd').value, 'd');
        expect(cp.getNumberDetails('k', 1).value, 1);
        expect(cp.getObjectDetails('k', null).isError, isTrue);
        expect(cp.evaluate('k', FlagType.string, 1).isError, isTrue);
      }

      readAll();
      await Fireweave.start(env: <String, String>{'FIREWEAVE_ENV': 'dev'});
      readAll();
      await fw.shutdown();
      readAll();
    });

    test('a per-call targetingKey other than the instance key serves the '
        'default with InvalidContext, and warns once', () async {
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_KEY': key},
        transport: transport,
        log: log.call,
      );
      final user = EvaluationContext(targetingKey: 'user-1');
      expect(
        fw.controlPoints.getBooleanValue('new-checkout', false, context: user),
        isFalse,
      );
      final d = fw.controlPoints.getBooleanDetails(
        'new-checkout',
        false,
        context: user,
      );
      expect(d.errorKind, ErrorKind.invalidContext);
      expect(log.containing('per-call targetingKey'), hasLength(1));

      final self = EvaluationContext(targetingKey: fw.instanceKey);
      expect(
        fw.controlPoints.getBooleanValue('new-checkout', false, context: self),
        isTrue,
      );
    });

    test('the facade is the core namespace type, with the nine methods', () {
      final ControlPointsNamespace cp = fw.controlPoints;
      expect(identical(cp, fw.controlPoints), isTrue);
    });
  });

  group('identity', () {
    test(
      'instanceKey: option, then FIREWEAVE_INSTANCE_ID, then a hash of HOSTNAME',
      () async {
        await Fireweave.start(
          env: <String, String>{
            'FIREWEAVE_ENV': 'dev',
            'HOSTNAME': 'api-pod-1',
          },
        );
        expect(fw.instanceKey, 'inst_8148fc8bb0e952ef');
        await Fireweave.debugResetForTests();

        await Fireweave.start(
          env: <String, String>{
            'FIREWEAVE_ENV': 'dev',
            'HOSTNAME': 'api-pod-1',
            'FIREWEAVE_INSTANCE_ID': 'worker-7',
          },
        );
        expect(fw.instanceKey, 'worker-7');
        await Fireweave.debugResetForTests();

        await Fireweave.start(
          instanceId: 'cron-1',
          env: <String, String>{
            'FIREWEAVE_ENV': 'dev',
            'FIREWEAVE_INSTANCE_ID': 'worker-7',
          },
        );
        expect(fw.instanceKey, 'cron-1');
      },
    );

    test('the host name of this machine gives a stable inst_ key', () async {
      await Fireweave.start(env: <String, String>{'FIREWEAVE_ENV': 'dev'});
      expect(fw.instanceKey, matches(RegExp(r'^inst_[0-9a-f]{16}$')));
      expect(fw.instanceKey, fw.instanceKey);
    });

    test('remote prefetch runs under the instance key', () async {
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_KEY': key, 'HOSTNAME': 'api-pod-1'},
        transport: transport,
      );
      expect(
        transport.evaluates.single.body['targetingKey'],
        'inst_8148fc8bb0e952ef',
      );
    });

    test(
      'an instanceId that differs from the key already handed out throws',
      () async {
        final handedOut = fw.instanceKey;
        expect(handedOut, startsWith('inst_'));
        await expectLater(
          Fireweave.start(
            instanceId: 'other',
            env: <String, String>{'FIREWEAVE_ENV': 'dev'},
          ),
          throwsConfiguration(contains('instanceId')),
        );
      },
    );

    test('identify registers a user target and never re-prefetches', () async {
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_KEY': key},
        transport: transport,
      );
      final result = await fw.identify(
        'user-1',
        properties: <String, Object?>{'plan': 'pro'},
      );
      expect(result.ok, isTrue);
      final register = transport.registers.single;
      expect(register.body, <String, Object?>{
        'targetingKey': 'user-1',
        'kind': 'user',
        'properties': <String, Object?>{'plan': 'pro'},
      });
      expect(transport.evaluates, hasLength(1));
    });

    test('identify registers even after a failed boot prefetch', () async {
      transport.evaluateStatus = 500;
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_KEY': key},
        transport: transport,
        log: log.call,
      );
      expect(fw.status.state, StartState.error);
      final result = await fw.identify('user-1');
      expect(result.ok, isTrue);
      expect(transport.registers, hasLength(1));
    });

    test('identify in local mode records the target in-process', () async {
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_ENV': 'dev'},
        log: log.call,
      );
      final result = await fw.identify('user-1', kind: TargetKind.device);
      expect(result.ok, isTrue);
      final adapter =
          fw.client!.runtime.backendAdapter as FireweaveLocalAdapter;
      expect(adapter.registeredTargets().single.targetingKey, 'user-1');
      expect(adapter.registeredTargets().single.kind, TargetKind.device);
      expect(log.containing('[fireweave:local] registerTarget'), hasLength(1));
    });

    test(
      'identify before start and with a blank key resolves a failure',
      () async {
        expect((await fw.identify('user-1')).ok, isFalse);
        await Fireweave.start(env: <String, String>{'FIREWEAVE_ENV': 'dev'});
        final blank = await fw.identify('  ');
        expect(blank.ok, isFalse);
        expect(blank.error!.kind, ErrorKind.invalidContext);
      },
    );
  });

  group('remote failures', () {
    test(
      'a 401 logs one key-rejected line naming FIREWEAVE_KEY, never the key',
      () async {
        transport.evaluateStatus = 401;
        transport.registerStatus = 401;
        await Fireweave.start(
          env: <String, String>{'FIREWEAVE_KEY': key, 'FIREWEAVE_URL': url},
          transport: transport,
          log: log.call,
        );
        await fw.identify('user-1');
        await fw.identify('user-2');
        final lines = log.containing('rejected the key');
        expect(lines, hasLength(1));
        expect(lines.single, contains('FIREWEAVE_KEY'));
        expect(lines.single, contains('flags.example.com'));
        expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
        expect(fw.status.state, StartState.error);
        expect(
          fw.status.problem,
          const StartProblem('key-rejected', variable: 'FIREWEAVE_KEY'),
        );
        expect(fw.status.lastErrorKind, ErrorKind.authentication);
        expect(
          fw.controlPoints.getBooleanDetails('new-checkout', false).errorKind,
          ErrorKind.authentication,
        );
      },
    );

    test(
      '403, 429, unreachable and malformed responses each log once',
      () async {
        final cases =
            <
              ({
                void Function(RoutingTransport) setup,
                String text,
                ErrorKind kind,
              })
            >[
              (
                setup: (t) => t.evaluateStatus = 403,
                text: 'refused the key',
                kind: ErrorKind.authorization,
              ),
              (
                setup: (t) => t.evaluateStatus = 429,
                text: 'rate-limited the key',
                kind: ErrorKind.rateLimited,
              ),
              (
                setup: (t) =>
                    t.throwOnEvaluate = FireweaveError(ErrorKind.network),
                text: 'Could not reach fw-server',
                kind: ErrorKind.network,
              ),
              (
                setup: (t) => t.evaluateBody = '<html>',
                text: 'did not answer like fw-server',
                kind: ErrorKind.malformedResponse,
              ),
            ];
        for (final c in cases) {
          await Fireweave.debugResetForTests();
          log = LogCapture();
          transport = RoutingTransport();
          c.setup(transport);
          await Fireweave.start(
            env: <String, String>{'FIREWEAVE_KEY': key},
            transport: transport,
            log: log.call,
          );
          expect(log.containing(c.text), hasLength(1), reason: c.text);
          expect(fw.status.lastErrorKind, c.kind);
          expect(log.lines.join('\n'), isNot(contains('s3cr3t')));
        }
      },
    );

    test('a fw-server that is down does not fail start', () async {
      transport.throwOnEvaluate = FireweaveError(ErrorKind.timeout);
      await Fireweave.start(
        env: <String, String>{'FIREWEAVE_KEY': key},
        transport: transport,
      );
      expect(fw.status.state, StartState.error);
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isFalse);
    });
  });

  group('over real HTTP (the owned dart:io transport)', () {
    late LoopbackFwServer server;

    setUp(() async {
      server = await LoopbackFwServer.start(
        decisions: <String, Object?>{'new-checkout': true},
      );
    });

    tearDown(() => server.close());

    test('evaluates and registers against a loopback fw-server', () async {
      await Fireweave.start(
        env: <String, String>{
          'FIREWEAVE_KEY': key,
          'FIREWEAVE_URL': server.url,
          'HOSTNAME': 'api-pod-1',
        },
        log: log.call,
      );
      expect(fw.status.state, StartState.ready);
      expect(fw.status.host, '127.0.0.1');
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);
      expect((await fw.identify('user-1')).ok, isTrue);
      expect(server.requests.map((r) => r.path), <String>[
        '/v1/control-points/evaluate',
        '/v1/targets/register',
      ]);
      expect(server.requests.first.authorization, 'Bearer $key');
      expect(
        server.requests.first.body['targetingKey'],
        'inst_8148fc8bb0e952ef',
      );
      await fw.shutdown();
      expect(fw.status.state, StartState.shutdown);
    });

    test(
      'a 401 over the wire logs key-rejected once and reads serve defaults',
      () async {
        server.status = 401;
        await Fireweave.start(
          env: <String, String>{
            'FIREWEAVE_KEY': key,
            'FIREWEAVE_URL': server.url,
          },
          log: log.call,
        );
        expect(
          fw.controlPoints.getBooleanValue('new-checkout', false),
          isFalse,
        );
        expect(
          log.containing('rejected the key from FIREWEAVE_KEY'),
          hasLength(1),
        );
        await fw.shutdown();
      },
    );
  });

  group('periodic refresh (over real HTTP)', () {
    late LoopbackFwServer server;

    setUp(() async {
      server = await LoopbackFwServer.start(
        decisions: <String, Object?>{'new-checkout': true},
      );
    });

    tearDown(() async {
      await Fireweave.debugResetForTests();
      await server.close();
    });

    Map<String, String> remoteEnv() => <String, String>{
      'FIREWEAVE_KEY': key,
      'FIREWEAVE_URL': server.url,
    };

    int evaluates() => server.requests
        .where((r) => r.path == '/v1/control-points/evaluate')
        .length;

    test('re-fetches on the interval and swaps in new decisions', () async {
      await Fireweave.start(
        env: remoteEnv(),
        log: log.call,
        refreshInterval: const Duration(milliseconds: 40),
      );
      expect(fw.controlPoints.getBooleanValue('new-checkout', false), isTrue);

      server.decisions = <String, Object?>{'new-checkout': false};
      await until(() => evaluates() >= 3);
      final details = fw.controlPoints.getBooleanDetails('new-checkout', true);
      expect(details.value, isFalse);
      expect(details.reason, DecisionReason.targetingMatch);
      expect(fw.status.state, StartState.ready);
    });

    test('a failed re-fetch keeps the last good decisions as STALE, logs '
        'once, and the next success replaces them', () async {
      await Fireweave.start(
        env: remoteEnv(),
        log: log.call,
        refreshInterval: const Duration(milliseconds: 40),
      );
      expect(fw.status.state, StartState.ready);

      server.status = 503;
      server.decisions = <String, Object?>{'new-checkout': false};
      final before = evaluates();
      await until(() => evaluates() >= before + 2);
      await until(() => fw.status.state == StartState.stale);
      final stale = fw.controlPoints.getBooleanDetails('new-checkout', false);
      expect(stale.value, isTrue);
      expect(stale.reason, DecisionReason.stale);
      expect(stale.errorKind, isNull);
      expect(fw.status.lastErrorKind, ErrorKind.backendUnavailable);
      expect(fw.status.toJson()['lastErrorKind'], 'BackendUnavailable');
      expect(
        fw.status.problem,
        const StartProblem('unreachable', variable: 'FIREWEAVE_URL'),
      );
      final lines = log.containing('Could not reach fw-server');
      expect(lines, hasLength(1));
      expect(lines.single, contains('last decisions fetched'));
      expect(log.lines.join('\n'), isNot(contains('s3cr3t')));

      server.status = 200;
      await until(() => fw.status.state == StartState.ready);
      final fresh = fw.controlPoints.getBooleanDetails('new-checkout', true);
      expect(fresh.value, isFalse);
      expect(fresh.reason, DecisionReason.targetingMatch);
      expect(fw.status.problem, isNull);
      expect(fw.status.lastErrorKind, ErrorKind.backendUnavailable);
    });

    test('Duration.zero turns the re-fetch off', () async {
      await Fireweave.start(env: remoteEnv(), refreshInterval: Duration.zero);
      await Future<void>.delayed(const Duration(milliseconds: 150));
      expect(evaluates(), 1);
    });

    test('fw.shutdown() stops the re-fetch', () async {
      await Fireweave.start(
        env: remoteEnv(),
        refreshInterval: const Duration(milliseconds: 30),
      );
      await until(() => evaluates() >= 2);
      await fw.shutdown();
      final atShutdown = evaluates();
      await Future<void>.delayed(const Duration(milliseconds: 150));
      expect(evaluates(), atShutdown);
      expect(fw.status.state, StartState.shutdown);
    });

    test(
      'a program that calls fw.shutdown() exits promptly despite the default '
      '30 s re-fetch',
      () async {
        final run = await runExitFixture(<String>[
          'remote',
          server.url,
          'shutdown',
        ]);
        expect(run.stdout.trim(), 'true');
        expect(run.exitCode, 0);
        expect(run.elapsed, lessThan(const Duration(seconds: 20)));
      },
      timeout: const Timeout(Duration(seconds: 60)),
    );

    test(
      'local mode never re-fetches: a program exits without shutdown',
      () async {
        final run = await runExitFixture(<String>['local', 'no-shutdown']);
        expect(run.stdout.trim(), 'true');
        expect(run.exitCode, 0);
        expect(server.requests, isEmpty);
      },
      timeout: const Timeout(Duration(seconds: 60)),
    );
  });
}

/// Polls [condition] every 5 ms; fails after [timeout].
Future<void> until(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(deadline)) {
      fail('condition not met within $timeout');
    }
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
}

/// Runs `test/support/server_exit_fixture.dart` in a fresh VM and reports how
/// long it took to exit. A VM still alive after 20 s is killed: the caller's
/// elapsed-time expectation then fails instead of the test hanging.
Future<({int exitCode, String stdout, Duration elapsed})> runExitFixture(
  List<String> args,
) async {
  final stopwatch = Stopwatch()..start();
  final process = await Process.start(Platform.resolvedExecutable, <String>[
    'run',
    'test/support/server_exit_fixture.dart',
    ...args,
  ]);
  final out = process.stdout.transform(const SystemEncoding().decoder).join();
  final err = process.stderr.transform(const SystemEncoding().decoder).join();
  final killer = Timer(const Duration(seconds: 20), process.kill);
  final exitCode = await process.exitCode;
  killer.cancel();
  stopwatch.stop();
  final stdoutText = await out;
  final stderrText = await err;
  if (exitCode != 0 && stderrText.isNotEmpty) {
    printOnFailure(stderrText);
  }
  return (exitCode: exitCode, stdout: stdoutText, elapsed: stopwatch.elapsed);
}
