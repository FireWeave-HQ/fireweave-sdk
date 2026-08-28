"""Fireweave Python conformance runner (contracts/harness.md).

Loads the fixture suites under ``contracts/``, invokes each against the v1
control-points surface (``FireweaveClient.control_points`` — there is no
OpenFeature bridge to reach for any more; ADR-0010 retired it), normalizes
results per the normative comparator, and emits a results JSON matching
contracts/README.md's compatibility-report schema (the same shape node's
runner writes: ``fixtureId``/``suite``/``language``/``status``/``limitation``/
``message`` rows, not the ad hoc ``id``/``actual``/``diffs`` shape this file
used pre-v1).

Suite -> execution backend:

- evaluation / context / lifecycle / security / (the one runnable extensions
  fixture): InMemoryAdapter, driving FireweaveRuntime + FireweaveClient
  directly — the raw construction path, same as
  tests/test_control_points_surface.py's own harness. Two lifecycle/security
  fixtures whose ``given.config`` names a ``host`` (life-init-fail-
  configuration, life-init-success, sec-endpoint-ssrf-allowlist) are routed
  through FireweaveRemoteAdapter instead: python's FireweaveRuntime carries no
  host/allowed-hosts concept of its own (unlike node's FireweaveRuntimeConfig)
  — only the remote adapter's own ``initialize()`` validates a host, so
  exercising the host-allowlist rule needs that adapter.
- faults: FireweaveRemoteAdapter with real HTTP against the local test-server
  stub (``test-server/implementation/server.mjs``, spawned once as a
  subprocess and reused, speaking the Fireweave-native
  ``POST /v1/flags/evaluate`` route — not the legacy PostHog ``/flags?v=2``
  protocol this file used pre-v1). ``fault-stale-cache`` runs on the
  in-memory adapter instead (cache staleness is provisioned directly per
  ``given.flags[*].fromCache`` + ``providerState: STALE``).
- extensions: 13 of 14 fixtures target namespaces cut from v1 (releases,
  exposures, signals, capabilities), classified data-driven from
  ``when.operation`` (see CUT_OPERATION_NAMESPACE below) and are reported
  ``skipped-v1-out-of-scope`` without executing.
  Only ``ext-unsupported-capability-degrade`` exercises real v1 surface
  (``FireweaveClient.invoke_capability``) and runs for real.

Multi-case fixtures (``cases`` array, contracts/README.md) run every case
against a fresh harness; the fixture passes only when all cases pass.
"""

from __future__ import annotations

import atexit
import json
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]

from fireweave import (
    ContextLimits,
    EvaluateOptions,
    EvaluationContext,
    FireweaveClient,
    FireweaveRemoteAdapter,
    FireweaveRuntime,
    FlagType,
    InMemoryAdapter,
    LifecycleState,
    merge_contexts,
    validate_context,
)
from fireweave.domain.errors import (
    AuthenticationError,
    AuthorizationError,
    BackendUnavailableError,
    FireweaveError,
    InternalError,
    MalformedResponseError,
    NetworkError,
    RateLimitedError,
    TimeoutError_,
)

LANGUAGE = "python"

SUITES = ("evaluation", "context", "lifecycle", "faults", "security", "extensions")

# Normative EXCLUDE_SET (contracts/harness.md) — kept for documentation parity
# with node/go/java; this runner's comparator only checks declared `expect`
# keys (see `compare()`), so nondeterministic fields never enter fixtures in
# the first place rather than needing active stripping.
EXCLUDE_SET = {
    "timestamp", "evaluatedAt", "ts", "createdAt", "updatedAt", "stack",
    "stackTrace", "requestId", "uuid", "traceId", "spanId", "messageId",
    "latencyMs", "durationMs", "pid", "hostname",
}

_DIRECTIVE_KEYS = {"errorMessageMustNotContain", "recordedMessageMustNotContain"}

