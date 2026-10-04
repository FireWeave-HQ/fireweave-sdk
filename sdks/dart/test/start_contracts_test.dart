@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:fireweave/fireweave.dart' show ErrorKind, FireweaveError, Mode;
import 'package:fireweave/src/start/channel.dart';
import 'package:fireweave/src/start/client_profile.dart'
    show resolveClientStart;
import 'package:fireweave/src/start/flags.dart';
import 'package:fireweave/src/start/policy.dart';
import 'package:fireweave/src/start/server_profile.dart'
    show deriveServerInstanceKey, resolveServerStart;
import 'package:test/test.dart';

/// The shared start-profile suite (`contracts/start/`,
/// `spec/start-profile.md`) on Dart, both profiles: a `server` fixture runs
/// against the server profile's pure resolution (`resolveServerStart`, an
/// env map standing in for the process environment), a `client` fixture
/// against the client profile's (`resolveClientStart`, the case's `build`
/// values standing in for the compile-time defines). Compares by the rules
/// in `contracts/start/README.md` and writes
/// `conformance/compatibility-report.start.dart.json` (gitignored). Ported
/// from node's reference runner (`sdks/node/test/unit/start-contracts.test.ts`).
const String lang = 'dart';

/// Variable and build-value names a source may carry; anything else is an
/// option (README "Comparing results").
const Set<String> knownNames = <String>{
  'FIREWEAVE_KEY',
  'FIREWEAVE_BROWSER_KEY',
  'FIREWEAVE_URL',
  'FIREWEAVE_ENV',
  'APP_ENV',
  'FW_PROJECT_API_KEY',
  'FW_API_URL',
  'FW_ATTEST_URL',
};

Directory contractsDir() {
  var dir = Directory.current.absolute;
  while (true) {
    final candidate = Directory('${dir.path}/contracts/start');
    if (File('${candidate.path}/start-fixture.schema.json').existsSync()) {
      return candidate;
    }
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError('contracts/start not found above ${Directory.current}');
    }
    dir = parent;
  }
}

typedef Json = Map<String, Object?>;

Json asJson(Object? value) => (value as Map<Object?, Object?>).cast();

Map<String, String> stringMap(Object? value) => value == null
    ? <String, String>{}
    : asJson(value).map((k, v) => MapEntry(k, v as String));

/// `contracts/start/README.md` "Comparing results": source names are
/// normalised.
String? normaliseSource(String? source) {
  if (source == null) {
    return null;
  }
  if (source == 'none') {
    return 'none';
  }
  if (source.startsWith('SDK channel')) {
    return 'channel';
  }
  return knownNames.contains(source) ? source : 'option';
}

final class Outcome {
  Outcome({
    this.fields = const <String, Object?>{},
    this.warnings = const <String>[],
    this.errorKind,
    this.errorMessage,
  });

  final Map<String, Object?> fields;
  final List<String> warnings;
  final String? errorKind;
  final String? errorMessage;
}

Mode? parseMode(String? raw) => switch (raw) {
  null => null,
  'local' => Mode.local,
  'remote' => Mode.remote,
  // Mode is an enum here: fixtures mark other spellings appliesTo the
  // untyped SDKs.
  _ => throw StateError("mode '$raw' is not representable in $lang"),
};

Outcome runResolve(String profile, Json when) {
  final options = stringMap(when['options']);
  final channel = when['channel'] == 'staging'
      ? SdkChannel.staging
      : SdkChannel.production;
  final PolicyResult result;
  if (profile == 'client') {
    result = resolveClientStart(
      flags: const <String, Flag>{},
      mode: parseMode(options['mode']),
      environment: options['environment'],
      url: options['url'],
      key: options['key'],
      defines: stringMap(when['build']),
      channel: channel,
      sdkVersion: '0.0.0-contract',
    );
  } else {
    final env = stringMap(when['env']);
    result = resolveServerStart(
      flags: const <String, Flag>{},
      mode: parseMode(options['mode']),
      environment: options['environment'],
      url: options['url'],
      key: options['key'],
      read: (name) => env[name],
      channel: channel,
      sdkVersion: '0.0.0-contract',
    );
  }
  switch (result) {
    case PolicyFailure():
      if (profile == 'client') {
        // The client profile never throws: a failure is returned and logged.
        return Outcome(
          errorKind: ErrorKind.configuration.wireName,
          errorMessage: result.message,
        );
      }
      // The server profile throws this from Fireweave.start.
      final error = result.toError();
      return Outcome(
        errorKind: error.kind.wireName,
        errorMessage: error.message,
      );
    case PolicyOk(:final config):
      return Outcome(
        warnings: config.warnings,
        fields: <String, Object?>{
          'mode': config.mode.name,
          'modeSource': config.modeSource,
          'url': config.url,
          'urlSource': normaliseSource(config.urlSource),
          'allowedHosts': config.allowedHosts,
          'keySource': normaliseSource(config.keySource),
          'environment': config.environment,
          'environmentSource': normaliseSource(config.environmentSource),
        },
      );
  }
}

Outcome runInstanceKey(Json when) {
  final options = stringMap(when['options']);
  final env = stringMap(when['env']);
  final hostName = when['hostName'] as String?;
  final key = deriveServerInstanceKey(
    options['instanceId'],
    (name) => env[name],
    () => hostName,
  );
  return Outcome(fields: <String, Object?>{'value': key.value});
}

Outcome runDefineFlags(Json when) {
  final flags = <String, Flag>{
    for (final entry in asJson(when['flags']).entries)
      entry.key: Flag.local(
        asJson(entry.value)['local'] as bool,
        description: asJson(entry.value)['description'] as String?,
      ),
  };
  try {
    defineFlags(flags);
    return Outcome(fields: <String, Object?>{'ok': true});
  } on FireweaveError catch (error) {
    return Outcome(errorKind: error.kind.wireName, errorMessage: error.message);
  }
}

