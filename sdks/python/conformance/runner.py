"""Fireweave Python conformance runner (contracts/harness.md).

Loads the fixture suites under ``contracts/``, executes each against the SDK,
normalizes results per the normative comparator, and emits a results JSON.

Suite -> execution backend:

- context / evaluation / lifecycle / extensions / security: InMemoryAdapter.
- faults: PostHogAdapter with real HTTP against the local test-server stub
  (``test-server/implementation/server.mjs``, spawned on demand) for the
  fault modes the harness prescribes (``delay``/``401``/``429``/``500``/
  invalid JSON/quota-limited) — reported ``via=http-stub``. Network/offline
  faults use a real refused loopback TCP connection
  (``via=http-refused-connection``). If ``node`` is unavailable the runner
  falls back to an injected fake transport (``via=injected-fake-transport``).

Multi-case fixtures (``cases`` array, contracts/README.md) run every case
against a fresh harness; the fixture passes only when all cases pass.
"""

from __future__ import annotations

import atexit
import copy
import json
import socket
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]

from fireweave import (
    CapabilityRegistry,
    ContextLimits,
    EvaluationContext,
    EvaluationOptions,
    FireweaveClient,
    FireweaveConfig,
    FireweaveRuntime,
    InMemoryAdapter,
    LifecycleState,
)
from fireweave.errors import FireweaveError
from fireweave.types import FlagType

LANGUAGE = "python"

# Normative EXCLUDE_SET (contracts/harness.md).
EXCLUDE_SET = {
    "timestamp", "evaluatedAt", "ts", "createdAt", "updatedAt", "stack",
    "stackTrace", "requestId", "uuid", "traceId", "spanId", "messageId",
    "latencyMs", "durationMs", "pid", "hostname",
}

# Expect-side directives that are assertions, not payload fields.
_DIRECTIVE_KEYS = {"errorMessageMustNotContain", "recordedMessageMustNotContain"}

_FLAG_TYPES = {
    "boolean": FlagType.BOOLEAN,
    "string": FlagType.STRING,
    "integer": FlagType.INTEGER,
    "float": FlagType.FLOAT,
    "object": FlagType.OBJECT,
}

_EXT_CAPS = {
    "releases": ["releases.setContext", "releases.start", "releases.complete", "releases.fail"],
    "exposures": ["exposures.record", "exposures.flush"],
    "signals": [
        "signals.recordHealth", "signals.recordError",
        "signals.recordMetric", "signals.recordOutcome",
    ],
    "capabilities": ["capabilities.get"],
}


# --------------------------------------------------------------------------
# fixture -> SDK object construction
# --------------------------------------------------------------------------

def config_from_fixture(cfg: Dict[str, Any]) -> FireweaveConfig:
    limits_d = cfg.get("limits", {})
    limits = ContextLimits(
        max_attribute_count=limits_d.get("maxAttributeCount", 128),
        max_key_bytes=limits_d.get("maxKeyBytes", 256),
        max_value_bytes=limits_d.get("maxValueBytes", 4096),
        max_nesting_depth=limits_d.get("maxNestingDepth", 6),
        max_serialized_bytes=limits_d.get("maxSerializedContextBytes", 65536),
    )
    return FireweaveConfig(
        project_api_key=cfg.get("projectApiKey"),
        host=cfg.get("host"),
        limits=limits,
        local_evaluation=cfg.get("localEvaluation", False),
        only_evaluate_locally=cfg.get("onlyEvaluateLocally", False),
        require_targeting_key=cfg.get("requireTargetingKey", False),
        allow_anonymous=cfg.get("allowAnonymous", True),
        allowed_hosts=tuple(cfg["allowedHosts"]) if "allowedHosts" in cfg else None,
        reserved_attribute_keys=tuple(
            cfg.get("reservedAttributeKeys", ("targetingKey", "kind"))
        ),
        feature_flags_request_timeout_ms=cfg.get("featureFlagsRequestTimeoutMs", 3000),
    )


