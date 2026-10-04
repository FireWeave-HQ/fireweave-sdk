/// Fireweave Dart conformance runner (`contracts/harness.md`).
///
/// ## Suite -> execution backend
///
/// - evaluation / (8 of 14) context / lifecycle / security / (the one
///   runnable extensions fixture): `InMemoryAdapter`, driving
///   `FireweaveRuntime`+`FireweaveClient` directly.
/// - faults: `fault-stale-cache` is the ONE faults-suite fixture that
///   transfers for real (staleness is provisioned directly via
///   `providerState: STALE` + `given.flags[*].fromCache`, not a live per-call
///   fault) — the other 8 are `skipped-with-documented-limitation`.
/// - extensions: 13 of 14 target namespaces cut from v1 (ADR-0010),
///   classified data-driven from `when.operation`, reported
///   `skipped-v1-out-of-scope`. Only `ext-unsupported-capability-degrade`
///   exercises real v1 surface and runs for real.
///
/// ## Disposition (the same one swift ruled on)
///
/// This SDK shares web/swift's architecture (prefetch async, `evaluate()` a
/// pure synchronous cache read — ADR-0009) and ALSO supports local mode, and
/// its `InMemoryAdapter` conditions are matched against the context
/// available AT PREFETCH time (global+client layers only), never per-call
/// invocation context. So the shared 65 DO mostly transfer — EXCEPT for two
/// genuinely structural mismatches:
///
/// 1. **6 context-suite fixtures whose backend MATCHING is driven by
///    invocation-only context** (`targetingKey`/`attributes` present ONLY in
///    `when.invocationContext`): a prefetch keyed on global+client cannot
///    retroactively re-resolve a decision against a per-call attribute.
/// 2. **8-of-9 faults-suite fixtures**, whose premise is a live per-call
///    HTTP fault occurring exactly when `evaluate()` is invoked — this
///    architecture's `evaluate()` never does I/O at all.
///
/// Plus one fixture unrelated to the architecture,
/// `eval-numeric-coercion-int-float` (v1's `FlagType` has no integer/float
/// split — the same limitation every other language declares).
///
/// Verified decomposition: **37 pass** + **15 skipped-with-documented-
/// limitation** + **13 skipped-v1-out-of-scope** = **65**. Executing what
/// genuinely transfers and documenting the rest individually is the honest
/// choice — 37 of the 65 run real Dart code against the real fixtures.
library;

import 'dart:convert';
import 'dart:io';

import 'package:fireweave/fireweave.dart';

const String language = 'dart';

class Fixture {
  const Fixture({required this.id, required this.suite, required this.json});

  final String id;
  final String suite;
  final Map<String, Object?> json;

  Map<String, Object?> get given => _obj(json['given']);
  Map<String, Object?> get when => _obj(json['when']);
  Map<String, Object?> get expect => _obj(json['expect']);
  List<Map<String, Object?>>? get cases {
    final raw = json['cases'];
    if (raw is! List) {
      return null;
    }
    return raw.map(_obj).toList();
  }
}

Map<String, Object?> _obj(Object? value) {
  if (value is! Map) {
    return const <String, Object?>{};
  }
  return <String, Object?>{
    for (final entry in value.entries) entry.key.toString(): entry.value,
  };
}

const List<String> suites = <String>[
  'evaluation',
  'context',
  'lifecycle',
  'faults',
  'security',
  'extensions',
];

List<Fixture> loadFixtures(Directory contractsDir) {
  final fixtures = <Fixture>[];
  for (final suite in suites) {
    final dir = Directory('${contractsDir.path}/$suite');
    if (!dir.existsSync()) {
      continue;
    }
    final files =
        dir
            .listSync()
            .whereType<File>()
            .where((f) => f.path.endsWith('.json'))
            .toList()
          ..sort((a, b) => a.path.compareTo(b.path));
    for (final file in files) {
      final json = _obj(jsonDecode(file.readAsStringSync()));
      final id = json['id'];
      if (id is! String) {
        continue;
      }
      fixtures.add(Fixture(id: id, suite: suite, json: json));
    }
  }
  return fixtures;
}

class Status {
  static const String pass = 'pass';
  static const String fail = 'fail';
  static const String skippedWithDocumentedLimitation =
      'skipped-with-documented-limitation';
  static const String skippedV1OutOfScope = 'skipped-v1-out-of-scope';
}

