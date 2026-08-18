package ai.fireweave.sdk;

import java.util.Collections;
import java.util.Map;

/**
 * Vendor seam. Implementations: {@link FireweaveRemoteAdapter} (production fw-server path),
 * {@link FireweaveLocalAdapter} (offline development), {@code InMemoryAdapter}
 * (fireweave-testing, deterministic fixtures), and {@code PostHogAdapter}
 * (fireweave-adapter-posthog, injection seam only).
 *
 * <p><b>Thread-safety:</b> implementations MUST be safe for concurrent {@link #evaluate} calls
 * after {@link #initialize} returns. {@link #initialize} and {@link #shutdown} are invoked at most
 * once each by {@link FireweaveRuntime}, never concurrently with each other.
 *
 * <p>No adapter (vendor) types may leak through this interface — enforced by a reflective
 * signature scan test in fireweave-sdk.
 */
public interface BackendAdapter extends AutoCloseable {

    /** Canonical backend name: "fireweave" | "inmemory" | "posthog" | "other". */
    String name();

    /**
     * Connect / load definitions. Throws {@link FireweaveException} with kind
     * {@code Configuration} (fatal) or a transient kind (Network, Timeout, ...) on failure.
     */
    void initialize(FireweaveConfig config) throws FireweaveException;

    /**
     * Resolve a flag. Returns a successful (or STALE) {@link Decision}, or throws
     * {@link FireweaveException} (FlagNotFound, TypeMismatch, transport kinds, ...). The runtime —
     * never the adapter — converts exceptions into default-valued error decisions.
     */
    Decision evaluate(EvaluationRequest request) throws FireweaveException;

    /**
     * Register a user or device so rules can target its durable properties
     * ({@code POST /v1/targets/register}).
     *
     * <p>Default: {@link ErrorKind#UnsupportedCapability}. Adapters that do not
     * speak the Fireweave remote protocol (in-memory, local, PostHog seam) leave
     * this default so a dev harness does not silently look registered.
     *
     * <p>Must not throw: registration sits in login paths. Return
     * {@link RegisterTargetResult#failure} instead.
     */
    default RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
        return RegisterTargetResult.failure(
                FireweaveError.of(ErrorKind.UnsupportedCapability,
                        ErrorKind.UnsupportedCapability.defaultMessage()));
    }

    /** Deliver a flushed exposure event. Default: drop (adapters without capture). */
    default void deliverExposure(Exposure exposure) throws FireweaveException {
    }

    /** Deliver a recorded signal. Default: drop. */
    default void deliverSignal(Signal signal) throws FireweaveException {
    }

    /**
     * Called after an {@code exposures.flush()} completes. Adapters holding per-flush exposure
     * dedup state clear it here (ratified clear-on-flush lifecycle — dedup scope is one flush
     * window, and the set can never grow unbounded; security review M-2). Default: no-op.
     */
    default void onExposuresFlushed() {
    }

    /** Adapter-specific runtime capability flags (merged into {@link Capabilities}). */
    default Map<String, Boolean> runtimeFeatures() {
        return Collections.emptyMap();
    }

    /**
     * True when the adapter is serving from a stale snapshot/cache (e.g. PostHog per-user remote
     * cache past its freshness window, or last-good local definitions after a failed poll).
     */
    default boolean isStale() {
        return false;
    }

    /** Idempotent release of resources. Never throws. */
    void shutdown();

    @Override
    default void close() {
        shutdown();
    }
}