# ---------------------------------------------------------------------------
# v1-scope classification (contracts/harness.md "Extension fixtures — v1
# scope rule", ruling 2), DATA-DRIVEN from `when.operation` — not a
# hand-maintained fixture-ID list. contracts/README.md's "Operations" table
# names exactly which operation belongs to which namespace; every one of
# those namespaces (releases/exposures/signals/capabilities) is cut in v1
# (ADR-0010) except `invokeCapability`, which stays on the client precisely
# to dispatch (and degrade) capability calls. A fixture is
# `skipped-v1-out-of-scope` when EVERY operation it dispatches — the single
# top-level `when.operation`, or, for a multi-case fixture, every
# `cases[].when.operation` — maps to a cut namespace below.
#
# This derives the exact same 13-out/1-real split a hand-maintained ID list
# used to encode (verified by re-running the full suite: counts unchanged —
# see task-10-report.md's fix-report addendum), including the one fixture
# worth reading individually rather than trusting the name:
# ext-lifecycle-gating's description ("lifecycle-gated... ruling 17") reads
# like the invoke_capability lifecycle-gate exception this rule carves out,
# but all three of its cases dispatch `emitSignal` (signals, cut), including
# a "ready-delivered-to-sink" case expecting `ok:true` — an outcome
# invoke_capability can never produce, since v1's SUPPORTED_CAPABILITIES is
# frozen empty and the unsupported-capability check runs before the
# lifecycle gate in every state. The operation-based rule classifies it
# correctly without needing that reasoning spelled out in a lookup table.
CUT_OPERATION_NAMESPACE = {
    "setContext": "releases",
    "start": "releases",
    "complete": "releases",
    "fail": "releases",
    "recordExposure": "exposures",
    "flushExposures": "exposures",
    "emitSignal": "signals",
    "getCapabilities": "capabilities",
    # invokeCapability is deliberately absent: it is v1 surface, not cut.
}


def v1_out_of_scope_namespace(fixture: Dict[str, Any]) -> Optional[str]:
    """Returns the cut namespace name when every operation this fixture
    dispatches targets one, or None when the fixture genuinely exercises v1
    surface (today: only ext-unsupported-capability-degrade)."""
    if "cases" in fixture:
        operations = [case.get("when", {}).get("operation") for case in fixture["cases"]]
    else:
        operations = [fixture.get("when", {}).get("operation")]
    namespaces = [CUT_OPERATION_NAMESPACE.get(op) for op in operations]
    if all(ns is not None for ns in namespaces):
        return namespaces[0]
    return None


# ---------------------------------------------------------------------------
# fixture -> SDK object construction

def _to_expected_type(flag_type: str) -> FlagType:
    if flag_type in ("integer", "float"):
        return FlagType.NUMBER
    return FlagType(flag_type)


def _context_from(ctx: Optional[Dict[str, Any]]) -> Optional[EvaluationContext]:
    if ctx is None:
        return None
    return EvaluationContext(targeting_key=ctx.get("targetingKey"), attributes=ctx.get("attributes") or {})


def _evaluate_options_from(options: Optional[Dict[str, Any]]) -> Optional[EvaluateOptions]:
    """contracts/evaluation/eval-payload-attached.json's ``when.options``
    (task-10b item 5) -> :class:`EvaluateOptions`."""
    if not options:
        return None
    return EvaluateOptions(include_payload=bool(options.get("includePayload", False)))


def _limits_from(config: Dict[str, Any]) -> ContextLimits:
    limits_d = config.get("limits") or {}
    return ContextLimits(
        max_attribute_count=limits_d.get("maxAttributeCount", 128),
        max_key_bytes=limits_d.get("maxKeyBytes", 256),
        max_value_bytes=limits_d.get("maxValueBytes", 4096),
        max_nesting_depth=limits_d.get("maxNestingDepth", 6),
        max_serialized_bytes=limits_d.get("maxSerializedContextBytes", 65536),
    )


def _decision_to_actual(decision: Any) -> Dict[str, Any]:
    return {
        "value": decision.value,
        "variant": decision.variant,
        "reason": decision.reason,
        "errorCode": decision.error_code,
        "errorMessage": decision.error_message,
        "flagMetadata": dict(decision.flag_metadata or {}),
    }


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

    def register_target(self, *args: Any, **kwargs: Any) -> Any:
        return self._inner.register_target(*args, **kwargs)