Outcome run(String profile, Json when) => switch (when['operation']) {
  'resolve' => runResolve(profile, when),
  'instanceKey' => runInstanceKey(when),
  'defineFlags' => runDefineFlags(when),
  // start-channel-rule is not-applicable here: the channel is stamped at
  // release, so there is no run-time rule to call.
  final operation => throw StateError(
    'operation $operation is not applicable to $lang',
  ),
};

/// The differences between [expect] and [out]; empty when the case passes.
List<String> compare(Json expect, Outcome out) {
  final diffs = <String>[];
  final err = expect['error'];
  if (err != null) {
    final want = asJson(err);
    final kind = want['kind'] as String;
    final message = out.errorMessage;
    if (out.errorKind == null || message == null) {
      return <String>['expected a $kind error, got ${jsonEncode(out.fields)}'];
    }
    if (out.errorKind != kind) {
      diffs.add('error kind ${out.errorKind}, expected $kind');
    }
    for (final n
        in (want['mentions'] as List<Object?>? ?? const <Object?>[])
            .cast<String>()) {
      if (!message.contains(n)) {
        diffs.add('error does not mention $n: $message');
      }
    }
    for (final n
        in (want['mustNotMention'] as List<Object?>? ?? const <Object?>[])
            .cast<String>()) {
      if (message.contains(n)) {
        diffs.add('error mentions $n');
      }
    }
    return diffs;
  }
  if (out.errorKind != null) {
    return <String>['unexpected ${out.errorKind} error: ${out.errorMessage}'];
  }
  for (final MapEntry(key: field, value: want) in expect.entries) {
    if (field == 'warnings') {
      final w = asJson(want);
      for (final n
          in (w['mention'] as List<Object?>? ?? const <Object?>[])
              .cast<String>()) {
        if (!out.warnings.any((l) => l.contains(n))) {
          diffs.add('no warning mentions $n');
        }
      }
      for (final n
          in (w['mustNotMention'] as List<Object?>? ?? const <Object?>[])
              .cast<String>()) {
        if (out.warnings.any((l) => l.contains(n))) {
          diffs.add('a warning mentions $n');
        }
      }
      continue;
    }
    if (field == 'prefix') {
      final v = (out.fields['value'] ?? '') as String;
      if (!v.startsWith(want as String)) {
        diffs.add('value $v does not start with $want');
      }
      continue;
    }
    final got = out.fields[field];
    if (field == 'allowedHosts' && want is List && got is List) {
      final a = want.cast<String>().toSet();
      final b = got.cast<String>().toSet();
      if (a.length != b.length || !a.containsAll(b)) {
        diffs.add(
          'allowedHosts ${jsonEncode(got)}, expected ${jsonEncode(want)}',
        );
      }
      continue;
    }
    if (jsonEncode(got) != jsonEncode(want)) {
      diffs.add('$field ${jsonEncode(got)}, expected ${jsonEncode(want)}');
    }
  }
  return diffs;
}

Json runFixture(Json fx) {
  final id = fx['id'] as String;
  final declared = asJson(fx['compatibility'])[lang];
  if (declared == 'not-applicable') {
    return <String, Object?>{
      'fixtureId': id,
      'status': 'not-applicable',
      'cases': const <Object?>[],
      'message': '',
    };
  }
  final profile = fx['profile'] as String;
  final cases = <Json>[];
  final failures = <String>[];
  for (final raw in fx['cases'] as List<Object?>) {
    final c = asJson(raw);
    final name = c['name'] as String;
    final appliesTo = (c['appliesTo'] as List<Object?>?)?.cast<String>();
    if (appliesTo != null && !appliesTo.contains(lang)) {
      cases.add(<String, Object?>{'name': name, 'status': 'not-applicable'});
      continue;
    }
    final diffs = compare(asJson(c['expect']), run(profile, asJson(c['when'])));
    if (diffs.isEmpty) {
      cases.add(<String, Object?>{'name': name, 'status': 'pass'});
    } else {
      final message = diffs.join('; ');
      cases.add(<String, Object?>{
        'name': name,
        'status': 'fail',
        'message': message,
      });
      failures.add('$name: $message');
    }
  }
  return <String, Object?>{
    'fixtureId': id,
    'status': failures.isEmpty ? 'pass' : 'fail',
    'cases': cases,
    'message': failures.join(' | '),
  };
}

void main() {
  final dir = contractsDir();
  final files =
      dir
          .listSync()
          .whereType<File>()
          .where(
            (f) =>
                f.path.endsWith('.json') &&
                !f.path.endsWith('/start-fixture.schema.json'),
          )
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));
  final fixtures = <Json>[
    for (final f in files) asJson(jsonDecode(f.readAsStringSync())),
  ];
  final results = <Json>[for (final fx in fixtures) runFixture(fx)];

  File(
    '${Directory.current.path}/conformance/compatibility-report.start.dart.json',
  ).writeAsStringSync(
    '${const JsonEncoder.withIndent('  ').convert(<String, Object?>{'language': lang, 'suite': 'start', 'results': results})}\n',
  );

  test('contracts/start has fixtures', () {
    expect(
      fixtures.length,
      greaterThanOrEqualTo(10),
      reason: 'expected the shared start-profile suite',
    );
  });

  for (var i = 0; i < fixtures.length; i += 1) {
    if (asJson(fixtures[i]['compatibility'])[lang] != 'pass') {
      continue;
    }
    final r = results[i];
    test('contracts/start ${r['fixtureId']}', () {
      expect(r['status'], 'pass', reason: r['message'] as String);
    });
  }
}
