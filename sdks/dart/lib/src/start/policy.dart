/// The start-profile policy: one pure resolver shared by the client and the
/// server profile (node: `src/start/resolve.ts`, web: `src/start/policy.ts`,
/// go: `fw/resolve.go`).
///
/// Pure on purpose: no environment, no globals, no I/O. Each profile reads
/// its own sources (compile-time defines on clients, the process environment
/// on servers), hands the values in with their source names, and gets back a
/// config or a failure whose message names sources and variables, never a
/// value.
library;

import 'package:fireweave/fireweave.dart';

import 'channel.dart';
import 'flags.dart';
import 'names.dart';

/// Which profile is resolving: it decides the accepted key family and the
/// variable names in messages.
enum StartProfile {
  client(browserKeyVariable),
  server(serverKeyVariable);

  const StartProfile(this.keyVariable);

  /// The variable a fix should name.
  final String keyVariable;
}

/// A value and where it came from (`Fireweave.start(key:)`,
/// `FIREWEAVE_KEY`, ...).
final class Sourced {
  const Sourced(this.value, this.source);

  final String value;
  final String source;
}

/// A trimmed, non-empty value with its source, or `null`: empty and
/// whitespace-only values count as unset.
Sourced? sourced(String? value, String source) {
  if (value == null) {
    return null;
  }
  final trimmed = value.trim();
  return trimmed.isEmpty ? null : Sourced(trimmed, source);
}

/// The first candidate that is set.
Sourced? firstOf(List<Sourced?> candidates) {
  for (final candidate in candidates) {
    if (candidate != null) {
      return candidate;
    }
  }
  return null;
}

/// What a start resolved to. [key] is held only to hand it to
/// `initFireweave`; it is never logged, printed or put in a status.
final class ResolvedStart {
  const ResolvedStart({
    required this.mode,
    required this.modeSource,
    required this.keySource,
    required this.flags,
    required this.channel,
    required this.sdkVersion,
    this.url,
    this.urlSource,
    this.allowedHosts,
    this.key,
    this.environment,
    this.environmentSource,
    this.warnings = const <String>[],
  });

  final Mode mode;

  /// Why this mode: `option`, `key` or `environment`.
  final String modeSource;

  /// Remote only.
  final String? url;
  final String? urlSource;

  /// Remote only, and `null` for the channel default (the core's own list
  /// covers both channel hosts).
  final List<String>? allowedHosts;

  /// Remote only. Never logged.
  final String? key;

  /// The option or variable the key came from; `none` in local mode.
  final String keySource;

  /// Set when the environment name chose the mode.
  final String? environment;
  final String? environmentSource;

  final Map<String, Flag> flags;
  final SdkChannel channel;
  final String sdkVersion;

  /// Lines to log once each: legacy names, an ignored key.
  final List<String> warnings;

  /// fw-server host name only: never a path, a query or userinfo.
  String? get host {
    final u = url;
    return u == null ? null : Uri.tryParse(u)?.host;
  }
}

/// The outcome of [resolvePolicy].
sealed class PolicyResult {
  const PolicyResult();
}

final class PolicyOk extends PolicyResult {
  const PolicyOk(this.config);

  final ResolvedStart config;
}

/// Why a start cannot run. [reason] is a fixed code (`missing-key`,
/// `server-key`, `wrong-key-family`, `insecure-url`); [variable] names the
/// option or variable at fault; [message] names sources, never values.
final class PolicyFailure extends PolicyResult {
  const PolicyFailure(this.reason, this.variable, this.message);

  final String reason;
  final String variable;
  final String message;

  /// The server profile throws this.
  FireweaveError toError() =>
      FireweaveError.configuration(message, initFatal: true);
}

/// Everything [resolvePolicy] needs, already read from the profile's
/// sources.
final class PolicyInput {
  const PolicyInput({
    required this.profile,
    required this.flags,
    required this.channel,
    required this.sdkVersion,
    required this.environmentChecked,
    this.mode,
    this.key,
    this.url,
    this.environment,
    this.retiredEnvironmentSet = false,
    this.warnings = const <String>[],
  });

  final StartProfile profile;
  final Mode? mode;
  final Sourced? key;
  final Sourced? url;
  final Sourced? environment;
  final Map<String, Flag> flags;
  final SdkChannel channel;
  final String sdkVersion;

