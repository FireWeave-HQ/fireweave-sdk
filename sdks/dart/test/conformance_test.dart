@TestOn('vm')
library;

import 'dart:io';

import 'package:test/test.dart';

import '../conformance/runner.dart';

/// `dart test` gate over the shared 65 fixtures — the same wrapper python
/// (`tests/test_conformance.py`) and go (`conformance/harness_test.go`) carry,
/// so a per-language `verify` is green only when the fixture run is. The
/// report-writing CLI (`conformance/run_conformance.dart`) is what
/// `scripts/conformance-all.sh` aggregates; this test pins the exact
/// disposition the runner's doc comment claims.
void main() {
  final contracts = Directory('${Directory.current.path}/../../contracts');

  test('contracts/ is present (run from sdks/dart)', () {
    expect(
      contracts.existsSync(),
      isTrue,
      reason: 'contracts not found at ${contracts.absolute.path}',
    );
  });

  test(
    'all 65 fixtures: 37 pass, 15 documented limitations, 13 v1 out of scope, 0 fail',
    () async {
      final report = await runAll(contracts);
      final failures = report.results.where((r) => r.status == Status.fail);
      expect(
        failures.map((r) => '${r.fixtureId}: ${r.message}').toList(),
        isEmpty,
      );

      final summary = report.summary();
      expect(report.results, hasLength(65));
      expect(summary[Status.fail], 0);
      expect(summary[Status.pass], 37);
      expect(summary[Status.skippedWithDocumentedLimitation], 15);
      expect(summary[Status.skippedV1OutOfScope], 13);

      for (final row in report.results) {
        if (row.status == Status.skippedWithDocumentedLimitation ||
            row.status == Status.skippedV1OutOfScope) {
          expect(row.limitation, isNotEmpty, reason: row.fixtureId);
        }
      }
    },
  );
}
