package ai.fireweave.sdk.application;

import ai.fireweave.sdk.domain.Decision;
import ai.fireweave.sdk.domain.ErrorKind;
import ai.fireweave.sdk.domain.FireweaveError;
import ai.fireweave.sdk.domain.FireweaveException;

/**
 * Vendor seam. Implementations: {@code FireweaveRemoteAdapter} (production fw-server path),
 * {@code FireweaveLocalAdapter} (offline development).
 *
 * <p><b>Thread-safety:</b> implementations MUST be safe for concurrent {@link #evaluate} calls
 * after {@link #initialize} returns. {@link #initialize} and {@link #shutdown} are invoked at most
 * once each by {@code FireweaveRuntime}, never concurrently with each other.
 *
 * <p>No adapter (vendor) types may leak through this interface — enforced by a reflective
 * signature scan test in fireweave-sdk.
 */
public interface BackendAdapter extends AutoCloseable {

    /** Canonical backend name: "fireweave" | "inmemory" | "other". */
    String name();

    /**
     * Connect / load definitions. Throws {@link FireweaveException} with kind
     * {@code Configuration} (fatal) or a transient kind (Network, Timeout, ...) on failure.
     */
    void initialize(FireweaveConfig config) throws FireweaveException;

    /**
     * Resolve a flag. Returns a {@link Decision} — including, for an adapter whose "unknown key"
     * row is {@code default}/{@code DEFAULT} rather than an error (spec/modes.md "Behaviour per
     * mode"), a plain, non-throwing {@code Decision} carrying the caller's default with reason
     * {@code DEFAULT} — or throws {@link FireweaveException} (FlagNotFound, TypeMismatch,
     * transport kinds, ...) for a genuine failure. The runtime — never the adapter — converts a
     * thrown exception into a default-valued ERROR decision; an adapter that wants the
     * DEFAULT-not-ERROR outcome MUST return it directly rather than throwing, so the runtime can
     * never confuse "no decision for this key" with "the backend failed"
     * ({@code FireweaveLocalAdapter}'s strict, typed miss seam).
     */
    Decision evaluate(EvaluationRequest request) throws FireweaveException;

    /**
     * Register a user or device so rules can target its durable properties
     * ({@code POST /v1/targets/register}).
     *
     * <p>Default: {@link ErrorKind#UnsupportedCapability}. Adapters that do not
     * speak the Fireweave remote protocol and have no local recording story leave
     * this default.
     *
     * <p>Must not throw: registration sits in login paths. Return
     * {@link RegisterTargetResult#failure} instead.
     */
    default RegisterTargetResult registerTarget(String targetingKey, RegisterTargetOptions options) {
        return RegisterTargetResult.failure(
                FireweaveError.of(ErrorKind.UnsupportedCapability,
                        ErrorKind.UnsupportedCapability.defaultMessage()));
    }

    /**
     * True when the adapter is serving from a stale snapshot/cache (e.g. last-good local
     * definitions after a failed poll).
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
