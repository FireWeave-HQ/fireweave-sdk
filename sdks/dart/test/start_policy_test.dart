import 'package:fireweave/fireweave.dart';
import 'package:fireweave/src/start/channel.dart';
import 'package:fireweave/src/start/control_points.dart';
import 'package:fireweave/src/start/policy.dart';
import 'package:test/test.dart';

/// The pure resolver both profiles share: mode rule, key families, URL
/// rules. The profile tests drive the same rules through each profile's
/// own sources (defines on clients, the environment on servers).
PolicyResult resolve(
  StartProfile profile, {
  Mode? mode,
  Sourced? key,
  Sourced? url,
  Sourced? environment,
  SdkChannel channel = SdkChannel.production,
}) => resolvePolicy(
  PolicyInput(
    profile: profile,
    mode: mode,
    key: key,
    url: url,
    environment: environment,
    controlPoints: const <String, LocalControlPoint>{},
    channel: channel,
    sdkVersion: '0.0.0-test',
    environmentChecked: 'the test sources',
  ),
);

ResolvedStart ok(PolicyResult r) {
  if (r is PolicyFailure) {
    fail('expected a config, got ${r.reason}: ${r.message}');
  }
  return (r as PolicyOk).config;
}

PolicyFailure failed(PolicyResult r) {
  if (r is PolicyOk) {
    fail('expected a failure, got mode ${r.config.mode}');
  }
  return r as PolicyFailure;
}

final String vendorKey = <String>['ph', 'x_', 'notarealkey123'].join();

