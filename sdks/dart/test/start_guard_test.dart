@TestOn('vm')
library;

import 'dart:io';

import 'package:test/test.dart';

/// Start-profile confinement (docs/adr/0012-start-profile.md): the
/// portability guard changes shape, not strength.
///
/// - the start profile (`lib/src/start/`, `lib/client.dart`,
///   `lib/server.dart`) is built on the public API only: it imports
///   `dart:` libraries, `package:fireweave/fireweave.dart` and its own files;
/// - the core never imports the start profile, and `lib/fireweave.dart`
///   exports nothing from it;
/// - the process environment and the host name are read in exactly one
///   file, the server seam; compile-time defines in exactly one file, the
///   client seam, and only as `const` reads of a literal name (a define read
///   that is not constant is the empty string under AOT and throws under
///   dart2js);
/// - `dart:io` appears in the start profile only in the server seam and the
///   owned transport, and `package:fireweave/client.dart`'s import graph
///   never reaches `dart:io` (it compiles for the web), while
///   `package:fireweave/server.dart`'s does (it compiles only where
///   `dart:io` exists).
final String libRoot = '${Directory.current.path}/lib';

const String serverSeam = 'src/start/server_env_io.dart';
const String clientSeam = 'src/start/client_defines.dart';
const Set<String> startDartIoFiles = <String>{
  serverSeam,
  'src/start/transport/owned_transport_io.dart',
};

/// Package-relative path (`src/start/core.dart`) of a file under lib/.
String rel(String absolute) => absolute.substring(libRoot.length + 1);

List<File> libFiles() =>
    Directory(libRoot)
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .toList()
      ..sort((a, b) => a.path.compareTo(b.path));

bool isStart(String relPath) =>
    relPath.startsWith('src/start/') ||
    relPath == 'client.dart' ||
    relPath == 'server.dart';

/// One import/export directive: its default URI and any conditional ones.
class Directive {
  Directive(this.defaultUri, this.conditionalUris);

  final String defaultUri;
  final List<String> conditionalUris;

  List<String> get all => <String>[defaultUri, ...conditionalUris];
}

final RegExp _directive = RegExp(
  r'''^\s*(?:import|export)\s+['"]([^'"]+)['"]((?:\s*if\s*\([^)]*\)\s*['"][^'"]+['"])*)''',
  multiLine: true,
);
final RegExp _conditional = RegExp(r'''if\s*\([^)]*\)\s*['"]([^'"]+)['"]''');

List<Directive> directivesOf(String source) => <Directive>[
  for (final m in _directive.allMatches(source))
    Directive(m.group(1)!, <String>[
      for (final c in _conditional.allMatches(m.group(2) ?? '')) c.group(1)!,
    ]),
];

/// Resolves [uri] imported by the file at [fromRel] to a package-relative
/// path under lib/, or returns it unchanged for `dart:` and other packages.
String resolve(String fromRel, String uri) {
  if (uri.startsWith('dart:')) {
    return uri;
  }
  if (uri.startsWith('package:fireweave/')) {
    return uri.substring('package:fireweave/'.length);
  }
  if (uri.startsWith('package:')) {
    return uri;
  }
  final base = Uri.parse('file:///$fromRel');
  return base.resolve(uri).path.substring(1);
}

/// Every library reachable from [entryRel] along DEFAULT import/export URIs
/// (the branch a platform without `dart:io`/`dart:js_interop` selects).
Set<String> defaultGraph(String entryRel) {
  final seen = <String>{};
  final pending = <String>[entryRel];
  while (pending.isNotEmpty) {
    final current = pending.removeLast();
    if (!seen.add(current) || current.startsWith('dart:')) {
      continue;
    }
    if (current.startsWith('package:')) {
      continue;
    }
    final file = File('$libRoot/$current');
    if (!file.existsSync()) {
      fail('import graph: $current does not exist');
    }
    for (final d in directivesOf(file.readAsStringSync())) {
      pending.add(resolve(current, d.defaultUri));
    }
  }
  return seen;
}

/// Strip `//` comments so a doc comment cannot satisfy or trip a guard.
String withoutComments(String source) => source
    .split('\n')
    .map((line) {
      final i = line.indexOf('//');
      return i == -1 ? line : line.substring(0, i);
    })
    .join('\n');