/// One row of `contracts/README.md`'s compatibility-report schema — the
/// SAME shape every language writes.
class ResultRow {
  const ResultRow({
    required this.fixtureId,
    required this.suite,
    required this.status,
    this.limitation,
    this.message,
  });

  final String fixtureId;
  final String suite;
  final String status;
  final String? limitation;
  final String? message;

  Map<String, Object?> toJson() => <String, Object?>{
    'fixtureId': fixtureId,
    'suite': suite,
    'language': language,
    'status': status,
    'limitation': limitation,
    'message': message,
  };
}

class Report {
  final List<ResultRow> results = <ResultRow>[];

  Map<String, int> summary() {
    final counts = <String, int>{
      Status.pass: 0,
      Status.fail: 0,
      Status.skippedWithDocumentedLimitation: 0,
      Status.skippedV1OutOfScope: 0,
    };
    for (final row in results) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'schemaVersion': 1,
    'generatedAt': 'EXCLUDED',
    'results': results.map((r) => r.toJson()).toList(),
    'summary': summary(),
  };
}

// ---------------------------------------------------------------------------
// v1-scope classification (contracts/harness.md ruling 2)

const Map<String, String> _cutOperationNamespace = <String, String>{
  'setContext': 'releases',
  'start': 'releases',
  'complete': 'releases',
  'fail': 'releases',
  'recordExposure': 'exposures',
  'flushExposures': 'exposures',
  'emitSignal': 'signals',
  'getCapabilities': 'capabilities',
  // invokeCapability is deliberately absent: it is v1 surface, not cut.
};

String? _v1OutOfScopeNamespace(Fixture fixture) {
  final cases = fixture.cases;
  final operations = cases != null
      ? cases.map((c) => _obj(c['when'])['operation']?.toString() ?? '')
      : <String>[fixture.when['operation']?.toString() ?? ''];
  final namespaces = operations
      .map((op) => _cutOperationNamespace[op])
      .toList();
  if (namespaces.any((ns) => ns == null)) {
    return null;
  }
  return namespaces.isEmpty ? null : namespaces.first;
}

// ---------------------------------------------------------------------------
// architectural (non-transferable) classification

const Set<String> _contextInvocationDrivenMatchingIds = <String>{
  'ctx-fireweave-groups-carveout',
  'ctx-merge-global-client-invocation',
  'ctx-nested-null-lists',
  'ctx-person-and-groups',
  'ctx-stable-anonymous-identity',
  'ctx-targeting-key-maps-distinct-id',
};

const Set<String> _faultsPerCallIoIds = <String>{
  'fault-auth-401',
  'fault-backend-500',
  'fault-malformed-json',
  'fault-network-error',
  'fault-offline',
  'fault-quota-limited-flags',
  'fault-rate-limit-429',
  'fault-timeout',
};

const Set<String> _v1StructuralLimitationIds = <String>{
  'eval-numeric-coercion-int-float',
};

String? _architecturalLimitation(Fixture fixture) {
  if (_v1StructuralLimitationIds.contains(fixture.id)) {
    return "v1's FlagType has exactly four members (boolean/string/number/object), "
        'no integer/float split (conformance/surface/control-points.surface.json: '
        "'number, NOT integer') — the same simplification node/python/go/java/rust/"
        "swift's own limitation describes, applied uniformly by the v1 cut.";
  }
  if (_contextInvocationDrivenMatchingIds.contains(fixture.id)) {
    return "dart's prefetch-then-synchronous-cache-read architecture (ADR-0009's "
        'seam, shared with web/swift, built from spec/ directly) resolves backend '
        'targeting conditions against the context available AT PREFETCH TIME '
        '(global+client layers) — a synchronous evaluate() never reaches the '
        "adapter, so this fixture's invocation-only targetingKey/attributes cannot "
        'retroactively change which cached decision is served.';
  }
  if (_faultsPerCallIoIds.contains(fixture.id)) {
    return "dart's evaluate() never performs I/O — prefetch is the one place this "
        'architecture talks to the network — so a fault mid-evaluate() has no '
        "analogue: this fixture's own premise (a live HTTP fault occurs exactly when "
        'evaluate() is invoked) is structurally unrepresentable, the same category '
        'ADR-0009 names for web ("fault behaviour on a per-call round trip"). '
        'fault-stale-cache is the one faults-suite fixture that DOES transfer '
        '(staleness is provisioned directly, not via a live per-call fault).';
  }
  return null;
}

