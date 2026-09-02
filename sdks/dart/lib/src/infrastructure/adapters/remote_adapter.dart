/// Fireweave remote backend adapter — default production path.
///
/// Real HTTP client (`dart:io` on the VM and Flutter mobile/desktop, the
/// browser's `fetch` via `dart:js_interop` on the web — both Dart SDK
/// libraries, no third-party HTTP package) for fw-server
/// `POST /v1/flags/evaluate` and `POST /v1/targets/register`. Auth:
/// `Authorization: Bearer <apiKey>`.
/// Speaks only the vendor-neutral Fireweave remote protocol
/// (`spec/remote-protocol.md`) — no vendor SDK, key, or host ever enters the
/// application process.
///
/// [prefetch] is the ONE place this adapter does network I/O — never a
/// per-call `evaluate()`, which is why the read surface can be synchronous.
/// One `POST /v1/flags/evaluate` fetches every decision for a context in a
/// single round trip; `FireweaveRuntime` then reads the resulting cache
/// synchronously.
library;

import 'dart:convert';

import '../../application/ports.dart';
import '../../domain/context.dart';
import '../../domain/decision.dart';
import '../../domain/errors.dart';
import '../hosts.dart';
import '../transport/default_http_transport.dart';

class RemoteAdapterConfig {
  const RemoteAdapterConfig({
    required this.apiUrl,
    required this.apiKey,
    this.allowedHosts,
    this.requestTimeoutMs = 3000,
  });

  final String apiUrl;
  final String apiKey;

  /// `null` means the adapter-level fallback (`defaultAllowedHostsFor`): the
  /// URL's own hostname plus loopback — NOT the canonical
  /// `defaultAllowedHosts` list. `initFireweave` (the sanctioned entry
  /// point) already enforces the stricter canonical default before this
  /// adapter is ever constructed; this fallback only matters for direct
  /// adapter construction that bypasses `initFireweave` (as the conformance
  /// runner deliberately does for host-allowlist fixtures).
  final List<String>? allowedHosts;
  final int requestTimeoutMs;
}

class FireweaveRemoteAdapter implements ControlPointsBackendAdapter {
  /// [transport] `null` selects the platform default (`dart:io` on the VM and
  /// Flutter mobile/desktop, `fetch` on the web — see
  /// `transport/default_http_transport.dart`). On a platform with neither,
  /// the default THROWS a `Configuration` error here, at construction, so a
  /// missing transport fails at boot and never at first read.
  FireweaveRemoteAdapter(RemoteAdapterConfig config, {HttpTransport? transport})
    : _apiUrl = config.apiUrl,
      _apiKey = config.apiKey,
      _allowedHosts = config.allowedHosts,
      _timeout = Duration(milliseconds: config.requestTimeoutMs),
      _transport = transport ?? createDefaultHttpTransport();

  static const String _evaluatePath = '/v1/flags/evaluate';
  static const String _registerTargetPath = '/v1/targets/register';

  String _apiUrl;
  final String _apiKey;
  final List<String>? _allowedHosts;
  final Duration _timeout;
  final HttpTransport _transport;
  bool _ready = false;
  bool _closed = false;

  @override
  DecisionReason? get missReason => null;

  bool get isClosed => _closed;

  @override
  Future<void> initialize() async {
    if (_closed) {
      throw FireweaveError(ErrorKind.alreadyClosed);
    }
    final trimmed = _apiUrl.endsWith('/')
        ? _apiUrl.substring(0, _apiUrl.length - 1)
        : _apiUrl;
    if (trimmed.isEmpty || _apiKey.isEmpty) {
      throw FireweaveError.configuration(
        'invalid configuration',
        initFatal: true,
      );
    }
    final allow = (_allowedHosts != null && _allowedHosts.isNotEmpty)
        ? _allowedHosts
        : defaultAllowedHostsFor(trimmed);
    assertHostAllowed(trimmed, allowedHosts: allow, initFatal: true);
    _apiUrl = trimmed;
    _ready = true;
  }

  Future<Map<String, Object?>> _request(
    String path,
    Map<String, Object?> body,
  ) async {
    if (_closed) {
      throw FireweaveError(ErrorKind.alreadyClosed);
    }
    if (!_ready) {
      throw FireweaveError(ErrorKind.notReady);
    }
    final url = Uri.tryParse('$_apiUrl$path');
    if (url == null) {
      throw FireweaveError(ErrorKind.malformedResponse);
    }

    final TransportResponse response;
    try {
      response = await _transport.post(
        url,
        headers: <String, String>{
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': 'Bearer $_apiKey',
        },
        body: jsonEncode(body),
        timeout: _timeout,
      );
    } on FireweaveError {
      rethrow;
    } on Object {
      throw FireweaveError(ErrorKind.network);
    }

    final status = response.statusCode;
    if (status >= 200 && status <= 299) {
      // fall through to parsing
    } else if (status == 401) {
      throw FireweaveError(ErrorKind.authentication);
    } else if (status == 403) {
      throw FireweaveError(ErrorKind.authorization);
    } else if (status == 429) {
      throw FireweaveError(ErrorKind.rateLimited);
    } else {
      throw FireweaveError(ErrorKind.backendUnavailable);
    }

    final Object? parsed;
    try {
      parsed = jsonDecode(response.body);
    } on FormatException {
      throw FireweaveError(ErrorKind.malformedResponse);
    }
    if (parsed is! Map) {
      throw FireweaveError(ErrorKind.malformedResponse);
    }
    return <String, Object?>{
      for (final entry in parsed.entries) entry.key.toString(): entry.value,
    };
  }

