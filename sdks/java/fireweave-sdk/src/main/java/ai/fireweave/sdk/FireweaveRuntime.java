package ai.fireweave.sdk;

import java.util.Map;

/**
 * Shared Fireweave runtime: lifecycle state machine + evaluation pipeline over an injected
 * {@link BackendAdapter}. Construct one per logical client/domain — there are no static globals.
 *
 * <h2>Thread-safety</h2>
 * <ul>
 *   <li>Lifecycle transitions ({@link #initialize()}, {@link #shutdown()}, internal
 *       READY⇄STALE/ERROR moves) are serialized on an internal lock.</li>
 *   <li>{@link #state()} is a volatile read; {@link #evaluate} reads state without locking so
 *       concurrent evaluations never contend. An evaluation racing a shutdown may either complete
 *       normally or return an {@code AlreadyClosed} default decision — never throw.</li>
 *   <li>Configuration and contexts are immutable; the adapter must be internally thread-safe
 *       (see {@link BackendAdapter}).</li>
 * </ul>
 *
 * <p>Normal evaluation NEVER throws: every failure degrades to the caller default with
 * {@code reason=ERROR} and {@code fireweave.errorKind} flag metadata.
 */
public final class FireweaveRuntime implements AutoCloseable {

    private final FireweaveConfig config;
    private final BackendAdapter adapter;
    private final Object stateLock = new Object();
    private volatile LifecycleState state = LifecycleState.UNINITIALIZED;
    private volatile FireweaveError lastError;

    public FireweaveRuntime(FireweaveConfig config, BackendAdapter adapter) {
        this.config = java.util.Objects.requireNonNull(config, "config");
        this.adapter = java.util.Objects.requireNonNull(adapter, "adapter");
    }

    public FireweaveConfig config() {
        return config;
    }

    public BackendAdapter adapter() {
        return adapter;
    }

    public LifecycleState state() {
        // Surface STALE dynamically when the adapter reports a stale snapshot while READY.
        LifecycleState s = state;
        if (s == LifecycleState.READY && adapter.isStale()) {
            return LifecycleState.STALE;
        }
        return s;
    }

    /** Last lifecycle-level error (initialize/shutdown), or null. */
    public FireweaveError lastError() {
        return lastError;
    }

    /**
     * Validate config and initialize the adapter. Transitions UNINITIALIZED→INITIALIZING→READY.
     * On {@code Configuration} failure transitions to FATAL; other failures to ERROR. Throws the
     * causal {@link FireweaveException} so provider integrations can surface OF error codes.
     */
    public void initialize() throws FireweaveException {
        synchronized (stateLock) {
            if (state == LifecycleState.SHUTDOWN) {
                throw new FireweaveException(ErrorKind.AlreadyClosed);
            }
            if (state != LifecycleState.UNINITIALIZED) {
                return; // idempotent: already initializing/initialized
            }
            state = LifecycleState.INITIALIZING;
        }
        try {
            config.validate();
            adapter.initialize(config);
        } catch (FireweaveException e) {
            synchronized (stateLock) {
                state = e.kind() == ErrorKind.Configuration ? LifecycleState.FATAL : LifecycleState.ERROR;
                lastError = FireweaveError.from(e);
            }
            throw e;
        } catch (RuntimeException e) {
            FireweaveException wrapped =
                    new FireweaveException(ErrorKind.Internal, ErrorKind.Internal.defaultMessage(), e);
            synchronized (stateLock) {
                state = LifecycleState.ERROR;
                lastError = FireweaveError.from(wrapped);
            }
            throw wrapped;
        }
        synchronized (stateLock) {
            if (state == LifecycleState.INITIALIZING) {
                state = LifecycleState.READY;
                lastError = null;
            }
        }
    }

    /**
     * Evaluate a flag. Merge order (later wins): config global context → {@code clientContext} →
     * {@code invocationContext}. Never throws.
     */
    public Decision evaluate(String flagKey,
                             FlagType type,
                             JsonValue defaultValue,
                             EvaluationContext clientContext,
                             EvaluationContext invocationContext,
                             EvaluationOptions options) {
        EvaluationOptions opts = options == null ? config.defaultEvaluationOptions() : options;

        FireweaveException gate = lifecycleGate();
        if (gate != null) {
            return errorDecision(flagKey, defaultValue, gate);
        }

        EvaluationContext merged = config.globalContext()
                .merge(clientContext == null ? EvaluationContext.empty() : clientContext)
                .merge(invocationContext == null ? EvaluationContext.empty() : invocationContext);

        try {
            ContextValidator.validate(merged, config.requireTargetingKey(), config.limits(),
                    config.reservedAttributeKeys());
        } catch (FireweaveException e) {
            return errorDecision(flagKey, defaultValue, e);
        }

        EvaluationRequest request = new EvaluationRequest(flagKey, type, defaultValue, merged, opts);
        Decision decision;
        try {
            decision = adapter.evaluate(request);
        } catch (FireweaveException e) {
            return errorDecision(flagKey, defaultValue, e);
        } catch (RuntimeException e) {
            return errorDecision(flagKey, defaultValue,
                    new FireweaveException(ErrorKind.Internal, ErrorKind.Internal.defaultMessage(), e));
        }
        return enrich(decision, opts);
    }

    /** Attach fireweave.payload metadata when requested; leave everything else untouched. */
    private Decision enrich(Decision d, EvaluationOptions opts) {
        if (!opts.includePayloadMetadata() || d.payload() == null
                || d.flagMetadata().containsKey("fireweave.payload")) {
            return d;
        }
        Decision.Builder b = Decision.builder(d.flagKey())
                .value(d.value())
                .variant(d.variant())
                .reason(d.reason())
                .error(d.error())
                .payload(d.payload())
                .exposureEmitted(d.exposureEmitted())
                .exposureSuppressed(d.exposureSuppressed());
        for (Map.Entry<String, Object> e : d.flagMetadata().entrySet()) {
            b.metadata(e.getKey(), e.getValue());
        }
        b.metadata("fireweave.payload", d.payload().toCanonicalJson());
        return b.build();
    }

    /** Non-null exception when the current lifecycle state cannot serve evaluations. */
    FireweaveException lifecycleGate() {
        LifecycleState s = state;
        switch (s) {
            case SHUTDOWN:
                return new FireweaveException(ErrorKind.AlreadyClosed);
            case UNINITIALIZED:
            case INITIALIZING:
            case FATAL:
            case ERROR:
                return new FireweaveException(ErrorKind.NotReady);
            default:
                return null;
        }
    }

    static Decision errorDecision(String flagKey, JsonValue defaultValue, FireweaveException e) {
        Decision.Builder b = Decision.builder(flagKey)
                .value(defaultValue)
                .reason(Reasons.ERROR)
                .error(FireweaveError.from(e))
                .metadata(ErrorKind.FLAG_METADATA_ERROR_KIND_KEY, e.kind().name());
        for (Map.Entry<String, Object> m : e.decisionMetadata().entrySet()) {
            b.metadata(m.getKey(), m.getValue());
        }
        return b.build();
    }

    /**
     * Idempotent shutdown: first call transitions to SHUTDOWN and closes the adapter; subsequent
     * calls are no-ops. Never throws.
     */
    public void shutdown() {
        synchronized (stateLock) {
            if (state == LifecycleState.SHUTDOWN) {
                return;
            }
            state = LifecycleState.SHUTDOWN;
        }
        try {
            adapter.shutdown();
        } catch (RuntimeException e) {
            lastError = FireweaveError.of(ErrorKind.Internal, "shutdown cleanup error");
        }
    }

    @Override
    public void close() {
        shutdown();
    }
}