def _fault_to_error(fault: Dict[str, Any]) -> FireweaveError:
    """Map a fixture fault declaration to the FireweaveError it must raise
    (security-suite fixtures declare protocol faults but run on the
    in-memory adapter — model them as a thrown error of the equivalent
    kind, mirroring node's run.ts)."""
    mode = fault.get("mode")
    if mode == "httpStatus":
        status = fault.get("status", 500)
        if status == 401:
            return AuthenticationError()
        if status == 403:
            return AuthorizationError()
        if status == 429:
            return RateLimitedError()
        return BackendUnavailableError()
    if mode in ("networkError", "offline"):
        return NetworkError()
    if mode == "timeout":
        return TimeoutError_()
    if mode in ("invalidJson", "malformedJson", "truncated"):
        return MalformedResponseError()
    return InternalError()


class _FaultyAdapter:
    """Wraps an adapter so every resolve() raises a fixed FireweaveError
    (contracts/security fixtures that declare a protocol fault but run on
    the in-memory adapter)."""

    def __init__(self, inner: Any, error: FireweaveError) -> None:
        self._inner = inner
        self._error = error

    def initialize(self) -> None:
        self._inner.initialize()

    def resolve(self, flag_key: str, context: EvaluationContext) -> Any:
        raise self._error

    def shutdown(self, timeout_ms: int) -> None:
        self._inner.shutdown(timeout_ms)


def _provision_state(runtime: FireweaveRuntime, state: Optional[str]) -> None:
    if state == "READY":
        runtime.initialize()
    elif state == "STALE":
        runtime.initialize()
        runtime.force_state(LifecycleState.STALE)
    elif state == "CLOSED":
        try:
            runtime.initialize()
        except FireweaveError:
            pass
        runtime.shutdown()
    # NOT_READY / None: leave UNINITIALIZED — python's lifecycle_error()
    # treats UNINITIALIZED and (a hypothetical) INITIALIZING identically
    # (both -> NotReadyError), so there is no in-flight-init gate to model
    # here the way node's run.ts needs one for its async runtime.


def _resolved_context_view(
    limits: ContextLimits,
    reserved_keys: Tuple[str, ...],
    require_targeting_key: bool,
    global_ctx: Optional[EvaluationContext],
    client_ctx: Optional[EvaluationContext],
    invocation_ctx: Optional[EvaluationContext],
) -> Dict[str, Any]:
    """Runner-level equivalent of node's `resolvedContextView(runtime.
    resolveContext(...))`: python's Decision carries no resolved-context
    field, and FireweaveRuntime exposes no public canonicalize-and-return
    method, so this recomputes it from the same public domain functions
    (`merge_contexts`, `validate_context`) the runtime itself calls."""
    merged = merge_contexts(global_ctx, client_ctx, invocation_ctx)
    result = validate_context(
        merged, limits=limits, reserved_keys=reserved_keys, require_targeting_key=require_targeting_key
    )
    if not result.ok:
        return {}
    canonical = result.value
    out: Dict[str, Any] = {}
    if canonical.targeting_key is not None:
        out["targetingKey"] = canonical.targeting_key
    attrs = {k: v for k, v in canonical.attributes.items() if not k.startswith("$")}
    if attrs:
        out["attributes"] = attrs
    return out


# ---------------------------------------------------------------------------
# per-suite executors

