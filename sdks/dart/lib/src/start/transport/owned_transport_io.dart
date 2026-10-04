import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:fireweave/fireweave.dart';

import 'owned_transport_types.dart';

/// `dart:io` transport owned by the start profile.
///
/// Unlike the core's, it has one overall deadline per request that aborts
/// the request when it elapses (the core wraps each stage in its own
/// timeout and never aborts), keeps few idle connections, and is closed by
/// `fw.shutdown()`, so a VM process can exit right after it.
final class IoOwnedTransport implements OwnedTransport {
  IoOwnedTransport()
    : _client = HttpClient()
        ..idleTimeout = const Duration(seconds: 5)
        ..maxConnectionsPerHost = 4;

  final HttpClient _client;
  bool _closed = false;

  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async {
    if (_closed) {
      throw FireweaveError(ErrorKind.network);
    }
    HttpClientRequest? request;
    Future<TransportResponse> send() async {
      final r = await _client.postUrl(url);
      request = r;
      headers.forEach(r.headers.set);
      r.add(utf8.encode(body));
      final response = await r.close();
      final text = await response.transform(utf8.decoder).join();
      return TransportResponse(statusCode: response.statusCode, body: text);
    }

    try {
      return await send().timeout(timeout);
    } on TimeoutException {
      request?.abort();
      throw FireweaveError(ErrorKind.timeout);
    } on IOException {
      throw FireweaveError(ErrorKind.network);
    }
  }

  @override
  void close() {
    if (_closed) {
      return;
    }
    _closed = true;
    _client.close(force: true);
  }
}

/// `dart:io` platforms: a fresh owned transport.
OwnedTransport? createOwnedTransport() => IoOwnedTransport();

/// Whether this platform has `dart:io`: yes.
const bool hasDartIo = true;
