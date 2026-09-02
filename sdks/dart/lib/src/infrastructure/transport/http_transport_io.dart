import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../../application/ports.dart';
import '../../domain/errors.dart';

/// `dart:io`-backed [HttpTransport] — the production transport on the Dart
/// VM and on Flutter for Android, iOS, macOS, Windows, and Linux. Chosen by
/// conditional import in `default_http_transport.dart`; this file is the
/// ONLY place in `lib/` that imports `dart:io` (`test/portability_guard_test.dart`
/// pins that), so the rest of the package compiles for the web unchanged,
/// where `http_transport_web.dart` takes its place.
class IoHttpTransport implements HttpTransport {
  IoHttpTransport({HttpClient? client}) : _client = client ?? HttpClient();

  final HttpClient _client;

  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async {
    try {
      final request = await _client.postUrl(url).timeout(timeout);
      headers.forEach(request.headers.set);
      request.add(utf8.encode(body));
      final response = await request.close().timeout(timeout);
      final text = await response
          .transform(utf8.decoder)
          .join()
          .timeout(timeout);
      return TransportResponse(statusCode: response.statusCode, body: text);
    } on TimeoutException {
      throw FireweaveError(ErrorKind.timeout);
    } on IOException {
      // SocketException, HttpException, HandshakeException, ...
      throw FireweaveError(ErrorKind.network);
    }
  }

  void close() => _client.close(force: true);
}

/// Platform default: a fresh `dart:io` client.
HttpTransport createDefaultHttpTransport() => IoHttpTransport();
