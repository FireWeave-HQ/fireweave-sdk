import 'package:fireweave/fireweave.dart';

/// Test-only adapter whose `prefetch` can be delayed and/or made to fail —
/// used to exercise `FireweaveRuntime.refresh()`'s ceiling race
/// deterministically, without depending on real network timing.
class SlowFakeAdapter implements ControlPointsBackendAdapter {
  SlowFakeAdapter({
    required this.delay,
    this.result = const <String, AdapterResolution>{},
    this.shouldFail,
  });

  final Duration delay;
  final PrefetchResult result;
  final FireweaveError? shouldFail;
  int prefetchCallCount = 0;

  @override
  DecisionReason? get missReason => null;

  @override
  Future<void> initialize() async {}

  @override
  Future<PrefetchResult> prefetch(
    EvaluationContext context, {
    PrefetchOptions? options,
  }) async {
    prefetchCallCount += 1;
    await Future<void>.delayed(delay);
    final failure = shouldFail;
    if (failure != null) {
      throw failure;
    }
    return result;
  }

  @override
  Future<RegisterTargetResult> registerTarget(
    String targetingKey, {
    RegisterTargetOptions? options,
  }) async => const RegisterTargetResult.success();

  @override
  Future<void> shutdown() async {}
}

/// Injectable fake transport — no real sockets. Returns a fixed status/body
/// for every request, recording what was sent for assertions.
class FakeTransport implements HttpTransport {
  FakeTransport({this.statusCode = 200, required this.body});

  final int statusCode;
  final String body;
  Uri? lastUrl;
  Map<String, String>? lastHeaders;
  String? lastBody;
  int calls = 0;

  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async {
    calls += 1;
    lastUrl = url;
    lastHeaders = headers;
    lastBody = body;
    return TransportResponse(statusCode: statusCode, body: this.body);
  }
}

/// Transport that throws a fixed [FireweaveError] on every request.
class ThrowingTransport implements HttpTransport {
  ThrowingTransport(this.error);

  final FireweaveError error;

  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async => throw error;
}
