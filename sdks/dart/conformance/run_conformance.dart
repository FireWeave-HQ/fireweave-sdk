import 'dart:convert';
import 'dart:io';

import 'runner.dart';

/// CLI entry point: run the `contracts/` fixtures this SDK's architecture
/// can represent and emit the compatibility report (`contracts/README.md`
/// schema — the same shape node/python/go/java/rust/swift write).
///
/// Usage (from `sdks/dart`):
///
///     dart run conformance/run_conformance.dart \
///       --contracts ../../contracts \
///       --out conformance/compatibility-report.dart.json
///
/// Exit code is non-zero when any fixture fails (`contracts/harness.md`
/// runner obligation 6).
Future<void> main(List<String> args) async {
  var contracts = '../../contracts';
  var out = 'conformance/compatibility-report.dart.json';
  for (var i = 0; i < args.length; i += 1) {
    switch (args[i]) {
      case '--contracts':
        i += 1;
        if (i >= args.length) {
          _die('--contracts requires a path');
        }
        contracts = args[i];
      case '--out':
        i += 1;
        if (i >= args.length) {
          _die('--out requires a path');
        }
        out = args[i];
      default:
        _die('unknown argument ${args[i]}');
    }
  }

  final contractsDir = Directory(contracts);
  if (!contractsDir.existsSync()) {
    _die('contracts directory not found: ${contractsDir.absolute.path}');
  }

  final report = await runAll(contractsDir);

  final outFile = File(out);
  outFile.parent.createSync(recursive: true);
  const encoder = JsonEncoder.withIndent('  ');
  outFile.writeAsStringSync('${encoder.convert(_sorted(report.toJson()))}\n');

  final summary = report.summary();
  stdout.writeln(
    'conformance[$language]: ${summary[Status.pass]} passed, '
    '${summary[Status.fail]} failed, '
    '${summary[Status.skippedWithDocumentedLimitation]} '
    'skipped-with-documented-limitation, '
    '${summary[Status.skippedV1OutOfScope]} skipped-v1-out-of-scope '
    '(report: $out)',
  );

  if ((summary[Status.fail] ?? 0) > 0) {
    for (final row in report.results.where((r) => r.status == Status.fail)) {
      stdout.writeln(
        '  FAIL ${row.suite}/${row.fixtureId}'
        '${row.message == null ? '' : ' - ${row.message}'}',
      );
    }
    exit(1);
  }
}

Never _die(String message) {
  stderr.writeln('run_conformance: $message');
  exit(2);
}

/// Sorted keys at every level, for a byte-stable report (mirrors swift's
/// `.sortedKeys` and go/python's canonical JSON).
Object? _sorted(Object? value) {
  if (value is Map) {
    final keys = value.keys.map((k) => k.toString()).toList()..sort();
    return <String, Object?>{for (final key in keys) key: _sorted(value[key])};
  }
  if (value is List) {
    return value.map(_sorted).toList();
  }
  return value;
}
