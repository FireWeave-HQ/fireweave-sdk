package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.EvaluationContext;
import ai.fireweave.sdk.domain.FireweaveError;
import ai.fireweave.sdk.domain.FireweaveException;
import ai.fireweave.sdk.domain.FlagType;
import ai.fireweave.sdk.domain.JsonValue;
import ai.fireweave.sdk.domain.LifecycleState;
import ai.fireweave.sdk.domain.Reasons;
import ai.fireweave.sdk.domain.Validation;
import ai.fireweave.sdk.domain.Validation.Validated;

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
 * <p>Normal evaluation NEVER throws (spec/control-points.md "Return discipline"): every failure
 * degrades to the caller default with {@code reason=ERROR} and {@code fireweave.errorKind} flag
 * metadata. Validation runs in the fixed order spec/control-points.md "Validation, before any
 * I/O" names — key, default-vs-type, context, lifecycle — via {@link Validation}'s pure,
 * {@code Validated}-returning functions, stopping at the first failure; only once all four pass
 * does this reach the adapter (the one I/O call in {@link #evaluate}).
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
     * causal {@link FireweaveException} — initialisation fails loudly (spec/modes.md).
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
     * Register a user or device so rules can target its durable properties.
     *
     * <p>Call once per login / device provisioning, then send the same targeting
     * key on evaluate. Per-request attributes still override stored properties
     * for a single evaluation (spec/remote-protocol.md § Two identity paths).
     *
     * <p>Never throws: this runs in sign-in paths. Adapters without the
     * capability report {@link ErrorKind#UnsupportedCapability}.
     */
    public RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
        FireweaveException gate = lifecycleGate();
        if (gate != null) {
            return RegisterTargetResult.failure(FireweaveError.from(gate));
        }
        RegisterTargetOptions opts = options == null ? RegisterTargetOptions.empty() : options;
        try {
            return adapter.registerTarget(targetingKey == null ? "" : targetingKey, opts);
        } catch (FireweaveException e) {
            return RegisterTargetResult.failure(FireweaveError.from(e));
        } catch (RuntimeException e) {
            return RegisterTargetResult.failure(
                    FireweaveError.of(ErrorKind.Internal, ErrorKind.Internal.defaultMessage()));
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
        Validated<String> keyResult = Validation.validateControlPointKey(flagKey);
        if (!keyResult.isOk()) {
            return errorDecision(flagKey, defaultValue, keyResult.error());
        }

        Validated<JsonValue> defaultResult = Validation.validateDefaultValue(type, defaultValue);
        if (!defaultResult.isOk()) {
            return errorDecision(flagKey, defaultValue, defaultResult.error());
        }

        EvaluationContext merged = config.globalContext()
                .merge(clientContext == null ? EvaluationContext.empty() : clientContext)
                .merge(invocationContext == null ? EvaluationContext.empty() : invocationContext);

        Validated<EvaluationContext> contextResult = Validation.validateContext(
                merged, config.requireTargetingKey(), config.limits(), config.reservedAttributeKeys());
        if (!contextResult.isOk()) {
            return errorDecision(flagKey, defaultValue, contextResult.error());
        }
        EvaluationContext canonical = contextResult.value();

        FireweaveException gate = lifecycleGate();
        if (gate != null) {
            return errorDecision(flagKey, defaultValue, gate);
        }

        EvaluationRequest request = new EvaluationRequest(flagKey, type, defaultValue, canonical, options);
        try {
            return adapter.evaluate(request);
        } catch (FireweaveException e) {
            return errorDecision(flagKey, defaultValue, e);
        } catch (RuntimeException e) {
            return errorDecision(flagKey, defaultValue,
                    new FireweaveException(ErrorKind.Internal, ErrorKind.Internal.defaultMessage(), e));
        }
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
     *
     * <p>Adapter close is bounded by {@link FireweaveConfig#shutdownTimeoutMs()} (security review
     * M-1): the adapter is closed on a daemon thread and waited on for at most the configured
     * deadline, so a wedged vendor client can never hang process exit. On deadline expiry the
     * closer thread is interrupted, {@link #lastError()} records a {@code Timeout}, and shutdown
     * returns; the abandoned daemon thread cannot block JVM termination.
     */
    public void shutdown() {
        synchronized (stateLock) {
            if (state == LifecycleState.SHUTDOWN) {
                return;
            }
            state = LifecycleState.SHUTDOWN;
        }
        final java.util.concurrent.atomic.AtomicReference<RuntimeException> failure =
                new java.util.concurrent.atomic.AtomicReference<>();
        Thread closer = new Thread(() -> {
            try {
                adapter.shutdown();
            } catch (RuntimeException e) {
                failure.set(e);
            }
        }, "fireweave-shutdown");
        closer.setDaemon(true);
        closer.start();
        long timeoutMs = config.shutdownTimeoutMs();
        try {
            if (timeoutMs > 0) {
                closer.join(timeoutMs);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (closer.isAlive()) {
            closer.interrupt();
            lastError = FireweaveError.of(ErrorKind.Timeout, "shutdown deadline exceeded");
        } else if (failure.get() != null) {
            lastError = FireweaveError.of(ErrorKind.Internal, "shutdown cleanup error");
        }
    }

    @Override
    public void close() {
        shutdown();
    }
}
