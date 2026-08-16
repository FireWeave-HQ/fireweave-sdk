package ai.fireweave.sdk;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * User-facing Fireweave client: control-point evaluation plus release-safety extension facades
 * ({@link Releases}, {@link Exposures}, {@link Signals}, {@link Guardrails},
 * {@link CapabilitiesApi}). Plain constructor — DI-friendly, no framework, no statics.
 *
 * <h2>Evaluation</h2>
 * The documented namespace is {@link #controlPoints()} (ADR-0007). {@link #flags()} is the
 * same object, retained for compatibility. Existing client-level {@link #evaluate},
 * {@link #getBooleanValue}, and {@link #getStringValue} remain as delegates.
 *
 * <h2>Thread-safety</h2>
 * Fully thread-safe: evaluation delegates to {@link FireweaveRuntime}; extension state (release
 * status, exposure queue) uses concurrent structures with facade-level synchronization on the
 * exposure queue. Extension facades never throw on the normal path — they return
 * {@link ExtensionResult}. {@link #registerTarget} never throws.
 */
public final class FireweaveClient implements AutoCloseable {

    private static final java.util.logging.Logger LOG =
            java.util.logging.Logger.getLogger(FireweaveClient.class.getName());
    private static final java.util.concurrent.atomic.AtomicBoolean FLAGS_DEPRECATION_NOTICED =
            new java.util.concurrent.atomic.AtomicBoolean();

    private final FireweaveRuntime runtime;
    private final EvaluationContext clientContext;
    private final ControlPoints controlPoints = new ControlPoints();
    private final Releases releases = new Releases();
    private final Exposures exposures = new Exposures();
    private final Signals signals = new Signals();
    private final Guardrails guardrails = new Guardrails();
    private final CapabilitiesApi capabilities = new CapabilitiesApi();

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
     * Not scheduled for removal. Set {@code FW_DEPRECATION_WARNINGS=1} to log one notice per JVM.
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

    /** Detailed evaluation; never throws (defaults degrade with reason=ERROR). */
    public Decision evaluate(String flagKey,
                             FlagType type,
                             JsonValue defaultValue,
                             EvaluationContext invocationContext,
                             EvaluationOptions options) {
        return controlPoints.evaluate(flagKey, type, defaultValue, invocationContext, options);
    }

    public boolean getBooleanValue(String flagKey, boolean defaultValue, EvaluationContext ctx) {
        return controlPoints.getBooleanValue(flagKey, defaultValue, ctx);
    }

    public String getStringValue(String flagKey, String defaultValue, EvaluationContext ctx) {
        return controlPoints.getStringValue(flagKey, defaultValue, ctx);
    }

    public int getIntegerValue(String flagKey, int defaultValue, EvaluationContext ctx) {
        return controlPoints.getIntegerValue(flagKey, defaultValue, ctx);
    }

    public double getDoubleValue(String flagKey, double defaultValue, EvaluationContext ctx) {
        return controlPoints.getDoubleValue(flagKey, defaultValue, ctx);
    }

    public JsonValue getObjectValue(String flagKey, JsonValue defaultValue, EvaluationContext ctx) {
        return controlPoints.getObjectValue(flagKey, defaultValue, ctx);
    }

    public Releases releases() {
        return releases;
    }

    public Exposures exposures() {
        return exposures;
    }

    public Signals signals() {
        return signals;
    }

    public Guardrails guardrails() {
        return guardrails;
    }

    public CapabilitiesApi capabilities() {
        return capabilities;
    }

    /**
     * Dynamic capability dispatch (fixture ext-unsupported-capability-degrade): unknown names
     * degrade with {@code UnsupportedCapability} — no throw.
     */
    public ExtensionResult<Object> invokeCapability(String capabilityName, Map<String, Object> args) {
        if (capabilityName == null || !capabilities.get().supports(capabilityName)) {
            return ExtensionResult.degraded(
                    FireweaveError.of(ErrorKind.UnsupportedCapability, "unsupported capability"));
        }
        // Known capabilities are invoked through their typed facades; dynamic dispatch is
        // intentionally limited to capability discovery + degradation semantics.
        return ExtensionResult.ok(capabilityName);
    }

    /** Idempotent; flushes nothing implicitly (exposures are explicit per ADR). */
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

    // ------------------------------------------------------------------ releases

    /** Release status snapshot returned by release operations. */
    public static final class ReleaseStatus {
        public static final String IN_PROGRESS = "in_progress";
        public static final String COMPLETED = "completed";
        public static final String FAILED = "failed";

        private final String rolloutId;
        private final String status;
        private final String reason;

        ReleaseStatus(String rolloutId, String status, String reason) {
            this.rolloutId = rolloutId;
            this.status = status;
            this.reason = reason;
        }

        public String rolloutId() {
            return rolloutId;
        }

        public String status() {
            return status;
        }

        /** Failure reason (sanitized), or null. */
        public String reason() {
            return reason;
        }
    }

    /** releases.setContext / start / complete / fail. Thread-safe. */
    public final class Releases {
        private volatile ReleaseContext current;
        private final ConcurrentHashMap<String, ReleaseStatus> statusByRollout = new ConcurrentHashMap<>();

        private Releases() {
        }

        public ReleaseContext currentContext() {
            return current;
        }

        /**
         * Bind the release context after validating it against exactly the
         * {@code spec/release-context.schema.json} required fields (ruling 15): rolloutId
         * required, stampIds required with the typed-ULID shape. Invalid contexts fail with
         * {@code InvalidContext} — never a throw.
         */
        public ExtensionResult<ReleaseContext> setContext(ReleaseContext context) {
            FireweaveError gate = gateError();
            if (gate != null) {
                return ExtensionResult.degraded(gate);
            }
            if (context == null) {
                return ExtensionResult.failure(
                        FireweaveError.of(ErrorKind.InvalidContext, "release context required"));
            }
            try {
                context.validate();
            } catch (FireweaveException e) {
                return ExtensionResult.failure(FireweaveError.from(e));
            }
            this.current = context;
            return ExtensionResult.ok(context);
        }

        public ExtensionResult<ReleaseStatus> start(String rolloutId) {
            return transition(rolloutId, ReleaseStatus.IN_PROGRESS, null);
        }

        public ExtensionResult<ReleaseStatus> complete(String rolloutId) {
            return transition(rolloutId, ReleaseStatus.COMPLETED, null);
        }

        public ExtensionResult<ReleaseStatus> fail(String rolloutId, String reason) {
            return transition(rolloutId, ReleaseStatus.FAILED, Redaction.sanitize(reason));
        }

        private ExtensionResult<ReleaseStatus> transition(String rolloutId, String status, String reason) {
            FireweaveError gate = gateError();
            if (gate != null) {
                return ExtensionResult.degraded(gate);
            }
            if (rolloutId == null || rolloutId.isEmpty()) {
                return ExtensionResult.failure(
                        FireweaveError.of(ErrorKind.InvalidContext, "rolloutId required"));
            }
            ReleaseStatus s = new ReleaseStatus(rolloutId, status, reason);
            statusByRollout.put(rolloutId, s);
            return ExtensionResult.ok(s);
        }

        public ReleaseStatus statusOf(String rolloutId) {
            return statusByRollout.get(rolloutId);
        }
    }

    // ------------------------------------------------------------------ exposures

    /** Outcome of exposures.record. */
    public static final class RecordOutcome {
        private final int queued;
        private final boolean deduped;

        RecordOutcome(int queued, boolean deduped) {
            this.queued = queued;
            this.deduped = deduped;
        }

        public int queued() {
            return queued;
        }

        public boolean deduped() {
            return deduped;
        }
    }

    /** Outcome of exposures.flush. */
    public static final class FlushOutcome {
        private final int flushed;
        private final int queued;

        FlushOutcome(int flushed, int queued) {
            this.flushed = flushed;
            this.queued = queued;
        }

        public int flushed() {
            return flushed;
        }

        public int queued() {
            return queued;
        }
    }

    /**
     * exposures.record / flush with deterministic dedup on
     * (targetingKey, flagKey, variant, value). Queue mutations synchronize on the queue itself.
     */
    public final class Exposures {
        private final LinkedHashMap<String, Exposure> queue = new LinkedHashMap<>();

        private Exposures() {
        }

        public ExtensionResult<RecordOutcome> record(Exposure exposure) {
            FireweaveError gate = gateError();
            if (gate != null) {
                return ExtensionResult.degraded(gate);
            }
            Objects.requireNonNull(exposure, "exposure");
            synchronized (queue) {
                boolean deduped = queue.containsKey(exposure.dedupKey());
                if (!deduped) {
                    queue.put(exposure.dedupKey(), exposure);
                }
                return ExtensionResult.ok(new RecordOutcome(queue.size(), deduped));
            }
        }

        public ExtensionResult<FlushOutcome> flush() {
            FireweaveError gate = gateError();
            if (gate != null) {
                return ExtensionResult.degraded(gate);
            }
            List<Exposure> drained;
            synchronized (queue) {
                drained = new ArrayList<>(queue.values());
                queue.clear();
            }
            int flushed = 0;
            for (Exposure e : drained) {
                try {
                    runtime.adapter().deliverExposure(e);
                    flushed++;
                } catch (FireweaveException ex) {
                    // Redelivery is the caller's concern; keep counting what was delivered.
                }
            }
            try {
                // Clear-on-flush dedup lifecycle (ratified; security review M-2).
                runtime.adapter().onExposuresFlushed();
            } catch (RuntimeException ex) {
                // flush() never throws; adapter cleanup failures are not the caller's problem.
            }
            synchronized (queue) {
                return ExtensionResult.ok(new FlushOutcome(flushed, queue.size()));
            }
        }

        public int queuedCount() {
            synchronized (queue) {
                return queue.size();
            }
        }
    }

    // ------------------------------------------------------------------ signals

    /**
     * signals.recordHealth / recordError / recordMetric / recordOutcome. Messages are sanitized
     * by {@link Signal}; attributes are filtered by the config telemetry allowlist when set.
     */
    public final class Signals {

        private Signals() {
        }

        public ExtensionResult<Signal> recordHealth(String name, String status) {
            return record(Signal.builder(Signal.Kind.HEALTH, name).status(status).build());
        }

        public ExtensionResult<Signal> recordError(String name, ErrorKind errorKind, String message) {
            return record(Signal.builder(Signal.Kind.ERROR, name)
                    .errorKind(errorKind).message(message).build());
        }

        public ExtensionResult<Signal> recordMetric(String name, JsonValue value) {
            return record(Signal.builder(Signal.Kind.METRIC, name).value(value).build());
        }

        public ExtensionResult<Signal> recordOutcome(String name, String status) {
            return record(Signal.builder(Signal.Kind.OUTCOME, name).status(status).build());
        }

        /** Full-envelope recording (all optional correlation fields). */
        public ExtensionResult<Signal> record(Signal signal) {
            FireweaveError gate = gateError();
            if (gate != null) {
                return ExtensionResult.degraded(gate);
            }
            Objects.requireNonNull(signal, "signal");
            Signal filtered = applyTelemetryAllowlist(signal);
            try {
                runtime.adapter().deliverSignal(filtered);
            } catch (FireweaveException e) {
                return ExtensionResult.failure(FireweaveError.from(e));
            }
            return ExtensionResult.ok(filtered);
        }

        private Signal applyTelemetryAllowlist(Signal s) {
            var allow = runtime.config().telemetryAttributeAllowlist();
            if (allow == null || s.attributes().isEmpty()) {
                return s;
            }
            Signal.Builder b = Signal.builder(s.kind(), s.name())
                    .status(s.status()).errorKind(s.errorKind()).message(s.message())
                    .value(s.value()).targetingKey(s.targetingKey()).rolloutId(s.rolloutId())
                    .changeId(s.changeId()).stampId(s.stampId()).flagKey(s.flagKey())
                    .variant(s.variant());
            for (Map.Entry<String, JsonValue> e : s.attributes().entrySet()) {
                if (allow.contains(e.getKey())) {
                    b.attribute(e.getKey(), e.getValue());
                }
            }
            return b.build();
        }
    }

    // ------------------------------------------------------------------ guardrails

    /** Phase-one stub: every operation degrades with UnsupportedCapability (never throws). */
    public final class Guardrails {

        private Guardrails() {
        }

        public ExtensionResult<Object> check(String guardrailName, Map<String, Object> args) {
            return ExtensionResult.degraded(
                    FireweaveError.of(ErrorKind.UnsupportedCapability, "unsupported capability"));
        }
    }

    // ------------------------------------------------------------------ capabilities

    /** capabilities.get() — negotiated capability names + static/runtime matrices. */
    public final class CapabilitiesApi {

        private CapabilitiesApi() {
        }

        public Capabilities get() {
            FireweaveConfig cfg = runtime.config();
            List<String> names = new ArrayList<>();
            if (cfg.releasesEnabled()) {
                names.addAll(Arrays.asList(
                        "releases.setContext", "releases.start", "releases.complete", "releases.fail"));
            }
            if (cfg.exposuresEnabled()) {
                names.addAll(Arrays.asList("exposures.record", "exposures.flush"));
            }
            if (cfg.signalsEnabled()) {
                names.addAll(Arrays.asList(
                        "signals.recordHealth", "signals.recordError",
                        "signals.recordMetric", "signals.recordOutcome"));
            }
            names.add("capabilities.get");

            Map<String, Boolean> staticFeatures = new LinkedHashMap<>();
            staticFeatures.put("controlPoints", true);
            staticFeatures.put("flags", true);
            staticFeatures.put("releases", cfg.releasesEnabled());
            staticFeatures.put("exposures", cfg.exposuresEnabled());
            staticFeatures.put("signals", cfg.signalsEnabled());
            staticFeatures.put("guardrails", false);
            staticFeatures.put("telemetryOptIn", cfg.telemetryAttributeAllowlist() != null);
            staticFeatures.put("inMemoryAdapter",
                    "inmemory".equalsIgnoreCase(runtime.adapter().name()));
            staticFeatures.put("remoteAdapter", true);
            // true when a PostHog adapter (injected seam) is bound; create(config) remains
            // UnsupportedCapability until upstream publishes a Java server SDK (RB-3).
            staticFeatures.put("posthogAdapter",
                    "posthog".equalsIgnoreCase(runtime.adapter().name()));

            Map<String, Boolean> runtimeFeatures = new LinkedHashMap<>();
            runtimeFeatures.put("localEvaluation", cfg.localEvaluation());
            runtimeFeatures.put("localOnly", cfg.onlyEvaluateLocally());
            runtimeFeatures.putAll(runtime.adapter().runtimeFeatures());

            return new Capabilities(runtime.adapter().name(), runtime.state(),
                    staticFeatures, runtimeFeatures, Collections.unmodifiableList(names));
        }
    }

    // ------------------------------------------------------------------ control points

    /**
     * Typed evaluation helpers on the Fireweave-native surface.
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

        public int getIntegerValue(String flagKey, int defaultValue, EvaluationContext ctx) {
            Decision d = evaluate(flagKey, FlagType.INTEGER, JsonValue.of(defaultValue), ctx, null);
            if (d.value().kind() != JsonValue.Kind.NUMBER || !d.value().isIntegralNumber()) {
                return defaultValue;
            }
            long l = d.value().asNumber().longValue();
            if (l > Integer.MAX_VALUE || l < Integer.MIN_VALUE) {
                return defaultValue;
            }
            return (int) l;
        }

        public double getDoubleValue(String flagKey, double defaultValue, EvaluationContext ctx) {
            Decision d = evaluate(flagKey, FlagType.FLOAT, JsonValue.of(defaultValue), ctx, null);
            return d.value().kind() == JsonValue.Kind.NUMBER
                    ? d.value().asNumber().doubleValue() : defaultValue;
        }

        public JsonValue getObjectValue(String flagKey, JsonValue defaultValue, EvaluationContext ctx) {
            JsonValue fallback = defaultValue == null ? JsonValue.ofNull() : defaultValue;
            Decision d = evaluate(flagKey, FlagType.OBJECT, fallback, ctx, null);
            JsonValue.Kind k = d.value().kind();
            return (k == JsonValue.Kind.OBJECT || k == JsonValue.Kind.ARRAY) ? d.value() : fallback;
        }
    }

    private static void noteDeprecatedFlagsAlias() {
        if (!"1".equals(System.getenv("FW_DEPRECATION_WARNINGS"))) {
            return;
        }
        if (!FLAGS_DEPRECATION_NOTICED.compareAndSet(false, true)) {
            return;
        }
        LOG.warning("client.flags() has been renamed to client.controlPoints(). "
                + "The old name remains fully supported — no migration is required.");
    }
}
