@TestOn('vm')
library;

import 'dart:convert';
import 'dart:io';

import 'package:fireweave/fireweave.dart' show redactSecrets;
import 'package:test/test.dart';

/// Parity with the shared redaction contract (`contracts/errors.json`
/// `rules.redaction`, `contracts/errors.md` rule 2, start-profile SP-26):
/// [redactSecrets] must turn every vector's `in` into exactly its `out`.
File errorsContract() {
  var dir = Directory.current.absolute;
  while (true) {
    final candidate = File('${dir.path}/contracts/errors.json');
    if (candidate.existsSync()) {
      return candidate;
    }
    final parent = dir.parent;
    if (parent.path == dir.path) {
      throw StateError('contracts/errors.json not found above $dir');
    }
    dir = parent;
  }
}

void main() {
  final contract =
      jsonDecode(errorsContract().readAsStringSync()) as Map<String, Object?>;
  final redaction =
      ((contract['rules']! as Map<String, Object?>)['redaction']!
          as Map<String, Object?>);
  final vectors = (redaction['vectors']! as List<Object?>)
      .cast<Map<String, Object?>>();

  test('the contract has vectors and the [REDACTED] placeholder', () {
    expect(vectors, isNotEmpty);
    expect(redaction['placeholder'], '[REDACTED]');
  });

  for (final (index, vector) in vectors.indexed) {
    final input = vector['in']! as String;
    final output = vector['out']! as String;
    test('vector $index: $output', () {
      expect(redactSecrets(input), output, reason: input);
    });
  }
}
