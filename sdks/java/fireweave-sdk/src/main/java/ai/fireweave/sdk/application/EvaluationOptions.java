package ai.fireweave.sdk.application;

/**
 * Reserved fifth argument of {@code evaluate(key, type, default, context?, options?)}
 * (conformance/surface/control-points.surface.json).
 *
 * <p>v1 reads are side-effect free (spec/control-points.md "Side effects": "no read emits
 * telemetry as a consequence of being called") — there is no per-call exposure opt-in or payload
 * inclusion flag to carry, unlike the pre-v1 Java surface this replaces. This type exists purely
 * for cross-language surface parity (every SDK's {@code evaluate} keeps the same arity) and is
 * currently INERT: constructed, threaded through {@link EvaluationRequest}, and read by nothing.
 */
public final class EvaluationOptions {

    private static final EvaluationOptions DEFAULT = new EvaluationOptions();

    private EvaluationOptions() {
    }

    public static EvaluationOptions defaults() {
        return DEFAULT;
    }
}
