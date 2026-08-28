package ai.fireweave.sdk.application;

/**
 * Reserved fifth argument of {@code evaluate(key, type, default, context?, options?)}
 * (conformance/surface/control-points.surface.json).
 *
 * <p>v1 reads are side-effect free (spec/control-points.md "Side effects": "no read emits
 * telemetry as a consequence of being called") — there is no per-call exposure opt-in to carry,
 * unlike the pre-v1 Java surface this replaces.
 *
 * <p>{@link #includePayload()} (task-10b item 5, contracts/evaluation/eval-payload-attached.json)
 * is the one real field: node's {@code EvaluateOptions.includePayload} has the equivalent effect
 * — attach the resolved flag's payload, when any, as {@code fireweave.payload} metadata (a
 * deterministic sorted-key JSON string). Before task-10b this type was entirely INERT
 * (constructed, threaded through {@link EvaluationRequest}, and read by nothing).
 */
public final class EvaluationOptions {

    private static final EvaluationOptions DEFAULT = new EvaluationOptions(false);
    private static final EvaluationOptions INCLUDE_PAYLOAD = new EvaluationOptions(true);

    private final boolean includePayload;

    private EvaluationOptions(boolean includePayload) {
        this.includePayload = includePayload;
    }

    public static EvaluationOptions defaults() {
        return DEFAULT;
    }

    /** An options instance requesting {@code fireweave.payload} metadata when available. */
    public static EvaluationOptions withIncludePayload(boolean includePayload) {
        return includePayload ? INCLUDE_PAYLOAD : DEFAULT;
    }

    public boolean includePayload() {
        return includePayload;
    }
}
