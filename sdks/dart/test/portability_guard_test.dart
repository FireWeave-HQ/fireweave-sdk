@TestOn('vm')
library;

import 'dart:io';

import 'package:test/test.dart';

/// Portability + security posture, pinned by tests rather than by review
/// (the mirror of web's `browser-portability.test.ts` and node's
/// `runtime-portability.test.ts`):
///
/// - `dart:io` is imported by exactly one file, the io transport, and
///   `dart:js_interop` by exactly one file, the web transport — so the
///   conditional export in `default_http_transport.dart` is the ONLY
///   platform seam, and everything else compiles for every Dart target;
/// - the retired browser libraries (`dart:html`, `dart:js`, `dart:js_util`)
///   and the pub alternatives (`package:web`, `package:http`) appear nowhere:
///   the web transport is `dart:js_interop` only, which also keeps it valid
///   under `dart compile wasm`;
/// - the SDK reads NO environment (`spec/modes.md` "Reading credentials");
/// - no vendor SDK, no vendor key shapes (`posthog`, `phc_`/`phs_`/`phx_`
///   literals) anywhere in `lib/` — the only occurrence of the key-prefix
///   family is the redaction regex's character class in `errors.dart`.
void main() {
  final lib = Directory('${Directory.current.path}/lib');
  final files =
      lib
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart'))
          .toList()
        ..sort((a, b) => a.path.compareTo(b.path));

  List<String> filesImporting(String library) => [
    for (final file in files)
      if (RegExp(
        '''import\\s+['"]$library['"]''',
      ).hasMatch(file.readAsStringSync()))
        file.path,
  ];

  test('dart:io is confined to the io transport', () {
    final offenders = filesImporting('dart:io')
        .where(
          (p) => !p.endsWith('infrastructure/transport/http_transport_io.dart'),
        )
        .toList();
    expect(offenders, isEmpty);
    expect(
      filesImporting('dart:io'),
      hasLength(1),
      reason: 'the io transport must exist and import dart:io',
    );
  });

  test('dart:js_interop is confined to the web transport', () {
    final offenders = filesImporting('dart:js_interop')
        .where(
          (p) =>
              !p.endsWith('infrastructure/transport/http_transport_web.dart'),
        )
        .toList();
    expect(offenders, isEmpty);
    expect(
      filesImporting('dart:js_interop'),
      hasLength(1),
      reason: 'the web transport must exist and import dart:js_interop',
    );
  });

  test('no retired browser libraries and no pub HTTP/web packages', () {
    for (final library in const [
      'dart:html',
      'dart:js',
      'dart:js_util',
      'package:web/web.dart',
      'package:http/http.dart',
    ]) {
      expect(filesImporting(library), isEmpty, reason: library);
    }
    for (final file in files) {
      expect(
        file.readAsStringSync(),
        isNot(contains('package:web/')),
        reason: file.path,
      );
      expect(
        file.readAsStringSync(),
        isNot(contains('package:http/')),
        reason: file.path,
      );
    }
  });

  test('the SDK reads no environment variables', () {
    final offenders = <String>[];
    for (final file in files) {
      final source = file.readAsStringSync();
      if (source.contains('Platform.environment') ||
          source.contains('fromEnvironment(')) {
        offenders.add(file.path);
      }
    }
    expect(offenders, isEmpty);
  });

  test('no vendor SDK or vendor key shapes in lib/', () {
    final offenders = <String>[];
    for (final file in files) {
      final source = file.readAsStringSync();
      if (source.toLowerCase().contains('posthog')) {
        offenders.add('${file.path}: posthog');
      }
      for (final prefix in const ['phc_', 'phs_', 'phx_']) {
        if (source.contains(prefix)) {
          offenders.add('${file.path}: $prefix');
        }
      }
    }
    expect(offenders, isEmpty);
  });
}
