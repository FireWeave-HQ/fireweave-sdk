import 'dart:convert';
import 'dart:io';

import 'start_doubles.dart';

/// A real HTTP fw-server stand-in on loopback, for remote-mode tests over
/// the start profile's own `dart:io` transport.
class LoopbackFwServer {
  LoopbackFwServer._(this._server);

  static Future<LoopbackFwServer> start({
    Map<String, Object?> decisions = const <String, Object?>{},
    int status = 200,
  }) async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final fw = LoopbackFwServer._(server)
      ..decisions = decisions
      ..status = status;
    server.listen(fw._handle);
    return fw;
  }

  final HttpServer _server;
  Map<String, Object?> decisions = const <String, Object?>{};
  int status = 200;
  final List<({String path, String? authorization, Map<String, Object?> body})>
  requests =
      <({String path, String? authorization, Map<String, Object?> body})>[];

  String get url => 'http://127.0.0.1:${_server.port}';

  Future<void> _handle(HttpRequest request) async {
    final text = await utf8.decoder.bind(request).join();
    requests.add((
      path: request.uri.path,
      authorization: request.headers.value('authorization'),
      body: (jsonDecode(text) as Map).cast<String, Object?>(),
    ));
    request.response.statusCode = status;
    request.response.headers.contentType = ContentType.json;
    request.response.write(
      request.uri.path == '/v1/flags/evaluate'
          ? evaluateResponse(decisions)
          : '{}',
    );
    await request.response.close();
  }

  Future<void> close() => _server.close(force: true);
}
