"""Fireweave Python conformance runner (contracts/harness.md).

Loads the fixture suites under ``contracts/``, executes each against the SDK,
normalizes results per the normative comparator, and emits a results JSON.

Suite -> execution backend:

- context / evaluation / lifecycle / extensions / security: InMemoryAdapter.
- faults: PostHogAdapter with an injected fault transport that raises real
  ``requests`` exceptions (the local test-server stub is not present yet at
  ``test-server/implementation/`` — transport-level cases are marked
  ``via=injected-fake-transport`` in the report).
"""

from __future__ import annotations

import copy
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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


class FaultTransport:
    """Injected snapshot transport that reproduces test-server fault modes
    by raising real ``requests`` exceptions (or returning fault bodies)."""

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
        self._seed_extensions()
        self._apply_provider_state(given.get("providerState"))

    def _build_adapter(self) -> Any:
        fault = self.given.get("fault")
        use_fault_transport = fault is not None and not self._is_stale_cache_fault(fault)
        if use_fault_transport:
            from fireweave.adapters.posthog import PostHogAdapter

            self.via = "injected-fake-transport"
            self.transport = FaultTransport(fault, self.config)
            return _CountingAdapter(PostHogAdapter(transport=self.transport))
        # Fault against a live provider serving from cache -> in-memory.
        return _CountingAdapter(InMemoryAdapter(self.given.get("flags", {})))

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
    actual: Dict[str, Any] = {"ok": result.ok, "errorCode": None}
    if "status" in expect:
        actual["status"] = result.status
    if "reason" in expect:
        actual["reason"] = result.reason
    if "releaseContext" in expect and result.release_context is not None:
        actual["releaseContext"] = result.release_context.to_dict()
    return actual


def _record_exposure(harness: _Harness, when: Dict[str, Any], expect: Dict[str, Any]) -> Dict[str, Any]:
    exposure = when["exposure"]
    result = harness.client.exposures.record(
        exposure["targetingKey"],
        exposure["flagKey"],
        exposure.get("variant"),
        exposure.get("value"),
        exposure.get("rolloutId"),
    )
    actual: Dict[str, Any] = {"ok": result.ok, "queued": result.queued, "errorCode": None}
    if result.deduped:
        actual["deduped"] = True
    return actual


def _flush_exposures(harness: _Harness) -> Dict[str, Any]:
    result = harness.client.exposures.flush()
    return {
        "ok": result.ok,
        "flushed": result.flushed,
        "queued": result.queued,
        "errorCode": None,
    }


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
    actual = {"ok": result.ok, "accepted": result.accepted, "errorCode": None}
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


def compare(actual: Dict[str, Any], expect: Dict[str, Any]) -> List[str]:
    """Return a list of human-readable diffs (empty == pass)."""
    diffs: List[str] = []
    actual = _normalize(actual)
    for key, expected in expect.items():
        if key in _DIRECTIVE_KEYS:
            continue
        if key not in actual:
            diffs.append(f"missing key {key!r} (expected {expected!r})")
            continue
        if not _values_equal(actual[key], expected):
            diffs.append(f"{key}: expected {expected!r}, got {actual[key]!r}")
    forbidden = expect.get("errorMessageMustNotContain", [])
    if forbidden:
        blob = json.dumps(actual, default=str)
        for needle in forbidden:
            if needle in blob:
                diffs.append(f"forbidden substring {needle!r} present in actual")
    return diffs


# --------------------------------------------------------------------------
# fixture execution
# --------------------------------------------------------------------------

def run_fixture(fixture: Dict[str, Any]) -> Dict[str, Any]:
    fixture_id = fixture.get("id", "<unknown>")
    suite = fixture.get("suite", "<unknown>")
    compatibility = (fixture.get("compatibility") or {}).get(LANGUAGE, "pass")
    result: Dict[str, Any] = {"id": fixture_id, "suite": suite}

    if compatibility != "pass":
        result["status"] = "skipped-with-documented-limitation"
        result["limitation"] = (fixture.get("limitations") or {}).get(LANGUAGE)
        return result

    given = fixture.get("given", {})
    when = fixture.get("when", {})
    expect = fixture.get("expect", {})
    operation = when.get("operation")

    try:
        if "domains" in given:
            domain = when.get("domain")
            harness = _Harness(given["domains"][domain], suite)
        else:
            harness = _Harness(given, suite)

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
            result["status"] = "fail"
            result["diffs"] = [f"unsupported operation: {operation!r}"]
            return result

        diffs = compare(actual, expect)
        for needle in expect.get("recordedMessageMustNotContain", []):
            if needle in json.dumps(recorded, default=str):
                diffs.append(f"forbidden substring {needle!r} in recorded signal")

        result["status"] = "pass" if not diffs else "fail"
        result["actual"] = actual
        if diffs:
            result["diffs"] = diffs
        if harness.via != "in-memory":
            result["via"] = harness.via
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