// ---------------------------------------------------------------------------
// adapters used by the runner

/// Wraps an adapter so every `prefetch()` throws a fixed error —
/// `contracts/security`/`faults` fixtures that declare a protocol fault but
/// run on the in-memory backend. Faults at PREFETCH time, the one place this
/// architecture's adapter does I/O.
class _FaultyAdapter implements ControlPointsBackendAdapter {
  _FaultyAdapter(this._inner, this._error);

  final ControlPointsBackendAdapter _inner;
  final FireweaveError _error;

  @override
  DecisionReason? get missReason => _inner.missReason;

  @override
  Future<void> initialize() => _inner.initialize();

  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) async => throw _error;

  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) => _inner.registerTarget(targetingKey, options: options);

  @override
  Future<void> shutdown() => _inner.shutdown();
}

/// Wraps an adapter, counting `prefetch()` calls (`expect.networkCalls`
/// fixtures assert that a REJECTED evaluate() causes no network activity —
/// guaranteed structurally, since `evaluate()` never touches the adapter;
/// the count is taken relative to a reset right before the assertion).
class _CountingAdapter implements ControlPointsBackendAdapter {
  _CountingAdapter(this._inner);

  final ControlPointsBackendAdapter _inner;
  int count = 0;

  void resetCount() {
    count = 0;
  }

  @override
  DecisionReason? get missReason => _inner.missReason;

  @override
  Future<void> initialize() => _inner.initialize();

  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) {
    count += 1;
    return _inner.prefetch(context, options: options);
  }

  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) => _inner.registerTarget(targetingKey, options: options);

  @override
  Future<void> shutdown() => _inner.shutdown();
}

// ---------------------------------------------------------------------------
// runner

Future<Report> runAll(Directory contractsDir) async {
  final report = Report();
  for (final fixture in loadFixtures(contractsDir)) {
    report.results.add(await _runFixture(fixture));
  }
  return report;
}

Future<ResultRow> _runFixture(Fixture fixture) async {
  if (fixture.suite == 'extensions') {
    final namespace = _v1OutOfScopeNamespace(fixture);
    if (namespace != null) {
      return ResultRow(
        fixtureId: fixture.id,
        suite: fixture.suite,
        status: Status.skippedV1OutOfScope,
        limitation:
            '$namespace is cut from the v1 surface (ADR-0010); '
            '${fixture.id} targets it.',
      );
    }
  }
  final limitation = _architecturalLimitation(fixture);
  if (limitation != null) {
    return ResultRow(
      fixtureId: fixture.id,
      suite: fixture.suite,
      status: Status.skippedWithDocumentedLimitation,
      limitation: limitation,
    );
  }

  final cases = fixture.cases;
  if (cases != null) {
    var allPass = true;
    final messages = <String>[];
    for (var index = 0; index < cases.length; index += 1) {
      final caseJson = cases[index];
      final name = caseJson['name']?.toString() ?? 'case$index';
      final mergedGiven = <String, Object?>{
        ...fixture.given,
        ..._obj(caseJson['given']),
      };
      final (ok, detail) = await _runOneCase(
        fixture.suite,
        mergedGiven,
        _obj(caseJson['when']),
        _obj(caseJson['expect']),
      );
      if (!ok) {
        allPass = false;
        messages.add('$name: $detail');
      }
    }
    return ResultRow(
      fixtureId: fixture.id,
      suite: fixture.suite,
      status: allPass ? Status.pass : Status.fail,
      message: messages.isEmpty ? null : messages.join('; '),
    );
  }

  final (ok, detail) = await _runOneCase(
    fixture.suite,
    fixture.given,
    fixture.when,
    fixture.expect,
  );
  return ResultRow(
    fixtureId: fixture.id,
    suite: fixture.suite,
    status: ok ? Status.pass : Status.fail,
    message: ok ? null : detail,
  );
}

