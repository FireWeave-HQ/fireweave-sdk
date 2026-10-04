import 'dart:async';
import 'dart:js_interop';

import '../../application/ports.dart';
import '../../domain/errors.dart';

/// `fetch`-backed [HttpTransport] for the web — Flutter web and any Dart
/// program compiled to JavaScript or WebAssembly. Chosen by conditional
/// import in `default_http_transport.dart` wherever `dart:js_interop` exists
/// and `dart:io` does not.
///
/// Hand-written `dart:js_interop` bindings rather than `package:http` or
/// `package:web`: both are pub dependencies, and the zero-dependency budget
/// (ADR-0011) is what keeps eight languages tractable. `dart:js_interop` is
/// an SDK library — the same standing `dart:io` has on the VM. It also works
/// under `dart compile wasm`, which the retired `dart:html` never did. This
/// is the ONLY file in `lib/` that imports `dart:js_interop`
/// (`test/portability_guard_test.dart` pins that).
///
/// The browser's own origin model applies: fw-server must answer CORS
/// preflights for the app's origin (ADR-0009 "CORS becomes a platform
/// property"), and a CORS rejection surfaces here as `Network`, exactly like
/// a refused connection — the browser reports both as a rejected `fetch`.
@JS('fetch')
external JSPromise<_Response> _fetch(JSString resource, _RequestInit init);

@JS('AbortController')
extension type _AbortController._(JSObject _) implements JSObject {
  external factory _AbortController();
  external JSObject get signal;
  external void abort();
}

/// `RequestInit` object literal (an external factory with only named
/// parameters builds a plain JS object).
extension type _RequestInit._(JSObject _) implements JSObject {
  external factory _RequestInit({
    JSString method,
    JSObject headers,
    JSString body,
    JSObject signal,
  });
}

extension type _Response._(JSObject _) implements JSObject {
  external JSNumber get status;
  external JSPromise<JSString> text();
}

class WebHttpTransport implements HttpTransport {
  const WebHttpTransport();

  @override
  Future<TransportResponse> post(
    Uri url, {
    required Map<String, String> headers,
    required String body,
    required Duration timeout,
  }) async {
    final controller = _AbortController();
    final init = _RequestInit(
      method: 'POST'.toJS,
      headers: headers.jsify() as JSObject,
      body: body.toJS,
      signal: controller.signal,
    );

    final _Response response;
    try {
      response = await _fetch(url.toString().toJS, init).toDart.timeout(
        timeout,
        onTimeout: () {
          controller.abort();
          throw FireweaveError(ErrorKind.timeout);
        },
      );
    } on FireweaveError {
      rethrow;
    } on Object {
      // `fetch` rejects with a TypeError on a refused connection, a DNS
      // failure, a CORS rejection, or an abort — all Network here.
      throw FireweaveError(ErrorKind.network);
    }

    final String text;
    try {
      text = (await response.text().toDart.timeout(timeout)).toDart;
    } on TimeoutException {
      controller.abort();
      throw FireweaveError(ErrorKind.timeout);
    } on Object {
      throw FireweaveError(ErrorKind.network);
    }
    return TransportResponse(statusCode: response.status.toDartInt, body: text);
  }
}

/// Platform default: the browser's `fetch`.
HttpTransport createDefaultHttpTransport() => const WebHttpTransport();