  /// A missing `targetingKey` at PREFETCH time returns an EMPTY batch rather
  /// than throwing — deliberately different from node/go/java/rust's per-call
  /// `resolve()`, and identical to swift: in THIS architecture
  /// `FireweaveRuntime.initialize()` always triggers an immediate prefetch,
  /// even before any real identity is known (an anonymous pre-sign-in boot,
  /// or `life-init-success`'s fixture, which supplies no context at all and
  /// expects `initialize()` to reach READY). Throwing here would conflate
  /// "no identity yet" (a normal state before sign-in) with "the backend is
  /// broken", and would make an anonymous boot unable to reach READY. The
  /// `requireTargetingKey` config flag — enforced by `validateContext` at
  /// EVALUATE time — is the single authority for whether a missing targeting
  /// key must be fatal for a deployment. A subsequent `identify()` with a
  /// real targeting key triggers a real [prefetch] with a populated batch.
  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) async {
    final targetingKey = context.targetingKey;
    if (targetingKey == null || targetingKey.isEmpty) {
      return <String, AdapterResolution>{};
    }

    final body = <String, Object?>{'targetingKey': targetingKey};
    final flagKeys = options?.flagKeys;
    if (flagKeys != null) {
      body['flagKeys'] = flagKeys;
    }

    final attributes = <String, Object?>{};
    Object? groups;
    Object? groupProperties;
    for (final entry in context.attributes.entries) {
      final key = entry.key;
      final value = entry.value;
      if ((key == 'groups' || key == 'fireweave.groups') && value is Map) {
        groups = value;
        continue;
      }
      if ((key == 'groupProperties' || key == 'fireweave.groupProperties') &&
          value is Map) {
        groupProperties = value;
        continue;
      }
      if (key.startsWith(r'$') || key.startsWith('fireweave.')) {
        continue;
      }
      attributes[key] = value;
    }
    if (attributes.isNotEmpty) {
      body['attributes'] = attributes;
    }
    if (groups != null) {
      body['groups'] = groups;
    }
    if (groupProperties != null) {
      body['groupProperties'] = groupProperties;
    }

    final data = await _request(_evaluatePath, body);
    final rawDecisions = data['decisions'];
    final decisions = rawDecisions is List ? rawDecisions : const <Object?>[];
    final quotaLimited = data['quotaLimited'] == true;

    final result = <String, AdapterResolution>{};
    for (final item in decisions) {
      if (item is! Map) {
        continue;
      }
      final flagKey = item['flagKey'];
      if (flagKey is! String) {
        continue;
      }
      // "found: false" on the wire means genuinely unknown to the backend —
      // leave the key OUT of the batch entirely (this adapter's `missReason`
      // is null, so an absent key resolves to ERROR/FlagNotFound at read
      // time), rather than inserting a `found: false` entry — that shape is
      // reserved for InMemoryAdapter's "conditions didn't match" signal.
      if (item['found'] == false) {
        continue;
      }
      final meta = item['flagMetadata'];
      final metaMap = meta is Map ? meta : const <Object?, Object?>{};
      final reason = item['reason'];
      final enabled = item['enabled'];
      final variant = item['variant'];
      final reasonCode = metaMap['fireweave.reasonCode'];
      final version = metaMap['fireweave.flagVersion'];
      final vendorFlagId = metaMap['fireweave.vendorFlagId'];
      result[flagKey] = AdapterResolution(
        found: true,
        enabled: enabled is bool ? enabled : true,
        value: item['value'],
        variant: variant is String ? variant : null,
        reason: reason is String ? DecisionReason.fromWireName(reason) : null,
        reasonCode: reasonCode is String ? reasonCode : null,
        version: version is num ? version.toInt() : null,
        vendorFlagId: vendorFlagId is num ? vendorFlagId.toInt() : null,
        payload: item['payload'],
        fromCache: false,
      );
    }
    if (quotaLimited && result.isEmpty) {
      // Quota-limited responses resolve as FlagNotFound with
      // fireweave.quotaLimited metadata (`contracts/errors.json`) — surfaced
      // via the thrown error when the WHOLE batch is quota-limited and
      // returned nothing.
      throw FireweaveError.flagNotFound(quotaLimited: true);
    }
    return result;
  }

  /// Never throws for transport failures: registration sits in sign-in
  /// paths, and an analytics call must not break sign-in. Retried ONCE when
  /// the error taxonomy marks the failure retryable; a rejected payload or
  /// bad key is not retried, since it would be rejected identically.
  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async {
    if (_closed) {
      return RegisterTargetResult.failure(
        FireweaveError(ErrorKind.alreadyClosed),
      );
    }
    if (!_ready) {
      return RegisterTargetResult.failure(FireweaveError(ErrorKind.notReady));
    }
    if (targetingKey.isEmpty) {
      return RegisterTargetResult.failure(FireweaveError.targetingKeyMissing());
    }

    final body = <String, Object?>{'targetingKey': targetingKey};
    final kind = options?.kind;
    if (kind != null) {
      body['kind'] = kind.wireName;
    }
    final environment = options?.environment;
    if (environment != null) {
      body['environment'] = environment;
    }
    final properties = options?.properties;
    if (properties != null && properties.isNotEmpty) {
      body['properties'] = properties;
    }

    FireweaveError? lastError;
    for (var attempt = 0; attempt < 2; attempt += 1) {
      try {
        await _request(_registerTargetPath, body);
        return const RegisterTargetResult.success();
      } on FireweaveError catch (error) {
        lastError = error;
        if (!error.isRetryable) {
          break;
        }
      } on Object {
        lastError = FireweaveError(ErrorKind.internal);
        break;
      }
    }
    return RegisterTargetResult.failure(
      lastError ?? FireweaveError(ErrorKind.internal),
    );
  }

  @override
  Future<void> shutdown() async {
    _closed = true;
    _ready = false;
  }
}