void main() {
  final files = libFiles();
  final startFiles = files.where((f) => isStart(rel(f.path))).toList();
  final coreFiles = files.where((f) => !isStart(rel(f.path))).toList();

  test('the start profile exists (the carve-outs below are load-bearing)', () {
    final rels = startFiles.map((f) => rel(f.path)).toSet();
    expect(rels, containsAll(<String>[serverSeam, clientSeam]));
    expect(rels, containsAll(startDartIoFiles));
    expect(rels, containsAll(<String>['client.dart', 'server.dart']));
  });

  test('the start profile imports only dart:, the public API and itself', () {
    final offenders = <String>[];
    for (final file in startFiles) {
      final from = rel(file.path);
      for (final d in directivesOf(file.readAsStringSync())) {
        for (final uri in d.all) {
          final target = resolve(from, uri);
          final ok =
              target.startsWith('dart:') ||
              target == 'fireweave.dart' ||
              isStart(target);
          if (!ok) {
            offenders.add('$from: $uri');
          }
        }
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          'the start profile is a layer over the unchanged core: it may use '
          'package:fireweave/fireweave.dart only, never lib/src/{domain,'
          'application,infrastructure} directly',
    );
  });

  test('the core never imports or exports the start profile', () {
    final offenders = <String>[];
    for (final file in coreFiles) {
      final from = rel(file.path);
      for (final d in directivesOf(file.readAsStringSync())) {
        for (final uri in d.all) {
          if (isStart(resolve(from, uri))) {
            offenders.add('$from: $uri');
          }
        }
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          'the core is policy-free: lib/fireweave.dart and lib/src/{domain,'
          'application,infrastructure} must not reach the start profile',
    );
  });

  test('dart:io in the start profile is confined to its two named files', () {
    final importers = <String>{
      for (final file in startFiles)
        for (final d in directivesOf(file.readAsStringSync()))
          if (d.all.contains('dart:io')) rel(file.path),
    };
    expect(importers, equals(startDartIoFiles));
  });

  test('the process environment and the host name are read only in the '
      'server seam', () {
    final readers = <String>{};
    for (final file in files) {
      final source = withoutComments(file.readAsStringSync());
      if (source.contains('Platform.environment') ||
          source.contains('localHostname') ||
          source.contains('Platform.')) {
        readers.add(rel(file.path));
      }
    }
    expect(readers, equals(<String>{serverSeam}));
  });

  test('compile-time defines are read only in the client seam, and only as '
      'const reads of a literal name', () {
    final token = RegExp(r'(fromEnvironment|hasEnvironment)\s*\(');
    final readers = <String>{
      for (final file in files)
        if (token.hasMatch(withoutComments(file.readAsStringSync())))
          rel(file.path),
    };
    expect(readers, equals(<String>{clientSeam}));

    final source = withoutComments(
      File('$libRoot/$clientSeam').readAsStringSync(),
    );
    final literalRead = RegExp(
      r'''(String|bool|int)\.(fromEnvironment|hasEnvironment)\(\s*'([A-Z][A-Z0-9_]*)'\s*,?\s*\)''',
    );
    final reads = literalRead.allMatches(source).toList();
    expect(
      reads,
      hasLength(token.allMatches(source).length),
      reason:
          'every define read takes exactly one string-literal name (no '
          'variable name, no defaultValue)',
    );
    final offenders = <String>[];
    for (final read in reads) {
      // The statement the read belongs to: from the previous ';' to here.
      final start = source.lastIndexOf(';', read.start) + 1;
      final statement = source.substring(start, read.start).trim();
      final constant =
          statement.startsWith('const ') || statement.endsWith('const');
      if (!constant) {
        offenders.add(read.group(0)!);
      }
    }
    expect(
      offenders,
      isEmpty,
      reason:
          'a define read that is not constant evaluates to the empty string '
          'under AOT and throws under dart2js',
    );
    expect(
      reads.map((m) => m.group(3)).toSet(),
      equals(<String>{
        'FIREWEAVE_BROWSER_KEY',
        'FIREWEAVE_URL',
        'FIREWEAVE_ENV',
        'FIREWEAVE_KEY',
      }),
    );
    expect(
      RegExp(r"String\.fromEnvironment\(\s*'FIREWEAVE_KEY'").hasMatch(source),
      isFalse,
      reason: 'the server key is checked for presence only, never read',
    );
  });

  test('client.dart never reaches dart:io or the server seam', () {
    final graph = defaultGraph('client.dart');
    expect(graph, contains('fireweave.dart'));
    expect(graph, contains(clientSeam));
    expect(graph, isNot(contains('dart:io')));
    expect(graph, isNot(contains(serverSeam)));
  });

  test('server.dart reaches dart:io unconditionally and never the client '
      'seam', () {
    final graph = defaultGraph('server.dart');
    expect(graph, contains('dart:io'));
    expect(graph, contains(serverSeam));
    expect(graph, isNot(contains(clientSeam)));
  });
}