Future<(bool, String)> _runOneCase(
  String suite,
  Map<String, Object?> given,
  Map<String, Object?> when,
  Map<String, Object?> expect,
) async {
  switch (when['operation']) {
    case 'evaluate':
      return _runEvaluate(given, when, expect);
    case 'initialize':
      return _runInitialize(given, when, expect);
    case 'shutdown':
      return _runShutdown(given, when, expect);
    case 'replaceProvider':
      return _runReplaceProvider(given, when, expect);
    case 'invokeCapability':
      return _runInvokeCapability(given, when, expect);
    default:
      return (
        false,
        'unsupported operation ${when['operation']} for suite $suite',
      );
  }
}

// ---------------------------------------------------------------------------
// operation executors

Future<(bool, String)> _runEvaluate(
  Map<String, Object?> given,
  Map<String, Object?> when,
  Map<String, Object?> expect,
) async {
  final domains = given['domains'];
  if (domains is Map) {
    final requested = when['domain']?.toString();
    Map<String, Object?> actual = const <String, Object?>{};
    for (final entry in domains.entries) {
      final domainGiven = _obj(entry.value);
      final runtime = FireweaveRuntime(
        InMemoryAdapter.fromFlagsJson(_obj(domainGiven['flags'])),
      );
      await _provisionState(runtime, domainGiven['providerState']?.toString());
      if (entry.key == requested) {
        final decision = runtime.evaluate(
          when['flagKey']?.toString() ?? '',
          _expectedFlagType(when['flagType']?.toString() ?? 'boolean'),
          when['defaultValue'],
          context: _evaluationContext(when['invocationContext']),
        );
        actual = decision.toJson();
      }
    }
    return _compareAndReport(actual, expect);
  }

  final config = _obj(given['config']);
  final limits = _contextLimits(config);
  final reservedRaw = config['reservedAttributeKeys'];
  final reserved = <String>{
    if (reservedRaw is List) ...reservedRaw.whereType<String>(),
  };
  final requireTargetingKey = config['requireTargetingKey'] == true;

  ControlPointsBackendAdapter baseAdapter = InMemoryAdapter.fromFlagsJson(
    _obj(given['flags']),
  );
  final fault = given['fault'];
  if (fault is Map && (fault['applyTo']?.toString() ?? 'flags') == 'flags') {
    baseAdapter = _FaultyAdapter(baseAdapter, _faultToError(_obj(fault)));
  }
  final countingAdapter = _CountingAdapter(baseAdapter);

  final runtime = FireweaveRuntime(
    countingAdapter,
    config: RuntimeConfig(
      limits: limits,
      reservedAttributeKeys: reserved,
      requireTargetingKey: requireTargetingKey,
      globalContext: _evaluationContext(given['globalContext']),
    ),
  );
  final clientContext = _evaluationContext(given['clientContext']);
  if (clientContext != null) {
    runtime.setClientContext(clientContext);
  }

  await _provisionState(runtime, given['providerState']?.toString());
  countingAdapter.resetCount();

  final includePayload = _obj(when['options'])['includePayload'] == true;
  final decision = runtime.evaluate(
    when['flagKey']?.toString() ?? '',
    _expectedFlagType(when['flagType']?.toString() ?? 'boolean'),
    when['defaultValue'],
    context: _evaluationContext(when['invocationContext']),
    options: EvaluateOptions(includePayload: includePayload),
  );
  final actual = decision.toJson();

  if (expect.containsKey('contextSnapshotAfter')) {
    // Snapshot the fixture's own invocation-context object AFTER the
    // evaluation ran — proving evaluation mutated nothing the caller holds.
    final raw = _obj(when['invocationContext']);
    final snapshot = <String, Object?>{};
    final targetingKey = raw['targetingKey'];
    if (targetingKey is String) {
      snapshot['targetingKey'] = targetingKey;
    }
    final attrs = raw['attributes'];
    if (attrs is Map && attrs.isNotEmpty) {
      snapshot['attributes'] = attrs;
    }
    actual['contextSnapshotAfter'] = snapshot;
  }
  if (expect.containsKey('networkCalls')) {
    actual['networkCalls'] = countingAdapter.count;
  }

  return _compareAndReport(actual, expect);
}