def _run_evaluate(fixture: Dict[str, Any]) -> Dict[str, Any]:
    given = fixture.get("given", {})
    when = fixture.get("when", {})

    # Multi-domain lifecycle fixture support: independent runtime/client per
    # domain (no OpenFeature domain multiplexing to reach for post-ADR-0010).
    if "domains" in given:
        requested = when.get("domain")
        output: Dict[str, Any] = {}
        for name, domain_given in given["domains"].items():
            runtime = FireweaveRuntime(InMemoryAdapter(domain_given.get("flags") or {}))
            _provision_state(runtime, domain_given.get("providerState"))
            if name == requested:
                client = FireweaveClient(runtime)
                decision = client.control_points.evaluate(
                    when["flagKey"],
                    _to_expected_type(when["flagType"]),
                    when.get("defaultValue"),
                    _context_from(when.get("invocationContext")),
                )
                output = _decision_to_actual(decision)
        return output

    config = given.get("config") or {}
    limits = _limits_from(config)
    reserved = tuple(config.get("reservedAttributeKeys", ()))
    require_targeting_key = bool(config.get("requireTargetingKey", False))

    base_adapter: Any = InMemoryAdapter(given.get("flags") or {})
    fault = given.get("fault")
    if fault is not None and fault.get("applyTo", "flags") == "flags":
        base_adapter = _FaultyAdapter(base_adapter, _fault_to_error(fault))
    adapter = _CountingAdapter(base_adapter)

    global_ctx = _context_from(given.get("globalContext"))
    runtime = FireweaveRuntime(
        adapter,
        limits=limits,
        reserved_attribute_keys=reserved,
        require_targeting_key=require_targeting_key,
        global_context=global_ctx,
    )
    client = FireweaveClient(runtime)
    client_ctx = _context_from(given.get("clientContext"))
    if client_ctx is not None:
        client.set_context(client_ctx)

    _provision_state(runtime, given.get("providerState"))

    invocation_ctx = _context_from(when.get("invocationContext"))
    options = _evaluate_options_from(when.get("options"))
    decision = client.control_points.evaluate(
        when["flagKey"], _to_expected_type(when["flagType"]), when.get("defaultValue"), invocation_ctx, options
    )
    actual = _decision_to_actual(decision)

    expect = fixture.get("expect", {})
    if "contextSnapshotAfter" in expect:
        raw = when.get("invocationContext") or {}
        snapshot: Dict[str, Any] = {}
        if isinstance(raw.get("targetingKey"), str):
            snapshot["targetingKey"] = raw["targetingKey"]
        attrs = dict(raw.get("attributes") or {})
        if attrs:
            snapshot["attributes"] = attrs
        actual["contextSnapshotAfter"] = snapshot
    if "resolvedContext" in expect:
        actual["resolvedContext"] = _resolved_context_view(
            limits, reserved, require_targeting_key, global_ctx, client_ctx, invocation_ctx
        )
    if "networkCalls" in expect:
        actual["networkCalls"] = adapter.resolve_calls
    return actual


def _run_replace_provider(fixture: Dict[str, Any]) -> Dict[str, Any]:
    given = fixture.get("given", {})
    when = fixture.get("when", {})

    runtime_a = FireweaveRuntime(InMemoryAdapter(given.get("flags") or {}))
    runtime_a.initialize()
    runtime_a.shutdown()  # old provider retired before the replacement takes over

    replacement = given.get("replacement") or {}
    runtime_b = FireweaveRuntime(InMemoryAdapter(replacement.get("flags") or {}))
    runtime_b.initialize()
    client_b = FireweaveClient(runtime_b)

    then = when["thenEvaluate"]
    decision = client_b.control_points.evaluate(
        then["flagKey"], _to_expected_type(then["flagType"]), then.get("defaultValue"),
        _context_from(then.get("invocationContext")),
    )
    actual = _decision_to_actual(decision)
    actual["providerState"] = runtime_b.state.wire_name
    return actual


def _run_initialize(fixture: Dict[str, Any]) -> Dict[str, Any]:
    given = fixture.get("given", {})
    config = given.get("config") or {}
    host = config.get("host")
    if host is not None:
        # Host-allowlist-testing fixtures route through FireweaveRemoteAdapter
        # (see module docstring): its own initialize() validates config.host;
        # python's FireweaveRuntime does not.
        adapter: Any = FireweaveRemoteAdapter(
            api_url=host,
            api_key=config.get("projectApiKey") or "",
            allowed_hosts=tuple(config["allowedHosts"]) if "allowedHosts" in config else None,
        )
    else:
        adapter = InMemoryAdapter(given.get("flags") or {})
    runtime = FireweaveRuntime(adapter)
    error_code = None
    error_message = None
    error_kind = None
    try:
        runtime.initialize()
    except FireweaveError as exc:
        error_code = exc.openfeature_error_code
        error_message = exc.message
        error_kind = exc.kind.value
    return {
        "providerState": runtime.state.wire_name,
        "errorCode": error_code,
        "errorMessage": error_message,
        "errorKind": error_kind,
    }


