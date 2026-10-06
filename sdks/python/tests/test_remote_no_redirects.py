"""The remote adapter never follows a redirect (F5). urllib's default redirect
handler re-sends the request headers, ``Authorization`` included, to the
redirect target; the adapter must instead surface a 3xx as BackendUnavailable
and send nothing to the second host. Real HTTP against two local servers."""

from __future__ import annotations

import http.server
import threading
import urllib.request
from contextlib import contextmanager

from fireweave import EvaluationContext, ErrorKind, RegisterTargetOptions, init_fireweave
from fireweave.infrastructure.adapters import remote

KEY = "project-api-key_REDIRECTSENTINEL"
CTX = EvaluationContext("user-1")


@contextmanager
def _server(handler_cls):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()


def _quiet(handler_cls):
    handler_cls.log_message = lambda self, *args: None
    return handler_cls


@contextmanager
def _redirect_pair(status=302):
    received = []

    @_quiet
    class Target(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            received.append((self.path, dict(self.headers)))
            body = b'{"decisions":[{"controlPointKey":"x","value":true,"found":true}]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST  # noqa: N815

    with _server(Target) as target:
        target_url = f"http://127.0.0.1:{target.server_address[1]}"

        @_quiet
        class Redirector(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                self.send_response(status)
                self.send_header("Location", f"{target_url}{self.path}")
                self.send_header("Content-Length", "0")
                self.end_headers()

        with _server(Redirector) as redirector:
            yield f"http://127.0.0.1:{redirector.server_address[1]}", received


def test_a_302_is_backend_unavailable_and_the_redirect_target_receives_nothing():
    with _redirect_pair(302) as (url, received):
        client = init_fireweave(mode="remote", api_key=KEY, api_url=url)
        try:
            decision = client.control_points.get_boolean_details("x", False, CTX)
            result = client.register_target("user-1", RegisterTargetOptions(properties={"plan": "pro"}))
        finally:
            client.shutdown()
    assert (decision.value, decision.reason, decision.error_kind) == (False, "ERROR", ErrorKind.BACKEND_UNAVAILABLE)
    assert result.ok is False and result.error.kind is ErrorKind.BACKEND_UNAVAILABLE
    assert received == [], "the redirect target received a request (and the Authorization header with it)"


def test_a_307_is_refused_too():
    with _redirect_pair(307) as (url, received):
        client = init_fireweave(mode="remote", api_key=KEY, api_url=url)
        try:
            decision = client.control_points.get_boolean_details("x", False, CTX)
        finally:
            client.shutdown()
    assert decision.error_kind is ErrorKind.BACKEND_UNAVAILABLE
    assert received == []


def test_an_injected_transport_answering_3xx_is_backend_unavailable():
    client = init_fireweave(
        mode="remote", api_key=KEY, api_url="http://127.0.0.1:1", transport=lambda *a: (302, {"decisions": []})
    )
    assert client.control_points.get_boolean_details("x", False, CTX).error_kind is ErrorKind.BACKEND_UNAVAILABLE


def test_proxies_still_come_from_the_environment(monkeypatch):
    seen = []

    @_quiet
    class Proxy(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            seen.append(self.path)  # a proxied request carries the absolute URL
            body = b'{"decisions":[{"controlPointKey":"x","value":true,"found":true}]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with _server(Proxy) as proxy:
        for name in ("no_proxy", "NO_PROXY"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("http_proxy", f"http://127.0.0.1:{proxy.server_address[1]}")
        monkeypatch.setattr(remote, "_OPENER", {})  # build a fresh opener under this environment
        client = init_fireweave(mode="remote", api_key=KEY, api_url="http://127.0.0.1:9")
        try:
            assert client.control_points.get_boolean_value("x", False, CTX) is True
        finally:
            client.shutdown()
    assert seen == ["http://127.0.0.1:9/v1/control-points/evaluate"]
    redirects = [h for h in remote._opener().handlers if isinstance(h, urllib.request.HTTPRedirectHandler)]
    assert redirects and all(isinstance(h, remote._RefuseRedirects) for h in redirects)