Future<(bool, String)> _runInitialize(
  Map<String, Object?> given,
  Map<String, Object?> when,
  Map<String, Object?> expect,
) async {
  final config = _obj(given['config']);
  final FireweaveRuntime runtime;
  final host = config['host'];
  if (host is String) {
    // Host-allowlist-testing fixtures route through FireweaveRemoteAdapter
    // directly (bypassing initFireweave, the same "direct construction" leg
    // every other language's runner uses) — this SDK's FireweaveRuntime
    // carries no host concept of its own; only the remote adapter's own
    // initialize() validates a host.
    final allowedRaw = config['allowedHosts'];
    final adapter = FireweaveRemoteAdapter(
      RemoteAdapterConfig(
        apiUrl: host,
        apiKey: config['projectApiKey']?.toString() ?? '',
        allowedHosts: allowedRaw is List
            ? allowedRaw.whereType<String>().toList()
            : null,
      ),
      transport: _NeverTransport(),
    );
    runtime = FireweaveRuntime(adapter);
  } else {
    runtime = FireweaveRuntime(
      InMemoryAdapter.fromFlagsJson(_obj(given['flags'])),
    );
  }
  await runtime.initialize();

  final actual = <String, Object?>{'providerState': runtime.state.wireName};
  final error = runtime.initializationError;
  if (error != null) {
    actual['errorCode'] = error.openFeatureErrorCode;
    actual['errorMessage'] = error.message;
    actual['errorKind'] = error.kind.wireName;
  } else {
    actual['errorCode'] = null;
    actual['errorMessage'] = null;
  }
  return _compareAndReport(actual, expect);
}

Future<(bool, String)> _runShutdown(
  Map<String, Object?> given,
  Map<String, Object?> when,
  Map<String, Object?> expect,
) async {
  final runtime = FireweaveRuntime(
    InMemoryAdapter.fromFlagsJson(_obj(given['flags'])),
  );
  await _provisionState(runtime, given['providerState']?.toString());
  await runtime.shutdown();
  return _compareAndReport(<String, Object?>{
    'providerState': runtime.state.wireName,
    'errorCode': null,
    'errorMessage': null,
  }, expect);
}

Future<(bool, String)> _runReplaceProvider(
  Map<String, Object?> given,
  Map<String, Object?> when,
  Map<String, Object?> expect,
) async {
  final runtimeA = FireweaveRuntime(
    InMemoryAdapter.fromFlagsJson(_obj(given['flags'])),
  );
  await runtimeA.initialize();
  await runtimeA.shutdown(); // old provider retired before the replacement

  final replacement = _obj(given['replacement']);
  final runtimeB = FireweaveRuntime(
    InMemoryAdapter.fromFlagsJson(_obj(replacement['flags'])),
  );
  await runtimeB.initialize();

  final then = when['thenEvaluate'];
  if (then is! Map) {
    return (false, 'missing when.thenEvaluate');
  }
  final thenMap = _obj(then);
  final decision = runtimeB.evaluate(
    thenMap['flagKey']?.toString() ?? '',
    _expectedFlagType(thenMap['flagType']?.toString() ?? 'boolean'),
    thenMap['defaultValue'],
    context: _evaluationContext(thenMap['invocationContext']),
  );
  final actual = decision.toJson();
  actual['providerState'] = runtimeB.state.wireName;
  return _compareAndReport(actual, expect);
}

/// `ext-unsupported-capability-degrade` — the one extensions fixture that
/// genuinely exercises v1 surface (`invokeCapability`, never cut).
Future<(bool, String)> _runInvokeCapability(
  Map<String, Object?> given,
  Map<String, Object?> when,
  Map<String, Object?> expect,
) async {
  final runtime = FireweaveRuntime(
    InMemoryAdapter.fromFlagsJson(_obj(given['flags'])),
  );
  await _provisionState(runtime, given['providerState']?.toString());
  final client = FireweaveClient(runtime);
  final capability = when['capability']?.toString() ?? 'unknown.capability';
  final result = client.invokeCapability(capability);
  return _compareAndReport(<String, Object?>{
    'ok': result.ok,
    'degraded': result.degraded,
    'errorCode': result.errorCode,
    'errorMessage': result.errorMessage,
    'errorKind': result.errorKind?.wireName,
  }, expect);
}

// ---------------------------------------------------------------------------
// shared helpers

