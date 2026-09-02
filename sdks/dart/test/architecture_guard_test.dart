@TestOn('vm')
library;

import 'dart:io';

import 'package:test/test.dart';

/// Architecture guard (`spec/control-points.md` + `spec/modes.md`, "same
/// layering" as the other reference SDKs):
///
/// - the SDK's dependency budget stays LITERALLY ZERO (`pubspec.yaml` has
///   no `dependencies:` entries) and carries no `flutter` SDK dependency;
/// - `lib/src/domain/` stays pure — imports nothing from `application/` or
///   `infrastructure/`;
/// - `lib/src/application/` imports `infrastructure/` only through the one
///   sanctioned seam, `init_fireweave.dart` (the composition root);
/// - `lib/src/infrastructure/` depends on `application/` only through the
///   port file (`ports.dart`), never on the runtime/client/entry point.
///
/// Dart has real per-file `import` directives, so — like rust's
/// `tests/architecture_guard.rs` and unlike swift, which had to scan for
/// concrete type names — this guard scans import statements.
final Directory packageRoot = Directory.current;

List<File> dartFilesUnder(String relative) {
  final dir = Directory('${packageRoot.path}/$relative');
  return dir
      .listSync(recursive: true)
      .whereType<File>()
      .where((f) => f.path.endsWith('.dart'))
      .toList()
    ..sort((a, b) => a.path.compareTo(b.path));
}

final RegExp _importLine = RegExp(
  r'''^\s*(import|export)\s+['"]([^'"]+)['"]''',
  multiLine: true,
);

List<String> importsOf(File file) => _importLine
    .allMatches(file.readAsStringSync())
    .map((m) => m.group(2)!)
    .toList();

void main() {
  test('pubspec declares zero runtime dependencies and no flutter SDK dep', () {
    final pubspec = File('${packageRoot.path}/pubspec.yaml').readAsStringSync();
    final lines = pubspec.split('\n');

    // A top-level `dependencies:` block, if present at all, must carry no
    // entries (its following indented, non-comment lines must be empty).
    final depsIndex = lines.indexWhere(
      (l) => RegExp(r'^dependencies:').hasMatch(l),
    );
    if (depsIndex != -1) {
      final entries = <String>[];
      for (final line in lines.skip(depsIndex + 1)) {
        if (line.trim().isEmpty || line.trim().startsWith('#')) {
          continue;
        }
        if (!line.startsWith(' ')) {
          break; // next top-level key
        }
        entries.add(line.trim());
      }
      expect(
        entries,
        isEmpty,
        reason:
            'pubspec.yaml dependencies must be empty (zero-dependency '
            'budget): $entries',
      );
    }
    expect(
      pubspec,
      isNot(contains('sdk: flutter')),
      reason:
          'no flutter SDK dependency — the package must run on the '
          'Dart VM and need only the Dart toolchain in CI',
    );
    expect(
      RegExp(r'^environment:\s*\n\s+sdk:', multiLine: true).hasMatch(pubspec),
      isTrue,
      reason: 'pubspec must pin an SDK floor',
    );
  });

  test('domain/ imports nothing from application/ or infrastructure/', () {
    final files = dartFilesUnder('lib/src/domain');
    expect(files, isNotEmpty);
    final offenders = <String>[];
    for (final file in files) {
      for (final import in importsOf(file)) {
        if (import.contains('application/') ||
            import.contains('infrastructure/') ||
            import.startsWith('package:')) {
          offenders.add('${file.path}: $import');
        }
      }
    }
    expect(
      offenders,
      isEmpty,
      reason: 'domain/ must not depend on outer layers or packages',
    );
  });

  const compositionRoot = 'init_fireweave.dart';

  test(
    'application/ (outside the composition root) never imports infrastructure/',
    () {
      final files = dartFilesUnder(
        'lib/src/application',
      ).where((f) => !f.path.endsWith(compositionRoot));
      final offenders = <String>[];
      for (final file in files) {
        for (final import in importsOf(file)) {
          if (import.contains('infrastructure/')) {
            offenders.add('${file.path}: $import');
          }
        }
      }
      expect(offenders, isEmpty);
    },
  );

  test(
    'the composition root is load-bearing (it does import infrastructure/)',
    () {
      final root = File(
        '${packageRoot.path}/lib/src/application/$compositionRoot',
      );
      expect(
        importsOf(root).any((i) => i.contains('infrastructure/')),
        isTrue,
        reason:
            '$compositionRoot is exempted as the composition root but '
            'imports no infrastructure file — the exemption is stale',
      );
    },
  );

  test('infrastructure/ reaches application/ only through ports.dart', () {
    final files = dartFilesUnder('lib/src/infrastructure');
    expect(files, isNotEmpty);
    final offenders = <String>[];
    for (final file in files) {
      for (final import in importsOf(file)) {
        if (import.contains('application/') && !import.endsWith('ports.dart')) {
          offenders.add('${file.path}: $import');
        }
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          'infrastructure/ must depend on the port only, never on the '
          'runtime/client/entry point',
    );
  });
}