def _run_shutdown(fixture: Dict[str, Any]) -> Dict[str, Any]:
    given = fixture.get("given", {})
    runtime = FireweaveRuntime(InMemoryAdapter(given.get("flags") or {}))
    _provision_state(runtime, given.get("providerState"))
    error_code = None
    error_message = None
    try:
        runtime.shutdown()
    except Exception as exc:  # shutdown must not raise; guard anyway
        error_code = "GENERAL"
        error_message = str(exc)
    return {"providerState": runtime.state.wire_name, "errorCode": error_code, "errorMessage": error_message}


def _run_extension(fixture: Dict[str, Any]) -> Dict[str, Any]:
    """Only ext-unsupported-capability-degrade reaches here (see
    CUT_OPERATION_NAMESPACE/v1_out_of_scope_namespace above). Exercises
    FireweaveClient.invoke_capability, present and un-cut in v1."""
    given = fixture.get("given", {})
    when = fixture.get("when", {})
    runtime = FireweaveRuntime(InMemoryAdapter(given.get("flags") or {}))
    _provision_state(runtime, given.get("providerState", "READY"))
    client = FireweaveClient(runtime)

    if when.get("operation") != "invokeCapability":
        raise AssertionError(
            f"unsupported v1 extension operation {when.get('operation')!r} "
            "(should have been classified skipped-v1-out-of-scope)"
        )
    result = client.invoke_capability(when["capability"], **(when.get("args") or {}))
    actual: Dict[str, Any] = {
        "ok": result.ok,
        "errorCode": None if result.ok else result.error_code,
        "errorMessage": None if result.ok else result.error_message,
        "errorKind": None if result.ok else (result.error_kind.value if result.error_kind else None),
    }
    if not result.ok and result.degraded:
        actual["degraded"] = True
    return actual


# ---------------------------------------------------------------------------
# faults suite: real HTTP against a spawned test-server (Fireweave-native
# /v1/flags/evaluate route)

class _StubServer:
    """One shared local test-server stub process (loopback, random port)."""

    _singleton: Optional["_StubServer"] = None
    _failed = False

    def __init__(self, url: str, process: subprocess.Popen) -> None:
        self.url = url
        self.process = process

    @classmethod
    def instance(cls) -> Optional["_StubServer"]:
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
                with urllib.request.urlopen(f"{url}/health", timeout=0.25) as resp:
                    if resp.status == 200:
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
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.url}{path}", data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            resp.read()

    def reset(self) -> None:
        self._admin("/_test/reset", {})

    def set_flags(self, body: Dict[str, Any]) -> None:
        self._admin("/_test/flags", body)

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