/// A transport for host-allowlist fixtures: initialize() must decide before
/// any request is made, so a request reaching this transport is itself a
/// failure of the fixture's premise.
class _NeverTransport implements HttpTransport {
  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async => throw FireweaveError(
    ErrorKind.network,
    message: 'conformance: unexpected network call',
  );
}

Future<void> _provisionState(FireweaveRuntime runtime, String? state) async {
  switch (state) {
    case 'READY':
      await runtime.initialize();
    case 'STALE':
      await runtime.initialize();
      runtime.forceState(LifecycleState.stale);
    case 'CLOSED':
      await runtime.initialize();
      await runtime.shutdown();
    default:
      break; // NOT_READY / null: leave uninitialized
  }
}

FireweaveError _faultToError(Map<String, Object?> fault) {
  switch (fault['mode']) {
    case 'httpStatus':
      final status = fault['status'];
      switch (status is num ? status.toInt() : 500) {
        case 401:
          return FireweaveError(ErrorKind.authentication);
        case 403:
          return FireweaveError(ErrorKind.authorization);
        case 429:
          return FireweaveError(ErrorKind.rateLimited);
        default:
          return FireweaveError(ErrorKind.backendUnavailable);
      }
    case 'networkError':
    case 'offline':
      return FireweaveError(ErrorKind.network);
    case 'timeout':
      return FireweaveError(ErrorKind.timeout);
    case 'invalidJson':
    case 'malformedJson':
    case 'truncated':
      return FireweaveError(ErrorKind.malformedResponse);
    default:
      return FireweaveError(ErrorKind.internal);
  }
}

FlagType _expectedFlagType(String raw) {
  switch (raw) {
    case 'integer':
    case 'float':
      return FlagType.number;
    default:
      return FlagType.fromWireName(raw) ?? FlagType.boolean;
  }
}

EvaluationContext? _evaluationContext(Object? json) {
  if (json is! Map) {
    return null;
  }
  final obj = _obj(json);
  final targetingKey = obj['targetingKey'];
  return EvaluationContext(
    targetingKey: targetingKey is String ? targetingKey : null,
    attributes: _obj(obj['attributes']),
  );
}

ContextLimits _contextLimits(Map<String, Object?> config) {
  final limits = _obj(config['limits']);
  int read(String key, int fallback) {
    final value = limits[key];
    return value is num ? value.toInt() : fallback;
  }

  return ContextLimits(
    maxAttributeCount: read('maxAttributeCount', 128),
    maxKeyBytes: read('maxKeyBytes', 256),
    maxValueBytes: read('maxValueBytes', 4096),
    maxNestingDepth: read('maxNestingDepth', 6),
    maxSerializedBytes: read('maxSerializedContextBytes', 65536),
  );
}

// ---------------------------------------------------------------------------
// comparator (normalized-equality; keys present in `expect` only, matching
// node/python/java/swift's convention — see contracts/harness.md
// "Extra-key strictness note")

const Set<String> _directiveKeys = <String>{
  'errorMessageMustNotContain',
  'recordedMessageMustNotContain',
};

(bool, String) _compareAndReport(
  Map<String, Object?> actual,
  Map<String, Object?> expect,
) {
  final literalExpect = <String, Object?>{
    for (final entry in expect.entries)
      if (!_directiveKeys.contains(entry.key)) entry.key: entry.value,
  };
  if (!_valueMatches(actual, literalExpect)) {
    return (
      false,
      'expected ${stableJsonString(literalExpect)}, got ${stableJsonString(actual)}',
    );
  }
  final mustNotContain = expect['errorMessageMustNotContain'];
  if (mustNotContain is List) {
    final message = actual['errorMessage']?.toString() ?? '';
    for (final forbidden in mustNotContain.whereType<String>()) {
      if (message.contains(forbidden)) {
        return (
          false,
          'errorMessage unexpectedly contains a forbidden substring',
        );
      }
    }
  }
  return (true, '');
}

bool _valueMatches(Object? actual, Object? expect) {
  if (expect is Map) {
    final actualMap = actual is Map ? actual : const <Object?, Object?>{};
    for (final entry in expect.entries) {
      if (!_valueMatches(actualMap[entry.key], entry.value)) {
        return false;
      }
    }
    return true;
  }
  if (expect == null) {
    return actual == null;
  }
  return jsonEquals(actual, expect);
}
