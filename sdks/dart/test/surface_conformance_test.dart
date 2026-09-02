@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:fireweave/fireweave.dart';
import 'package:test/test.dart';

/// Control-point SURFACE parity (`spec/control-points.md`,
/// `conformance/surface/`).
///
/// Behaviour is asserted elsewhere (`runtime_test`, `client_test`, ...);
/// this file asserts the surface EXISTS — a missing method is invisible
/// otherwise (go once shipped `client.Flags()` with no `ControlPoints`
/// namespace, unnoticed for months, because nothing structurally forced
/// independent implementations to agree).
Map<String, Object?> loadDescriptor() {
  final path =
      '${Directory.current.path}/../../conformance/surface/control-points.surface.json';
  final file = File(path);
  if (!file.existsSync()) {
    fail('surface descriptor not found at $path — run tests from sdks/dart');
  }
  return (jsonDecode(file.readAsStringSync()) as Map).cast<String, Object?>();
}

FireweaveClient testClient() =>
    FireweaveClient(FireweaveRuntime(InMemoryAdapter()));

void main() {
  final descriptor = loadDescriptor();
  final namespace = (descriptor['namespace'] as Map).cast<String, Object?>();
  final methods = (descriptor['methods'] as List).cast<Map<Object?, Object?>>();
  final client = (descriptor['client'] as Map).cast<String, Object?>();
  final compatibility = (descriptor['compatibility'] as Map)
      .cast<String, Object?>();

  test('namespace casing is controlPoints per the descriptor', () {
    final casing = (namespace['casing'] as Map).cast<String, Object?>();
    expect(casing['dart'], 'controlPoints');
    final ControlPointsNamespace ns = testClient().controlPoints;
    expect(ns, isNotNull);
  });

  test('nine methods match the descriptor arity', () {
    expect(methods, hasLength(9));
    const expectedArities = <String, int>{
      'getBooleanValue': 3,
      'getStringValue': 3,
      'getNumberValue': 3,
      'getObjectValue': 3,
      'getBooleanDetails': 3,
      'getStringDetails': 3,
      'getNumberDetails': 3,
      'getObjectDetails': 3,
      'evaluate': 5,
    };
    final offenders = <String>[];
    for (final method in methods) {
      final name = method['name'] as String;
      final args = (method['args'] as List).length;
      final expected = expectedArities[name];
      if (expected == null) {
        offenders.add('$name: not one of the recognized nine');
      } else if (args != expected) {
        offenders.add(
          '$name: descriptor declares $args args, expected $expected',
        );
      }
    }
    expect(offenders, isEmpty);
  });

  /// The compile-time half of the arity proof: a signature drift here fails
  /// the whole file to BUILD, a strictly stronger guarantee than a runtime
  /// assertion (same reasoning as rust/swift).
  test('nine methods are callable at the pinned arity', () async {
    final fw = testClient();
    await fw.initialize();
    final cp = fw.controlPoints;
    final ctx = EvaluationContext(targetingKey: 't');

    final bool b = cp.getBooleanValue('k', false, context: ctx);
    final String s = cp.getStringValue('k', 'd', context: ctx);
    final num n = cp.getNumberValue('k', 0, context: ctx);
    final Object? o = cp.getObjectValue(
      'k',
      const <String, Object?>{},
      context: ctx,
    );
    final Decision d1 = cp.getBooleanDetails('k', false, context: ctx);
    final Decision d2 = cp.getStringDetails('k', 'd', context: ctx);
    final Decision d3 = cp.getNumberDetails('k', 0, context: ctx);
    final Decision d4 = cp.getObjectDetails(
      'k',
      const <String, Object?>{},
      context: ctx,
    );
    final Decision d5 = cp.evaluate(
      'k',
      FlagType.boolean,
      false,
      context: ctx,
      options: const EvaluateOptions(),
    );
    expect([b, s, n, o, d1, d2, d3, d4, d5], hasLength(9));
  });

  test('the deprecated flags alias shares identity with controlPoints', () {
    expect(namespace['deprecatedAlias'], 'flags');
    expect(namespace['aliasMustShareIdentity'], isTrue);
    final fw = testClient();
    // ignore: deprecated_member_use_from_same_package
    expect(identical(fw.flags, fw.controlPoints), isTrue);
  });

  test('registerTarget exists with local mode recorded-and-traced', () async {
    final entries = (client['methods'] as List).cast<Map<Object?, Object?>>();
    final entry = entries.firstWhere((m) => m['name'] == 'registerTarget');
    expect(entry['localMode'], 'recorded-and-traced');

    final fw = await initFireweave(InitFireweaveOptions.local(log: (_) {}));
    final result = await fw.registerTarget('user_1');
    expect(result.ok, isTrue);
  });

  test('mustNotExpose list matches the fixed v1 scope boundary', () {
    expect(client['mustNotExpose'], <String>[
      'releases',
      'exposures',
      'signals',
      'capabilities',
      'guardrails',
      'FireweaveProvider',
      'FireweaveWebProvider',
    ]);
  });

  test('cut namespaces and provider types are absent from lib/', () {
    final lib = Directory('${Directory.current.path}/lib');
    final haystack = lib
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .map((f) => f.readAsStringSync())
        .join('\n');
    const forbidden = <String>[
      'get releases',
      'get exposures',
      'get signals',
      'get capabilities',
      'get guardrails',
      'class Releases',
      'class Exposures',
      'class Signals',
      'class Capabilities',
      'class Guardrails',
      'class FireweaveProvider',
      'class FireweaveWebProvider',
      'class OpenFeature',
      'implements OpenFeature',
      'OpenFeatureProvider',
    ];
    final offenders = forbidden.where(haystack.contains).toList();
    expect(
      offenders,
      isEmpty,
      reason: 'v1 scope violation — found item-definition shapes',
    );
  });

  test('compatibility cell is green for dart', () {
    expect(compatibility['dart'], 'green');
  });
}