def _run_fault(fixture: Dict[str, Any]) -> Dict[str, Any]:
    given = fixture.get("given", {})
    when = fixture.get("when", {})
    fault = given.get("fault") or {"mode": "none"}

    # Stale-cache runs on the in-memory adapter (cache state provisioned directly).
    if fixture.get("id") == "fault-stale-cache":
        return _run_evaluate(fixture)

    stub = _StubServer.instance()
    if stub is None:
        raise RuntimeError("test-server (node) is unavailable; cannot exercise the faults suite")
    stub.reset()

    flags_body: Dict[str, Any] = {
        "flags": {},
        "errorsWhileComputingFlags": False,
        "requestId": "00000000-0000-4000-8000-00000000f1x7",
        "quotaLimited": None,
    }
    flag_id = 1
    for key, definition in (given.get("flags") or {}).items():
        variant = definition.get("variant")
        flags_body["flags"][key] = {
            "key": key,
            "enabled": definition.get("enabled"),
            "variant": variant if (variant is not None and definition.get("type") != "boolean") else None,
            "reason": definition.get("reason") or {"code": "condition_match", "condition_index": None, "description": "matched"},
            "metadata": {
                "id": (definition.get("metadata") or {}).get("id", flag_id),
                "version": (definition.get("metadata") or {}).get("version"),
                "payload": None,
            },
        }
        flag_id += 1
    stub.set_flags(flags_body)

    mode = fault.get("mode")
    if mode == "httpStatus":
        stub.set_fault({"mode": str(fault.get("status", 500)), "applyTo": "evaluate"})
    elif mode == "invalidJson":
        stub.set_fault({"mode": "invalid_json", "body": fault.get("body", "{not-json"), "applyTo": "evaluate"})
    elif mode == "quotaLimited":
        stub.set_fault({"mode": "quota_limited", "applyTo": "evaluate"})
    elif mode == "delay":
        stub.set_fault({"mode": "delay", "delayMs": fault.get("delayMs", 1000), "applyTo": "evaluate"})

    if mode in ("networkError", "offline"):
        # A dead loopback port: a real ECONNREFUSED, no admin server involved.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            dead_port = probe.getsockname()[1]
        api_url = f"http://127.0.0.1:{dead_port}"
    else:
        api_url = stub.url

    config = given.get("config") or {}
    timeout_ms = config.get("featureFlagsRequestTimeoutMs", 3000)
    # The fixture's key is passed through verbatim rather than replaced with a
    # Fireweave-shaped one: sec-secrets-not-in-errors asserts that no `phc_`
    # substring reaches an error message, and substituting the key would make
    # that assertion pass trivially instead of exercising redaction.
    api_key = config.get("projectApiKey", "phc_TESTKEY0000000000000000000001")
    adapter = FireweaveRemoteAdapter(api_url=api_url, api_key=api_key, request_timeout_ms=timeout_ms)
    runtime = FireweaveRuntime(adapter)
    runtime.initialize()
    client = FireweaveClient(runtime)
    decision = client.control_points.evaluate(
        when["flagKey"], _to_expected_type(when["flagType"]), when.get("defaultValue"),
        _context_from(when.get("invocationContext")),
    )
    runtime.shutdown()
    return _decision_to_actual(decision)


# ---------------------------------------------------------------------------
# comparator (contracts/harness.md, normative)

_META_EXPECT_KEYS = _DIRECTIVE_KEYS


def _deep_equal(a: Any, b: Any) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, dict) and isinstance(b, dict):
        return set(a) == set(b) and all(_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_deep_equal(x, y) for x, y in zip(a, b))
    return a == b


def compare(expect: Dict[str, Any], actual: Dict[str, Any]) -> List[str]:
    """Compare `expect` vs `actual` per the normative comparator
    (contracts/README.md): every declared expect key must match; missing key
    -> fail. (Mirrors node's run.ts `diff()` — neither runner fails on
    EXTRA actual keys beyond what a fixture declares; that stricter rule
    predates this task and is unchanged here.)"""
    failures: List[str] = []
    for key, expected in expect.items():
        if key in _META_EXPECT_KEYS:
            continue
        actual_value = actual.get(key)
        if expected is None:
            if actual_value is not None:
                failures.append(f"{key}: expected null, got {actual_value!r}")
            continue
        if not _deep_equal(actual_value, expected):
            failures.append(f"{key}: expected {expected!r}, got {actual_value!r}")
    must_not_contain = expect.get("errorMessageMustNotContain")
    if isinstance(must_not_contain, list):
        message = actual.get("errorMessage") or ""
        for needle in must_not_contain:
            if isinstance(needle, str) and needle in message:
                failures.append(f"errorMessage must not contain {needle!r}")
    return failures


# ---------------------------------------------------------------------------
# fixture execution

def _dispatch(fixture: Dict[str, Any]) -> Dict[str, Any]:
    when = fixture.get("when", {})
    operation = when.get("operation")
    if fixture.get("suite") == "faults":
        return _run_fault(fixture)
    if operation == "evaluate":
        return _run_evaluate(fixture)
    if operation == "initialize":
        return _run_initialize(fixture)
    if operation == "shutdown":
        return _run_shutdown(fixture)
    if operation == "replaceProvider":
        return _run_replace_provider(fixture)
    return _run_extension(fixture)


def load_fixtures(contracts_dir: Path) -> List[Dict[str, Any]]:
    fixtures = []
    for suite in SUITES:
        suite_dir = contracts_dir / suite
        if not suite_dir.is_dir():
            continue
        for path in sorted(suite_dir.glob("*.json")):
            with path.open() as fh:
                fixtures.append(json.load(fh))
    return fixtures


