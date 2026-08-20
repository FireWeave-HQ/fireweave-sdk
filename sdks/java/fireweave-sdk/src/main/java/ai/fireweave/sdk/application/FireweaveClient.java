package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveError;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.LifecycleState;

import java.util.Collections;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * User-facing Fireweave client: control-point evaluation plus target registration — the only two
 * v1 capabilities (spec/control-points.md "Scope of v1"). Plain constructor — DI-friendly, no
 * framework, no statics except the once-per-process deprecation notice.
 *
 * <h2>Evaluation</h2>
 * The documented namespace is {@link #controlPoints()} (ADR-0007). {@link #flags()} is the
 * same object, retained for compatibility.
 *
 * <h2>Thread-safety</h2>
 * Fully thread-safe: evaluation delegates to {@link FireweaveRuntime}. {@link #registerTarget}
 * never throws.
 */
public final class FireweaveClient implements AutoCloseable {

    private static final java.util.logging.Logger LOG =
            java.util.logging.Logger.getLogger(FireweaveClient.class.getName());
    private static final AtomicBoolean FLAGS_DEPRECATION_NOTICED = new AtomicBoolean();

    /**
     * Names {@link #invokeCapability} will dispatch instead of degrading with
     * UnsupportedCapability. Empty in v1: releases, exposures, signals, capabilities discovery,
     * and guardrails are all out of scope (spec/control-points.md) and MUST NOT be exposed, so a
     * cut namespace's capability string resolves exactly like any other unknown string.
     */
    private static final Set<String> SUPPORTED_CAPABILITIES = Collections.emptySet();

    private final FireweaveRuntime runtime;
    private final EvaluationContext clientContext;
    private final ControlPoints controlPoints = new ControlPoints();

    public FireweaveClient(FireweaveRuntime runtime) {
        this(runtime, EvaluationContext.empty());
    }

    public FireweaveClient(FireweaveRuntime runtime, EvaluationContext clientContext) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.clientContext = clientContext == null ? EvaluationContext.empty() : clientContext;
    }

    public FireweaveRuntime runtime() {
        return runtime;
    }

    public EvaluationContext clientContext() {
        return clientContext;
    }

    /** New client sharing this runtime with a different client-level context. */
    public FireweaveClient withClientContext(EvaluationContext ctx) {
        return new FireweaveClient(runtime, ctx);
    }

    /** Documented evaluation namespace (ADR-0007). */
    public ControlPoints controlPoints() {
        return controlPoints;
    }

    /**
     * Control-point evaluation under its former name.
     *
     * <p>Identical to {@link #controlPoints()} — {@code client.flags() == client.controlPoints()}.
     * Not scheduled for removal. Logs one notice per process the first time this is called.
     *
     * @deprecated use {@link #controlPoints()}
     */
    @Deprecated
    public ControlPoints flags() {
        noteDeprecatedFlagsAlias();
        return controlPoints;
    }

    /**
     * Register a user or device so rules can target its durable properties
     * ({@code POST /v1/targets/register}). Never throws.
     */
    public RegisterTargetResult registerTarget(String targetingKey) {
        return runtime.registerTarget(targetingKey, RegisterTargetOptions.empty());
    }

    /**
     * Register a user or device so rules can target its durable properties
     * ({@code POST /v1/targets/register}). Never throws.
     */
    public RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
        return runtime.registerTarget(targetingKey, options);
    }

    /**
     * Dynamic capability dispatch. Unknown capabilities — currently all of them, v1's
     * {@code SUPPORTED_CAPABILITIES} is empty — degrade with UnsupportedCapability, never throw
     * (fixture ext-unsupported-capability-degrade). Any future capability listed in
     * {@code SUPPORTED_CAPABILITIES} would be lifecycle-gated the same way (ruling 17).
     */
    public ExtensionResult<Object> invokeCapability(String capabilityName, Map<String, Object> args) {
        if (capabilityName == null || !SUPPORTED_CAPABILITIES.contains(capabilityName)) {
            return ExtensionResult.degraded(
                    FireweaveError.of(ErrorKind.UnsupportedCapability, "unsupported capability"));
        }
        FireweaveError gate = gateError();
        if (gate != null) {
            return ExtensionResult.degraded(gate);
        }
        return ExtensionResult.ok(capabilityName);
    }

    /** Idempotent. */
    @Override
    public void close() {
        runtime.shutdown();
    }

    /**
     * Lifecycle gate for extension calls (ruling 17, canonical Go/Java model): calls degrade
     * predictably and never throw — {@code UnsupportedCapability} before READY (the capability
     * is not yet available), {@code AlreadyClosed} after shutdown. Returns null when the
     * runtime can serve extensions (READY or STALE).
     */
    private FireweaveError gateError() {
        LifecycleState s = runtime.state();
        if (s == LifecycleState.SHUTDOWN) {
            return FireweaveError.of(ErrorKind.AlreadyClosed, ErrorKind.AlreadyClosed.defaultMessage());
        }
        if (s == LifecycleState.READY || s == LifecycleState.STALE) {
            return null;
        }
        return FireweaveError.of(ErrorKind.UnsupportedCapability, "unsupported capability");
    }

    /**
     * Typed evaluation helpers on the Fireweave-native surface — the nine methods
     * (spec/control-points.md "The nine methods").
     *
     * <p>Documented as {@link FireweaveClient#controlPoints()} (ADR-0007).
     * {@link FireweaveClient#flags()} is an identical alias retained for compatibility.
     */
    public final class ControlPoints {

        private ControlPoints() {
        }

        /** Detailed evaluation; never throws (defaults degrade with reason=ERROR). */
        public Decision evaluate(String flagKey,
                                 FlagType type,
                                 JsonValue defaultValue,
                                 EvaluationContext invocationContext,
                                 EvaluationOptions options) {
            return runtime.evaluate(flagKey, type, defaultValue, clientContext, invocationContext, options);
        }

        public boolean getBooleanValue(String flagKey, boolean defaultValue, EvaluationContext ctx) {
            Decision d = evaluate(flagKey, FlagType.BOOLEAN, JsonValue.of(defaultValue), ctx, null);
            return d.value().kind() == JsonValue.Kind.BOOLEAN ? d.value().asBoolean() : defaultValue;
        }

        public String getStringValue(String flagKey, String defaultValue, EvaluationContext ctx) {
            Decision d = evaluate(flagKey, FlagType.STRING, JsonValue.of(defaultValue), ctx, null);
            return d.value().kind() == JsonValue.Kind.STRING ? d.value().asString() : defaultValue;
        }

        /** Returns {@code number}, not integer — {@code Decision.value} is {@code jsonValue}. */
        public double getNumberValue(String flagKey, double defaultValue, EvaluationContext ctx) {
            Decision d = evaluate(flagKey, FlagType.NUMBER, JsonValue.of(defaultValue), ctx, null);
            return d.value().kind() == JsonValue.Kind.NUMBER ? d.value().asNumber().doubleValue() : defaultValue;
        }

        public JsonValue getObjectValue(String flagKey, JsonValue defaultValue, EvaluationContext ctx) {
            JsonValue fallback = defaultValue == null ? JsonValue.ofNull() : defaultValue;
            Decision d = evaluate(flagKey, FlagType.OBJECT, fallback, ctx, null);
            JsonValue.Kind k = d.value().kind();
            return (k == JsonValue.Kind.OBJECT || k == JsonValue.Kind.ARRAY) ? d.value() : fallback;
        }

        /**
         * Detailed reads — the whole {@link Decision} rather than just its value. Same arguments
         * as the {@code *Value} pair above, so a caller upgrades from one to the other without
         * restructuring the call (spec/control-points.md "The nine methods").
         */
        public Decision getBooleanDetails(String flagKey, boolean defaultValue, EvaluationContext ctx) {
            return evaluate(flagKey, FlagType.BOOLEAN, JsonValue.of(defaultValue), ctx, null);
        }

        public Decision getStringDetails(String flagKey, String defaultValue, EvaluationContext ctx) {
            return evaluate(flagKey, FlagType.STRING, JsonValue.of(defaultValue), ctx, null);
        }

        public Decision getNumberDetails(String flagKey, double defaultValue, EvaluationContext ctx) {
            return evaluate(flagKey, FlagType.NUMBER, JsonValue.of(defaultValue), ctx, null);
        }

        public Decision getObjectDetails(String flagKey, JsonValue defaultValue, EvaluationContext ctx) {
            JsonValue fallback = defaultValue == null ? JsonValue.ofNull() : defaultValue;
            return evaluate(flagKey, FlagType.OBJECT, fallback, ctx, null);
        }
    }

    /**
     * One notice per process. A per-call warning on a server SDK becomes log spam at request
     * volume, which is how deprecation notices get suppressed wholesale and then ignored.
     * Unconditional (no env gate): the SDK reads no environment variables (spec/modes.md "The
     * SDK reads no environment variables", unscoped).
     */
    private static void noteDeprecatedFlagsAlias() {
        if (!FLAGS_DEPRECATION_NOTICED.compareAndSet(false, true)) {
            return;
        }
        LOG.warning("client.flags() has been renamed to client.controlPoints(). "
                + "The old name remains fully supported — no migration is required.");
    }
}