void main() {
  const browserKey = Sourced('fw_public_abc123', 'FIREWEAVE_BROWSER_KEY');
  const serverKey = Sourced('project-api-key_abc123', 'FIREWEAVE_KEY');

  group('mode rule (both profiles)', () {
    for (final profile in StartProfile.values) {
      final key = profile == StartProfile.client ? browserKey : serverKey;

      test('${profile.name}: explicit local ignores a key, with a warning', () {
        final c = ok(resolve(profile, mode: Mode.local, key: key));
        expect(c.mode, Mode.local);
        expect(c.modeSource, 'option');
        expect(c.keySource, 'none');
        expect(c.key, isNull);
        expect(c.warnings, hasLength(1));
        expect(
          c.warnings.single,
          contains('ignores the key from ${key.source}'),
        );
        expect(c.warnings.single, isNot(contains(key.value)));
      });

      test('${profile.name}: explicit local needs nothing else', () {
        final c = ok(resolve(profile, mode: Mode.local));
        expect(c.mode, Mode.local);
        expect(c.warnings, isEmpty);
      });

      test('${profile.name}: explicit remote with a key', () {
        final c = ok(resolve(profile, mode: Mode.remote, key: key));
        expect(c.mode, Mode.remote);
        expect(c.modeSource, 'option');
        expect(c.keySource, key.source);
      });

      test('${profile.name}: explicit remote without a key fails', () {
        final f = failed(resolve(profile, mode: Mode.remote));
        expect(f.reason, 'missing-key');
        expect(f.message, contains(profile.keyVariable));
        final error = f.toError();
        expect(error.kind, ErrorKind.configuration);
        expect(error.openFeatureErrorCode, 'PROVIDER_FATAL');
      });

      test('${profile.name}: a key means remote', () {
        final c = ok(resolve(profile, key: key));
        expect(c.mode, Mode.remote);
        expect(c.modeSource, 'key');
        expect(c.key, key.value);
      });

      for (final name in <String>['development', 'DEV', 'Local', 'test']) {
        test('${profile.name}: no key and environment "$name" means local', () {
          final c = ok(
            resolve(profile, environment: Sourced(name, 'FIREWEAVE_ENV')),
          );
          expect(c.mode, Mode.local);
          expect(c.modeSource, 'environment');
          expect(c.environment, name);
          expect(c.environmentSource, 'FIREWEAVE_ENV');
        });
      }

      for (final name in <String>['production', 'staging', 'profile']) {
        test(
          '${profile.name}: no key and environment "$name" fails closed',
          () {
            final f = failed(
              resolve(profile, environment: Sourced(name, 'FIREWEAVE_ENV')),
            );
            expect(f.reason, 'missing-key');
            expect(f.variable, profile.keyVariable);
            expect(f.message, contains('${profile.keyVariable} is not set'));
            expect(f.message, contains("'$name' (from FIREWEAVE_ENV)"));
          },
        );
      }

      test('${profile.name}: no key and no environment fails closed', () {
        final f = failed(resolve(profile));
        expect(f.reason, 'missing-key');
        expect(f.message, contains('no environment name is set'));
      });

      test('${profile.name}: an environment value that looks like a key is '
          'not echoed', () {
        final f = failed(
          resolve(
            profile,
            environment: const Sourced('project-api-key_leak', 'APP_ENV'),
          ),
        );
        expect(f.message, isNot(contains('project-api-key_leak')));
        expect(f.message, contains('APP_ENV'));
      });
    }
  });

  group('key families', () {
    test('client: only fw_public_ keys', () {
      expect(
        ok(resolve(StartProfile.client, key: browserKey)).mode,
        Mode.remote,
      );

      final server = failed(
        resolve(
          StartProfile.client,
          key: const Sourced('project-api-key_s3cr3t', 'FIREWEAVE_BROWSER_KEY'),
        ),
      );
      expect(server.reason, 'server-key');
      expect(server.message, contains('revoke'));
      expect(server.message, contains('FIREWEAVE_BROWSER_KEY'));

      for (final bad in <String>[
        vendorKey,
        'fw_org_s3cr3t',
        'cli_at_s3cr3t',
        'fw_ingest_pub_s3cr3t',
        '"fw_public_quoted"',
      ]) {
        final f = failed(
          resolve(
            StartProfile.client,
            key: Sourced(bad, 'Fireweave.start(key:)'),
          ),
        );
        expect(f.reason, 'wrong-key-family', reason: bad);
        expect(f.variable, 'Fireweave.start(key:)');
        expect(f.message, contains('Fireweave.start(key:)'));
      }
    });

    test('server: browser, vendor, org and CLI keys are refused', () {
      expect(
        ok(resolve(StartProfile.server, key: serverKey)).mode,
        Mode.remote,
      );
      for (final bad in <String>[
        'fw_public_s3cr3t',
        vendorKey,
        'fw_org_s3cr3t',
        'cli_at_s3cr3t',
      ]) {
        final f = failed(
          resolve(StartProfile.server, key: Sourced(bad, 'FIREWEAVE_KEY')),
        );
        expect(f.reason, 'wrong-key-family', reason: bad);
        expect(f.message, contains('FIREWEAVE_KEY'));
      }
    });

    test('messages name the source, never the value', () {
      final values = <String>[
        'project-api-key_s3cr3t',
        vendorKey,
        'fw_org_s3cr3t',
        'cli_at_s3cr3t',
        'fw_public_s3cr3t',
      ];
      for (final profile in StartProfile.values) {
        for (final value in values) {
          final r = resolve(profile, key: Sourced(value, 'SOME_SOURCE'));
          if (r is PolicyFailure) {
            expect(r.message, isNot(contains('s3cr3t')));
            expect(r.message, isNot(contains('notarealkey123')));
            expect(r.toError().message, isNot(contains('s3cr3t')));
          }
        }
      }
    });
  });

  group('endpoint', () {
    test('defaults to the channel host with the core allowlist', () {
      final prod = ok(resolve(StartProfile.server, key: serverKey));
      expect(prod.url, 'https://app-server.fireweave.ai');
      expect(prod.urlSource, 'SDK channel (production)');
      expect(prod.allowedHosts, isNull);
      expect(prod.host, 'app-server.fireweave.ai');

      final staging = ok(
        resolve(
          StartProfile.client,
          key: browserKey,
          channel: SdkChannel.staging,
        ),
      );
      expect(staging.url, 'https://staging-app-server.fireweave.ai');
      expect(staging.urlSource, 'SDK channel (staging)');
    });

    test('an https override gets its own host plus loopback', () {
      final c = ok(
        resolve(
          StartProfile.server,
          key: serverKey,
          url: const Sourced('https://Flags.Example.com/', 'FIREWEAVE_URL'),
        ),
      );
      expect(c.url, 'https://Flags.Example.com');
      expect(c.urlSource, 'FIREWEAVE_URL');
      expect(c.allowedHosts, <String>[
        'flags.example.com',
        'localhost',
        '127.0.0.1',
        '::1',
      ]);
      expect(
        () => assertHostAllowed(
          c.url!,
          allowedHosts: c.allowedHosts,
          initFatal: true,
        ),
        returnsNormally,
      );
    });

    test('http is allowed on loopback only', () {
      for (final url in <String>[
        'http://localhost:8080',
        'http://127.0.0.1:9',
        'http://[::1]:3000',
      ]) {
        final c = ok(
          resolve(
            StartProfile.client,
            key: browserKey,
            url: Sourced(url, 'FIREWEAVE_URL'),
          ),
        );
        expect(c.url, url);
        expect(
          c.allowedHosts!.first,
          isIn(<String>['localhost', '127.0.0.1', '::1']),
        );
      }
      for (final url in <String>[
        'http://flags.example.com',
        'http://10.0.2.2:8080',
        'ftp://flags.example.com',
        'flags.example.com',
        'not a url',
      ]) {
        final f = failed(
          resolve(
            StartProfile.server,
            key: serverKey,
            url: Sourced(url, 'FIREWEAVE_URL'),
          ),
        );
        expect(f.reason, 'insecure-url', reason: url);
        expect(f.variable, 'FIREWEAVE_URL');
        expect(f.message, contains('FIREWEAVE_URL'));
      }
    });

    test('local mode never resolves an endpoint', () {
      final c = ok(
        resolve(
          StartProfile.server,
          mode: Mode.local,
          url: const Sourced('http://bad.example.com', 'FIREWEAVE_URL'),
        ),
      );
      expect(c.url, isNull);
      expect(c.host, isNull);
    });
  });

  group('sourced / firstOf', () {
    test('empty and whitespace values are unset; values are trimmed', () {
      expect(sourced(null, 'X'), isNull);
      expect(sourced('', 'X'), isNull);
      expect(sourced('   ', 'X'), isNull);
      expect(sourced(' v ', 'X')!.value, 'v');
      expect(
        firstOf(<Sourced?>[null, sourced(' ', 'A'), sourced('b', 'B')])!.source,
        'B',
      );
    });
  });

  group('controlPoints', () {
    test(
      'defineControlPoints validates keys with the core rule and copies',
      () {
        final input = <String, LocalControlPoint>{
          'b': const LocalControlPoint.local(false),
          'a': const LocalControlPoint.local(true),
        };
        final controlPoints = defineControlPoints(input);
        expect(controlPoints.keys, <String>['a', 'b']);
        expect(controlPoints['a']!.localValue, isTrue);
        expect(
          () => controlPoints['c'] = const LocalControlPoint.local(true),
          throwsUnsupportedError,
        );
        expect(localSeeds(controlPoints), <String, bool>{
          'a': true,
          'b': false,
        });
      },
    );

    test('an invalid key throws Configuration naming it', () {
      expect(
        () => defineControlPoints(<String, LocalControlPoint>{
          '': const LocalControlPoint.local(true),
        }),
        throwsA(
          isA<FireweaveError>()
              .having((e) => e.kind, 'kind', ErrorKind.configuration)
              .having((e) => e.message, 'message', contains('controlPoints')),
        ),
      );
      expect(
        () => defineControlPoints(<String, LocalControlPoint>{
          'bad\nkey': const LocalControlPoint.local(true),
        }),
        throwsA(isA<FireweaveError>()),
      );
      expect(
        () => defineControlPoints(<String, LocalControlPoint>{
          'k' * 257: const LocalControlPoint.local(true),
        }),
        throwsA(isA<FireweaveError>()),
      );
    });

    test(
      'LocalControlPoint carries an optional description and compares by value',
      () {
        const flag = LocalControlPoint.local(true, description: 'New checkout');
        expect(flag.description, 'New checkout');
        expect(
          flag,
          const LocalControlPoint.local(true, description: 'New checkout'),
        );
        expect(
          flag,
          isNot(
            const LocalControlPoint.local(false, description: 'New checkout'),
          ),
        );
      },
    );
  });
}