def run_fixture(fixture: Dict[str, Any]) -> Dict[str, Any]:
    """Run one fixture; returns a report row matching contracts/README.md's
    compatibility-report schema (fixtureId/suite/language/status/limitation/
    message)."""
    fixture_id = fixture.get("id", "<unknown>")
    suite = fixture.get("suite", "<unknown>")

    # v1-scope rule (contracts/harness.md): extensions fixtures targeting a
    # cut namespace are reported skipped-v1-out-of-scope, never executed,
    # regardless of the fixture's own declared compatibility (frozen "pass",
    # authored pre-cut).
    if suite == "extensions":
        namespace = v1_out_of_scope_namespace(fixture)
        if namespace is not None:
            return {
                "fixtureId": fixture_id,
                "suite": suite,
                "language": LANGUAGE,
                "status": "skipped-v1-out-of-scope",
                "limitation": f"targets the {namespace} namespace, cut from the v1 control-points surface (ADR-0010)",
                "message": None,
            }

    declared = (fixture.get("compatibility") or {}).get(LANGUAGE)
    if declared == "skipped-with-documented-limitation":
        return {
            "fixtureId": fixture_id,
            "suite": suite,
            "language": LANGUAGE,
            "status": "skipped-with-documented-limitation",
            "limitation": (fixture.get("limitations") or {}).get(LANGUAGE, "documented limitation"),
            "message": None,
        }

    base_given = fixture.get("given", {})
    runs: List[Dict[str, Any]]
    if "cases" in fixture:
        runs = [
            {
                "label": case.get("name"),
                "fixture": {
                    **fixture,
                    "given": {**base_given, **(case.get("given") or {})},
                    "when": case.get("when", {}),
                    "expect": case.get("expect", {}),
                },
            }
            for case in fixture["cases"]
        ]
    else:
        runs = [{"label": None, "fixture": fixture}]

    status = "pass"
    messages: List[str] = []
    for run in runs:
        prefix = f"[{run['label']}] " if run["label"] is not None else ""
        try:
            actual = _dispatch(run["fixture"])
            failures = compare(run["fixture"].get("expect", {}), actual)
            if failures:
                status = "fail"
                messages.append(f"{prefix}{'; '.join(failures)}")
        except Exception as exc:  # runner crash counts as a failure, not an abort
            status = "fail"
            messages.append(f"{prefix}harness error: {type(exc).__name__}: {exc}")

    return {
        "fixtureId": fixture_id,
        "suite": suite,
        "language": LANGUAGE,
        "status": status,
        "limitation": None,
        "message": " | ".join(messages) if messages else None,
    }


def run_all(contracts_dir: Path) -> Dict[str, Any]:
    rows = [run_fixture(fx) for fx in load_fixtures(contracts_dir)]
    summary = {
        "pass": sum(1 for r in rows if r["status"] == "pass"),
        "fail": sum(1 for r in rows if r["status"] == "fail"),
        "skipped-with-documented-limitation": sum(
            1 for r in rows if r["status"] == "skipped-with-documented-limitation"
        ),
        "skipped-v1-out-of-scope": sum(1 for r in rows if r["status"] == "skipped-v1-out-of-scope"),
    }

    # Sanity assertion (review finding 2): the data-driven v1-scope
    # classification must derive the exact same 13-out/1-real split a
    # hand-maintained fixture-ID list used to encode. If contracts/
    # extensions/ ever gains or loses a fixture, or a fixture's operation set
    # changes, this fails loudly instead of silently drifting.
    extensions_rows = [r for r in rows if r["suite"] == "extensions"]
    out_of_scope_count = sum(1 for r in extensions_rows if r["status"] == "skipped-v1-out-of-scope")
    runnable_count = len(extensions_rows) - out_of_scope_count
    if out_of_scope_count != 13 or runnable_count != 1:
        raise AssertionError(
            f"v1-scope classification drifted: expected 13 skipped-v1-out-of-scope + 1 "
            f"runnable extensions fixture, got {out_of_scope_count} + {runnable_count}"
        )

    return {
        "schemaVersion": 1,
        "generatedAt": "EXCLUDED",
        "sdkCommit": "workspace",
        "contractsCommit": "workspace",
        "results": rows,
        "summary": summary,
    }