  /// Where an environment name was looked for, for the missing-key message.
  final String environmentChecked;

  /// The retired `FW_ENV` is set (server only): the missing-key message says
  /// to rename it.
  final bool retiredEnvironmentSet;

  /// Warnings already produced while reading the sources (legacy names).
  final List<String> warnings;
}

PolicyFailure _fail(String reason, String variable, String message) =>
    PolicyFailure(reason, variable, '[fireweave] $message');

/// Analytics-vendor key shapes, as a pattern rather than literal prefixes,
/// so no vendor key prefix appears in this file or in a message.
final RegExp _vendorKey = RegExp(r'^ph[a-z]_');

bool _isOrgOrCliToken(String key) =>
    key.startsWith('fw_org_') || key.startsWith('cli_at_');

/// Key family check, before any request. Messages name the source, never
/// the value.
PolicyFailure? _checkKey(StartProfile profile, Sourced key) {
  final v = key.value;
  final from = 'The key from ${key.source}';
  switch (profile) {
    case StartProfile.client:
      if (v.startsWith(browserKeyPrefix)) {
        return null;
      }
      if (v.startsWith(serverKeyPrefix)) {
        return _fail(
          'server-key',
          key.source,
          '$from is a server key ($serverKeyPrefix…), which must never ship '
              'inside an app. Use a browser key ($browserKeyPrefix…) from Project '
              'settings, API keys. If a build with this key was released, revoke '
              'the key.',
        );
      }
      if (_vendorKey.hasMatch(v)) {
        return _fail(
          'wrong-key-family',
          key.source,
          '$from is an analytics vendor key, not a FireWeave browser key '
              '($browserKeyPrefix…).',
        );
      }
      if (_isOrgOrCliToken(v)) {
        return _fail(
          'wrong-key-family',
          key.source,
          '$from is an organisation or CLI token, not a FireWeave browser key '
              '($browserKeyPrefix…).',
        );
      }
      return _fail(
        'wrong-key-family',
        key.source,
        '$from is not a FireWeave browser key ($browserKeyPrefix…).',
      );
    case StartProfile.server:
      if (v.startsWith(browserKeyPrefix)) {
        return _fail(
          'wrong-key-family',
          key.source,
          '$from is a browser key ($browserKeyPrefix…). Server apps need a '
              'project key ($serverKeyPrefix…) from Project settings, API keys.',
        );
      }
      if (_vendorKey.hasMatch(v)) {
        return _fail(
          'wrong-key-family',
          key.source,
          '$from is an analytics vendor key, not a FireWeave project key. Use '
              'the project key ($serverKeyPrefix…).',
        );
      }
      if (_isOrgOrCliToken(v)) {
        return _fail(
          'wrong-key-family',
          key.source,
          '$from is an organisation or CLI token, not a project key. Use the '
              'project key ($serverKeyPrefix…).',
        );
      }
      return null;
  }
}

bool _isLoopback(String host) => loopbackHosts.contains(host);

final class _Endpoint {
  const _Endpoint(this.url, this.urlSource, this.allowedHosts);

  final String url;
  final String urlSource;
  final List<String>? allowedHosts;
}

/// The endpoint: the channel default, or an override that must be https
/// (http only on loopback) and gets an allowlist of its own host plus
/// loopback. Returns a [_Endpoint] or a [PolicyFailure].
Object _resolveUrl(Sourced? url, SdkChannel channel) {
  if (url == null) {
    return _Endpoint(channel.defaultUrl, 'SDK channel (${channel.name})', null);
  }
  var value = url.value;
  while (value.endsWith('/')) {
    value = value.substring(0, value.length - 1);
  }
  final parsed = Uri.tryParse(value);
  final scheme = parsed?.scheme.toLowerCase() ?? '';
  if (parsed == null ||
      (scheme != 'http' && scheme != 'https') ||
      parsed.host.isEmpty) {
    return _fail(
      'insecure-url',
      url.source,
      'The endpoint from ${url.source} is not a valid URL.',
    );
  }
  final host = parsed.host.toLowerCase();
  if (scheme == 'http' && !_isLoopback(host)) {
    return _fail(
      'insecure-url',
      url.source,
      'The endpoint from ${url.source} must use https (http is allowed only '
          'for localhost).',
    );
  }
  return _Endpoint(
    value,
    url.source,
    List<String>.unmodifiable(<String>[
      host,
      ...loopbackHosts.where((h) => h != host),
    ]),
  );
}