def context_from_fixture(ctx: Optional[Dict[str, Any]]) -> Optional[EvaluationContext]:
    if ctx is None:
        return None
    return EvaluationContext(
        targeting_key=ctx.get("targetingKey"),
        attributes=ctx.get("attributes", {}),
    )


class _CountingAdapter:
    """Wraps an adapter, counting resolve() calls (networkCalls observations)."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner
        self.resolve_calls = 0

    def initialize(self) -> None:
        self._inner.initialize()

    def resolve(self, flag_key: str, context: EvaluationContext) -> Any:
        self.resolve_calls += 1
        return self._inner.resolve(flag_key, context)

    def shutdown(self, timeout_ms: int) -> None:
        self._inner.shutdown(timeout_ms)

    def __getattr__(self, name: str) -> Any:
        # Forward optional adapter surface (backend_name, runtime_features,
        # telemetry sinks) so wrapping does not hide capabilities.
        return getattr(self._inner, name)


class _StubServer:
    """One shared local test-server stub process (loopback, random port)."""

    _singleton: Optional["_StubServer"] = None
    _failed = False

    def __init__(self, url: str, process: subprocess.Popen) -> None:
        self.url = url
        self.process = process

    @classmethod
    def instance(cls) -> Optional["_StubServer"]:
        """Start (once) and return the stub, or None when node is missing."""
        if cls._failed:
            return None
        if cls._singleton is None:
            try:
                cls._singleton = cls._start()
            except Exception:
                cls._failed = True
                return None
        return cls._singleton

    @classmethod
    def _start(cls) -> "_StubServer":
        import requests

        server_mjs = REPO_ROOT / "test-server" / "implementation" / "server.mjs"
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        process = subprocess.Popen(
            ["node", str(server_mjs), "--port", str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        url = f"http://127.0.0.1:{port}"
        deadline = time.time() + 10.0
        while True:
            if process.poll() is not None:
                raise RuntimeError("test-server exited during startup")
            try:
                if requests.get(f"{url}/health", timeout=0.25).ok:
                    break
            except Exception:
                pass
            if time.time() > deadline:
                process.terminate()
                raise RuntimeError("test-server did not become healthy")
            time.sleep(0.05)
        stub = cls(url, process)
        atexit.register(stub.stop)
        return stub

    def _admin(self, path: str, payload: Dict[str, Any]) -> None:
        import requests

        requests.post(f"{self.url}{path}", json=payload, timeout=2).raise_for_status()

    def reset(self) -> None:
        self._admin("/_test/reset", {})

    def set_fault(self, payload: Dict[str, Any]) -> None:
        self._admin("/_test/fault", payload)

    def stop(self) -> None:
        try:
            self.process.terminate()
            self.process.wait(timeout=3)
        except Exception:
            try:
                self.process.kill()
            except Exception:
                pass


def _stub_fault_payload(fault: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Map a fixture fault to the stub admin /_test/fault payload."""
    mode = fault.get("mode")
    if mode == "httpStatus":
        return {"mode": str(fault["status"])}
    if mode == "invalidJson":
        payload: Dict[str, Any] = {"mode": "invalid_json"}
        if fault.get("body") is not None:
            payload["body"] = fault["body"]
        return payload
    if mode == "delay":
        return {"mode": "delay", "delayMs": int(fault.get("delayMs", 1000))}
    if mode == "quotaLimited":
        return {"mode": "quota_limited"}
    return None  # networkError / offline: no HTTP response exists to stub


