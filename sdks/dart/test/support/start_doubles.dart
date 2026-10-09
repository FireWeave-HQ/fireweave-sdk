import 'dart:convert';

import 'package:fireweave/fireweave.dart';

/// One request a [RoutingTransport] saw.
class SeenRequest {
  SeenRequest(this.url, this.headers, this.body);

  final Uri url;
  final Map<String, String> headers;
  final Map<String, Object?> body;

  String get path => url.path;
}

/// Fake fw-server over the [HttpTransport] port: answers
/// `/v1/control-points/evaluate` with [decisions] and `/v1/targets/register` with
/// 200, unless a status or a throw is configured. Records every request.
class RoutingTransport implements HttpTransport {
  RoutingTransport({
    Map<String, Object?>? decisions,
    this.evaluateStatus = 200,
    this.registerStatus = 200,
    this.evaluateBody,
    this.throwOnEvaluate,
  }) : decisions = decisions ?? <String, Object?>{};

  /// controlPointKey -> value served by evaluate.
  Map<String, Object?> decisions;
  int evaluateStatus;
  int registerStatus;

  /// Raw evaluate body, overriding [decisions] (malformed responses).
  String? evaluateBody;

  /// Thrown by evaluate instead of answering (Network, Timeout, ...).
  FireweaveError? throwOnEvaluate;

  final List<SeenRequest> requests = <SeenRequest>[];

  List<SeenRequest> get evaluates =>
      requests.where((r) => r.path == '/v1/control-points/evaluate').toList();
  List<SeenRequest> get registers =>
      requests.where((r) => r.path == '/v1/targets/register').toList();

  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async {
    requests.add(
      SeenRequest(
        url,
        Map<String, String>.of(headers),
        (jsonDecode(body) as Map).cast<String, Object?>(),
      ),
    );
    if (url.path == '/v1/targets/register') {
      return TransportResponse(statusCode: registerStatus, body: '{}');
    }
    final failure = throwOnEvaluate;
    if (failure != null) {
      throw failure;
    }
    return TransportResponse(
      statusCode: evaluateStatus,
      body: evaluateBody ?? evaluateResponse(decisions),
    );
  }
}

/// A `/v1/control-points/evaluate` response body serving [values].
String evaluateResponse(Map<String, Object?> values) =>
    jsonEncode(<String, Object?>{
      'decisions': <Object?>[
        for (final entry in values.entries)
          <String, Object?>{
            'controlPointKey': entry.key,
            'found': true,
            'enabled': true,
            'value': entry.value,
            'variant': 'on',
            'reason': 'TARGETING_MATCH',
          },
      ],
    });

/// Collects log lines.
class LogCapture {
  final List<String> lines = <String>[];

  void call(String line) => lines.add(line);

  Iterable<String> containing(String text) =>
      lines.where((l) => l.contains(text));
}