final RegExp _safeEcho = RegExp(r'^[A-Za-z0-9._-]{1,32}$');

/// Whether an environment name may be quoted back in a message: a short
/// plain token that does not look like a key (go's rule).
bool _echoable(String value) =>
    _safeEcho.hasMatch(value) &&
    !_vendorKey.hasMatch(value) &&
    !value.startsWith(serverKeyPrefix) &&
    !value.startsWith('fw_');

PolicyResult _remote(
  PolicyInput input,
  Sourced key,
  String modeSource,
  List<String> warnings,
) {
  final problem = _checkKey(input.profile, key);
  if (problem != null) {
    return problem;
  }
  final endpoint = _resolveUrl(input.url, input.channel);
  if (endpoint is! _Endpoint) {
    return endpoint as PolicyFailure;
  }
  return PolicyOk(
    ResolvedStart(
      mode: Mode.remote,
      modeSource: modeSource,
      url: endpoint.url,
      urlSource: endpoint.urlSource,
      allowedHosts: endpoint.allowedHosts,
      key: key.value,
      keySource: key.source,
      flags: input.flags,
      channel: input.channel,
      sdkVersion: input.sdkVersion,
      warnings: List<String>.unmodifiable(warnings),
    ),
  );
}

/// Resolve mode, key and endpoint.
///
/// An explicit mode wins: local ignores a key (with one warning), remote
/// without a key fails. Otherwise a key means remote; no key and a
/// development environment name (`development`, `dev`, `local`, `test`,
/// trimmed, any case) means local; anything else fails closed, so a missing
/// key never turns into silent local evaluation in production.
PolicyResult resolvePolicy(PolicyInput input) {
  final warnings = <String>[...input.warnings];
  final keyVariable = input.profile.keyVariable;
  final key = input.key;

  if (input.mode == Mode.local) {
    if (key != null) {
      warnings.add(
        '[fireweave] Mode.local ignores the key from ${key.source}; nothing '
        'is sent to fw-server.',
      );
    }
    return PolicyOk(
      ResolvedStart(
        mode: Mode.local,
        modeSource: 'option',
        keySource: 'none',
        flags: input.flags,
        channel: input.channel,
        sdkVersion: input.sdkVersion,
        warnings: List<String>.unmodifiable(warnings),
      ),
    );
  }

  if (input.mode == Mode.remote) {
    if (key == null) {
      return _fail(
        'missing-key',
        keyVariable,
        'Mode.remote needs a key. Set $keyVariable or pass '
            'Fireweave.start(key:).',
      );
    }
    return _remote(input, key, 'option', warnings);
  }

  if (key != null) {
    return _remote(input, key, 'key', warnings);
  }

  final environment = input.environment;
  if (environment != null &&
      devEnvironments.contains(environment.value.toLowerCase())) {
    return PolicyOk(
      ResolvedStart(
        mode: Mode.local,
        modeSource: 'environment',
        keySource: 'none',
        environment: environment.value,
        environmentSource: environment.source,
        flags: input.flags,
        channel: input.channel,
        sdkVersion: input.sdkVersion,
        warnings: List<String>.unmodifiable(warnings),
      ),
    );
  }

  final String where;
  if (environment == null) {
    where = 'no environment name is set (checked ${input.environmentChecked})';
  } else if (_echoable(environment.value)) {
    where =
        "the environment is '${environment.value}' (from "
        '${environment.source}), which is not a development name';
  } else {
    where =
        'the environment name from ${environment.source} is not a '
        'development name';
  }
  final retired = environment == null && input.retiredEnvironmentSet
      ? ' $retiredEnvironmentName is no longer read; rename it to '
            '$environmentVariable.'
      : '';
  final fix = switch (input.profile) {
    StartProfile.client =>
      'Set $keyVariable to a browser key ($browserKeyPrefix…) with '
          '--dart-define or --dart-define-from-file, or for local work build '
          'with $environmentVariable=development or pass '
          'Fireweave.start(mode: Mode.local).',
    StartProfile.server =>
      "Set $keyVariable to the project's server key, or for local "
          'development set $environmentVariable=development or pass '
          'Fireweave.start(mode: Mode.local).',
  };
  return _fail(
    'missing-key',
    keyVariable,
    '$keyVariable is not set and $where. $fix$retired',
  );
}