def _refused_base_url() -> str:
    """Loopback URL on an ephemeral port with no listener (real ECONNREFUSED)."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"


class HttpStubTransport:
    """Real-HTTP snapshot transport speaking the /flags?v=2 protocol."""

    def __init__(self, base_url: str, config: FireweaveConfig) -> None:
        self._base = base_url
        self._config = config
        self.calls = 0

    def fetch(self, distinct_id, groups, person_properties, group_properties):
        import requests

        from fireweave.adapters.posthog import (
            SnapshotData,
            VendorFlagRecord,
            _parse_payload,
        )

        self.calls += 1
        timeout = self._config.feature_flags_request_timeout_ms / 1000.0
        response = requests.post(
            f"{self._base}/flags?v=2",
            json={
                "token": self._config.project_api_key or "phc_conformance",
                "distinct_id": distinct_id,
                "groups": groups or {},
                "person_properties": person_properties or {},
                "group_properties": group_properties or {},
            },
            timeout=timeout,
        )
        if response.status_code >= 400:
            raise requests.exceptions.HTTPError(response=response)
        data = response.json()  # raises a json.JSONDecodeError subclass
        flags: Dict[str, Any] = {}
        for key, rec in (data.get("flags") or {}).items():
            metadata = rec.get("metadata") or {}
            reason = rec.get("reason") or {}
            flags[key] = VendorFlagRecord(
                key=key,
                enabled=bool(rec.get("enabled")),
                variant=rec.get("variant"),
                payload=_parse_payload(metadata.get("payload")),
                flag_id=metadata.get("id"),
                version=metadata.get("version"),
                reason=reason.get("code"),
            )
        return SnapshotData(
            flags=flags, quota_limited=bool(data.get("quotaLimited"))
        )


class FaultTransport:
    """Injected snapshot transport that reproduces test-server fault modes
    by raising real ``requests`` exceptions (or returning fault bodies).

    Fallback only: used when the HTTP stub cannot start (no ``node``)."""

    def __init__(self, fault: Dict[str, Any], config: FireweaveConfig) -> None:
        self._fault = fault
        self._config = config
        self.calls = 0

    def fetch(self, distinct_id, groups, person_properties, group_properties):
        import requests

        from fireweave.adapters.posthog import SnapshotData

        self.calls += 1
        mode = self._fault.get("mode")
        if mode == "httpStatus":
            response = requests.models.Response()
            response.status_code = int(self._fault["status"])
            raise requests.exceptions.HTTPError(response=response)
        if mode == "networkError" or mode == "offline":
            raise requests.exceptions.ConnectionError(self._fault.get("error", "offline"))
        if mode == "delay":
            delay_ms = int(self._fault.get("delayMs", 0))
            timeout_ms = self._config.feature_flags_request_timeout_ms
            if delay_ms > timeout_ms:
                # Injected transport honors the client timeout without
                # actually sleeping the full fault delay.
                time.sleep(timeout_ms / 1000.0)
                raise requests.exceptions.Timeout()
            time.sleep(delay_ms / 1000.0)
            return SnapshotData()
        if mode == "invalidJson":
            json.loads(self._fault.get("body", "{not-json"))  # raises JSONDecodeError
            return SnapshotData()
        if mode == "quotaLimited":
            return SnapshotData(flags={}, quota_limited=True)
        raise AssertionError(f"unknown fault mode: {mode}")


class _Harness:
    """One provider domain: adapter + runtime + client built from `given`."""

    def __init__(self, given: Dict[str, Any], suite: str) -> None:
        self.given = given
        self.suite = suite
        self.config = config_from_fixture(given.get("config", {}))
        self.via = "in-memory"
        self.adapter = self._build_adapter()
        self.runtime = FireweaveRuntime(
            self.adapter,
            self.config,
            global_context=context_from_fixture(given.get("globalContext")),
        )
        registry = self._build_registry()
        self.client = FireweaveClient(self.runtime, capabilities=registry)
        if given.get("clientContext") is not None:
            self.client.set_context(context_from_fixture(given["clientContext"]))
        # Provider state first: extension seeding goes through the public,
        # lifecycle-gated API (ruling 17), so READY must be applied before.
        self._apply_provider_state(given.get("providerState"))
        self._seed_extensions()

    def _build_adapter(self) -> Any:
        fault = self.given.get("fault")
        use_fault_transport = fault is not None and not self._is_stale_cache_fault(fault)
        if use_fault_transport:
            from fireweave.adapters.posthog import PostHogAdapter

            self.transport = self._build_fault_transport(fault)
            return _CountingAdapter(PostHogAdapter(transport=self.transport))
        # Fault against a live provider serving from cache -> in-memory.
        return _CountingAdapter(InMemoryAdapter(self.given.get("flags", {})))

    def _build_fault_transport(self, fault: Dict[str, Any]) -> Any:
        """Prefer real HTTP semantics (harness.md): stub for HTTP faults,
        refused loopback connection for network/offline faults."""
        if fault.get("mode") in ("networkError", "offline"):
            self.via = "http-refused-connection"
            return HttpStubTransport(_refused_base_url(), self.config)
        payload = _stub_fault_payload(fault)
        stub = _StubServer.instance() if payload is not None else None
        if stub is not None:
            stub.reset()
            stub.set_fault(payload)
            self.via = "http-stub"
            return HttpStubTransport(stub.url, self.config)
        self.via = "injected-fake-transport"
        return FaultTransport(fault, self.config)

    def _is_stale_cache_fault(self, fault: Dict[str, Any]) -> bool:
        # Definitions-poll faults with cached flags are modeled by the
        # in-memory adapter (fromCache flag definitions) + STALE state.
        return fault.get("applyTo") == "definitions"

    def _build_registry(self) -> Optional[CapabilityRegistry]:
        extensions = self.given.get("extensions")
        if extensions is None:
            return None
        enabled: List[str] = []
        for ext, names in _EXT_CAPS.items():
            if extensions.get(ext):
                enabled.extend(names)
        return CapabilityRegistry(enabled)

    def _seed_extensions(self) -> None:
        for event in self.given.get("exposureQueue", []):
            self.client.exposures.seed([event])
        release_ctx = self.given.get("releaseContext")
        if release_ctx:
            self.client.releases.set_context(
                release_ctx["rolloutId"],
                release_ctx.get("changeId"),
                release_ctx.get("stampIds", ()),
            )
            status = self.given.get("releaseStatus")
            if status:
                self.client.releases.seed_status(release_ctx["rolloutId"], status)

    def _apply_provider_state(self, state: Optional[str]) -> None:
        if state == "READY":
            self.runtime.initialize()
        elif state == "STALE":
            self.runtime.initialize()
            self.runtime.force_state(LifecycleState.STALE)
        elif state == "CLOSED":
            self.runtime.initialize()
            self.runtime.shutdown()
        # NOT_READY / None: leave uninitialized.

    @property
    def network_calls(self) -> int:
        transport = getattr(self, "transport", None)
        if transport is not None:
            return transport.calls
        return self.adapter.resolve_calls


# --------------------------------------------------------------------------
# operations
# --------------------------------------------------------------------------

def _evaluate(harness: _Harness, when: Dict[str, Any], expect: Dict[str, Any]) -> Dict[str, Any]:
    raw_context = when.get("invocationContext")
    snapshot_before = copy.deepcopy(raw_context)
    inv_ctx = context_from_fixture(raw_context)
    options = EvaluationOptions(
        include_payload=bool((when.get("options") or {}).get("includePayload"))
    )
    decision = harness.runtime.evaluate(
        when["flagKey"],
        _FLAG_TYPES[when["flagType"]],
        when.get("defaultValue"),
        inv_ctx,
        options,
    )
    actual: Dict[str, Any] = {
        "value": decision.value,
        "variant": decision.variant,
        "reason": decision.reason,
        "errorCode": decision.error_code,
        "errorMessage": decision.error_message,
    }
    if decision.flag_metadata:
        actual["flagMetadata"] = dict(decision.flag_metadata)
    # Runner-captured observations, attached only when the fixture asserts them.
    if "resolvedContext" in expect:
        actual["resolvedContext"] = decision.resolved_context
    if "contextSnapshotAfter" in expect:
        assert raw_context == snapshot_before, "caller context was mutated"
        actual["contextSnapshotAfter"] = copy.deepcopy(raw_context)
    if "networkCalls" in expect:
        actual["networkCalls"] = harness.network_calls
    if "contextUnchangedAfterEvaluation" in (when.get("assertions") or []):
        assert raw_context == snapshot_before, "caller context was mutated"
    return actual


def _initialize(harness: _Harness, expect: Dict[str, Any]) -> Dict[str, Any]:
    backend_required = "config" in harness.given
    try:
        harness.runtime.initialize(backend_required=backend_required)
        return {
            "providerState": harness.runtime.state.wire_name,
            "errorCode": None,
            "errorMessage": None,
        }
    except FireweaveError as exc:
        return {
            "providerState": harness.runtime.state.wire_name,
            "errorCode": exc.openfeature_error_code,
            "errorMessage": exc.message,
            "errorKind": exc.kind.value,
        }


def _shutdown(harness: _Harness) -> Dict[str, Any]:
    harness.client.shutdown()
    return {
        "providerState": harness.runtime.state.wire_name,
        "errorCode": None,
        "errorMessage": None,
    }


def _replace_provider(harness: _Harness, when: Dict[str, Any], expect: Dict[str, Any]) -> Dict[str, Any]:
    harness.client.shutdown()
    replacement = harness.given.get("replacement", {})
    new_harness = _Harness({"providerState": "READY", "flags": replacement.get("flags", {})}, harness.suite)
    then = when["thenEvaluate"]
    actual = _evaluate(new_harness, then, expect)
    actual["providerState"] = new_harness.runtime.state.wire_name
    return actual


def _release_op(harness: _Harness, op: str, when: Dict[str, Any], expect: Dict[str, Any]) -> Dict[str, Any]:
    release = when.get("release", {})
    releases = harness.client.releases
    if op == "setContext":
        result = releases.set_context(
            release["rolloutId"], release.get("changeId"), release.get("stampIds", ())
        )
    elif op == "start":
        result = releases.start(release.get("rolloutId"))
    elif op == "complete":
        result = releases.complete(release.get("rolloutId"))
    else:
        result = releases.fail(release.get("rolloutId"), release.get("reason"))
    actual: Dict[str, Any] = {"ok": result.ok, "errorCode": result.error_code}
    _attach_failure_fields(actual, result)
    if "status" in expect:
        actual["status"] = result.status
    if "reason" in expect:
        actual["reason"] = result.reason
    if "releaseContext" in expect and result.release_context is not None:
        actual["releaseContext"] = result.release_context.to_dict()
    return actual


def _attach_failure_fields(actual: Dict[str, Any], result: Any) -> None:
    """Structured degradation fields (ruling 17) on failed extension results."""
    if result.ok:
        return
    actual["errorMessage"] = result.error_message
    actual["errorKind"] = result.error_kind.value if result.error_kind else None
    actual["degraded"] = result.degraded


def _record_exposure(harness: _Harness, when: Dict[str, Any], expect: Dict[str, Any]) -> Dict[str, Any]:
    exposure = when["exposure"]
    result = harness.client.exposures.record(
        exposure["targetingKey"],
        exposure["flagKey"],
        exposure.get("variant"),
        exposure.get("value"),
        exposure.get("rolloutId"),
    )
    actual: Dict[str, Any] = {
        "ok": result.ok, "queued": result.queued, "errorCode": result.error_code,
    }
    _attach_failure_fields(actual, result)
    if result.deduped:
        actual["deduped"] = True
    return actual


def _flush_exposures(harness: _Harness) -> Dict[str, Any]:
    result = harness.client.exposures.flush()
    actual: Dict[str, Any] = {
        "ok": result.ok,
        "flushed": result.flushed,
        "queued": result.queued,
        "errorCode": result.error_code,
    }
    _attach_failure_fields(actual, result)
    return actual


def _emit_signal(harness: _Harness, when: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    signal = when["signal"]
    signals = harness.client.signals
    kind = signal["kind"]
    if kind == "health":
        result = signals.record_health(
            signal["name"], signal.get("status", "ok"),
            signal.get("rolloutId"), signal.get("stampId"),
        )
    elif kind == "error":
        result = signals.record_error(
            signal["name"], signal.get("errorKind"),
            signal.get("message"), signal.get("rolloutId"),
        )
    elif kind == "metric":
        result = signals.record_metric(
            signal["name"], signal.get("value"), signal.get("unit"),
            signal.get("rolloutId"), signal.get("stampId"),
        )
    else:
        result = signals.record_outcome(
            signal["name"], signal.get("status", ""),
            signal.get("rolloutId"), signal.get("changeId"),
        )
    actual: Dict[str, Any] = {
        "ok": result.ok, "accepted": result.accepted, "errorCode": result.error_code,
    }
    _attach_failure_fields(actual, result)
    return actual, result.recorded


def _get_capabilities(harness: _Harness) -> Dict[str, Any]:
    return {"capabilities": harness.client.capabilities.get(), "errorCode": None}


def _invoke_capability(harness: _Harness, when: Dict[str, Any]) -> Dict[str, Any]:
    result = harness.client.capabilities.invoke(when["capability"], **(when.get("args") or {}))
    actual: Dict[str, Any] = {"ok": result.ok, "errorCode": result.error_code}
    if not result.ok:
        actual["errorMessage"] = result.error_message
        actual["errorKind"] = result.error_kind.value if result.error_kind else None
        actual["degraded"] = result.degraded
    return actual


# --------------------------------------------------------------------------
# comparator (contracts/harness.md, normative)
# --------------------------------------------------------------------------

def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in value.items() if k not in EXCLUDE_SET}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def _values_equal(actual: Any, expected: Any) -> bool:
    if isinstance(expected, dict) and isinstance(actual, dict):
        if set(actual.keys()) - set(expected.keys()):
            return False  # extra non-excluded keys -> fail (metadata drift)
        return all(
            k in actual and _values_equal(actual[k], v) for k, v in expected.items()
        )
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(
            _values_equal(a, e) for a, e in zip(actual, expected)
        )
    if isinstance(expected, bool) or isinstance(actual, bool):
        return actual is expected if isinstance(expected, bool) else False
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return actual == expected
    return actual == expected


def _values_subset(actual: Any, expected: Any) -> bool:
    """Like ``_values_equal`` but extra keys in actual dicts are permitted.

    Used only for ``getCapabilities`` (harness.md ruling-18 exception):
    undeclared matrix keys are language/build-dependent.
    """
    if isinstance(expected, dict) and isinstance(actual, dict):
        return all(
            k in actual and _values_subset(actual[k], v) for k, v in expected.items()
        )
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(
            _values_subset(a, e) for a, e in zip(actual, expected)
        )
    return _values_equal(actual, expected)


def compare(
    actual: Dict[str, Any],
    expect: Dict[str, Any],
    subset_keys: frozenset = frozenset(),
) -> List[str]:
    """Return a list of human-readable diffs (empty == pass)."""
    diffs: List[str] = []
    actual = _normalize(actual)
    for key, expected in expect.items():
        if key in _DIRECTIVE_KEYS:
            continue
        if key not in actual:
            diffs.append(f"missing key {key!r} (expected {expected!r})")
            continue
        matcher = _values_subset if key in subset_keys else _values_equal
        if not matcher(actual[key], expected):
            diffs.append(f"{key}: expected {expected!r}, got {actual[key]!r}")
    forbidden = expect.get("errorMessageMustNotContain", [])
    if forbidden:
        blob = json.dumps(actual, default=str)
        for needle in forbidden:
            if needle in blob:
                diffs.append(f"forbidden substring {needle!r} present in actual")
    return diffs


# --------------------------------------------------------------------------
# capabilities matrix validation (spec/capabilities.schema.json, ruling 18)
# --------------------------------------------------------------------------

_CAP_LANGUAGES = {"node", "python", "go", "java"}
_CAP_BACKENDS = {"posthog", "inmemory", "none", "other"}
_CAP_LIFECYCLES = {
    "UNINITIALIZED", "INITIALIZING", "READY", "STALE", "ERROR", "FATAL", "SHUTDOWN",
}


def validate_capabilities_matrix(matrix: Any) -> List[str]:
    """Hand-rolled validation of the full matrix against the spec schema
    (jsonschema is not a runner dependency). Returns problems (empty == ok)."""
    p: List[str] = []
    if not isinstance(matrix, dict):
        return ["capabilities: must be the structured {static, runtime} matrix"]
    if set(matrix) != {"static", "runtime"}:
        p.append(f"capabilities: keys must be exactly static+runtime, got {sorted(matrix)}")
        return p

    static = matrix["static"]
    if not isinstance(static, dict):
        p.append("static: not an object")
    else:
        extra = set(static) - {"language", "sdkVersion", "specVersion", "openFeature", "features"}
        if extra:
            p.append(f"static: undeclared keys {sorted(extra)}")
        if static.get("language") not in _CAP_LANGUAGES:
            p.append(f"static.language: invalid {static.get('language')!r}")
        if "specVersion" in static and static["specVersion"] != "0.1.0":
            p.append("static.specVersion: must be const '0.1.0'")
        of = static.get("openFeature")
        if not isinstance(of, dict):
            p.append("static.openFeature: required object missing")
        else:
            if of.get("specFloor") != "0.8.0":
                p.append("static.openFeature.specFloor: must be const '0.8.0'")
            if of.get("providerName") != "fireweave":
                p.append("static.openFeature.providerName: must be const 'fireweave'")
            if "serverOnly" in of and of["serverOnly"] is not True:
                p.append("static.openFeature.serverOnly: must be const true")
        feats = static.get("features")
        if not isinstance(feats, dict):
            p.append("static.features: required object missing")
        else:
            if any(not isinstance(v, bool) for v in feats.values()):
                p.append("static.features: all values must be booleans")
            if feats.get("flags") is not True:
                p.append("static.features.flags: must be const true")
            if feats.get("inMemoryAdapter") is not True:
                p.append("static.features.inMemoryAdapter: must be const true")

    runtime = matrix["runtime"]
    if not isinstance(runtime, dict):
        p.append("runtime: not an object")
    else:
        extra = set(runtime) - {"backend", "lifecycle", "features", "limits"}
        if extra:
            p.append(f"runtime: undeclared keys {sorted(extra)}")
        if runtime.get("backend") not in _CAP_BACKENDS:
            p.append(f"runtime.backend: invalid {runtime.get('backend')!r}")
        if runtime.get("lifecycle") not in _CAP_LIFECYCLES:
            p.append(f"runtime.lifecycle: invalid {runtime.get('lifecycle')!r}")
        feats = runtime.get("features", {})
        if not isinstance(feats, dict) or any(
            not isinstance(v, bool) for v in feats.values()
        ):
            p.append("runtime.features: all values must be booleans")
        limits = runtime.get("limits", {})
        if not isinstance(limits, dict):
            p.append("runtime.limits: not an object")
        else:
            if set(limits) - {"intSafeMaxAbs", "shutdownTimeoutMsDefault"}:
                p.append("runtime.limits: undeclared keys present")
            if "intSafeMaxAbs" in limits and limits["intSafeMaxAbs"] != 9007199254740991:
                p.append("runtime.limits.intSafeMaxAbs: wrong const")
            if (
                "shutdownTimeoutMsDefault" in limits
                and limits["shutdownTimeoutMsDefault"] != 10000
            ):
                p.append("runtime.limits.shutdownTimeoutMsDefault: wrong const")
    return p


# --------------------------------------------------------------------------
# fixture execution
# --------------------------------------------------------------------------

def _run_case(
    given: Dict[str, Any],
    when: Dict[str, Any],
    expect: Dict[str, Any],
    suite: str,
) -> Tuple[Dict[str, Any], List[str], str]:
    """Execute one (given, when, expect) triple on a fresh harness.

    Returns (actual, diffs, via)."""
    if "domains" in given:
        harness = _Harness(given["domains"][when.get("domain")], suite)
    else:
        harness = _Harness(given, suite)

    operation = when.get("operation")
    recorded: Dict[str, Any] = {}
    if operation == "evaluate":
        actual = _evaluate(harness, when, expect)
    elif operation == "initialize":
        actual = _initialize(harness, expect)
    elif operation == "shutdown":
        actual = _shutdown(harness)
    elif operation == "replaceProvider":
        actual = _replace_provider(harness, when, expect)
    elif operation in ("setContext", "start", "complete", "fail"):
        actual = _release_op(harness, operation, when, expect)
    elif operation == "recordExposure":
        actual = _record_exposure(harness, when, expect)
    elif operation == "flushExposures":
        actual = _flush_exposures(harness)
    elif operation == "emitSignal":
        actual, recorded = _emit_signal(harness, when)
    elif operation == "getCapabilities":
        actual = _get_capabilities(harness)
    elif operation == "invokeCapability":
        actual = _invoke_capability(harness, when)
    else:
        return {}, [f"unsupported operation: {operation!r}"], harness.via

    if operation == "getCapabilities":
        # Ruling-18 comparator exception: full-schema validation + subset
        # comparison for the matrix (undeclared keys are build-dependent).
        diffs = validate_capabilities_matrix(actual.get("capabilities"))
        diffs += compare(actual, expect, subset_keys=frozenset({"capabilities"}))
    else:
        diffs = compare(actual, expect)
    for needle in expect.get("recordedMessageMustNotContain", []):
        if needle in json.dumps(recorded, default=str):
            diffs.append(f"forbidden substring {needle!r} in recorded signal")
    return actual, diffs, harness.via


def run_fixture(fixture: Dict[str, Any]) -> Dict[str, Any]:
    fixture_id = fixture.get("id", "<unknown>")
    suite = fixture.get("suite", "<unknown>")
    compatibility = (fixture.get("compatibility") or {}).get(LANGUAGE, "pass")
    result: Dict[str, Any] = {"id": fixture_id, "suite": suite}

    if compatibility != "pass":
        result["status"] = "skipped-with-documented-limitation"
        result["limitation"] = (fixture.get("limitations") or {}).get(LANGUAGE)
        return result

    base_given = fixture.get("given", {})

    # Multi-case fixtures (contracts/README.md): every case runs on a fresh
    # harness with cases[].given shallow-merged over the fixture given; the
    # fixture passes only when all cases pass.
    if "cases" in fixture:
        diffs: List[str] = []
        actuals: Dict[str, Any] = {}
        vias: List[str] = []
        for case in fixture["cases"]:
            name = case.get("name", "<unnamed>")
            merged_given = {**base_given, **(case.get("given") or {})}
            try:
                actual, case_diffs, via = _run_case(
                    merged_given, case.get("when", {}), case.get("expect", {}), suite
                )
            except Exception as exc:
                actual, via = None, "in-memory"
                case_diffs = [f"runner exception: {type(exc).__name__}: {exc}"]
            actuals[name] = actual
            vias.append(via)
            diffs.extend(f"case {name}: {d}" for d in case_diffs)
        result["status"] = "pass" if not diffs else "fail"
        result["actual"] = actuals
        if diffs:
            result["diffs"] = diffs
        non_default = sorted({v for v in vias if v != "in-memory"})
        if non_default:
            result["via"] = ",".join(non_default)
        return result

    try:
        actual, diffs, via = _run_case(
            base_given, fixture.get("when", {}), fixture.get("expect", {}), suite
        )
        result["status"] = "pass" if not diffs else "fail"
        result["actual"] = actual
        if diffs:
            result["diffs"] = diffs
        if via != "in-memory":
            result["via"] = via
        return result
    except Exception as exc:  # runner crash counts as a failure, not an abort
        result["status"] = "fail"
        result["diffs"] = [f"runner exception: {type(exc).__name__}: {exc}"]
        return result


def load_fixtures(contracts_dir: Path) -> List[Dict[str, Any]]:
    fixtures = []
    for path in sorted(contracts_dir.glob("*/*.json")):
        with path.open() as fh:
            fixtures.append(json.load(fh))
    return fixtures


def run_all(contracts_dir: Path) -> Dict[str, Any]:
    results = [run_fixture(fx) for fx in load_fixtures(contracts_dir)]
    summary = {
        "language": LANGUAGE,
        "total": len(results),
        "passed": sum(1 for r in results if r["status"] == "pass"),
        "failed": sum(1 for r in results if r["status"] == "fail"),
        "skipped": sum(
            1 for r in results if r["status"] == "skipped-with-documented-limitation"
        ),
        "results": results,
    }
    return summary
