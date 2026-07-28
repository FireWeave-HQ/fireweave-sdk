package ai.fireweave.sdk;

/**
 * Immutable per-evaluation side-effect controls (FireweaveClient detailed path) and
 * construction-level defaults (runtime config).
 */
public final class EvaluationOptions {

    private static final EvaluationOptions DEFAULT = builder().build();

    private final boolean sendExposure;
    private final boolean includePayloadMetadata;

    private EvaluationOptions(Builder b) {
        this.sendExposure = b.sendExposure;
        this.includePayloadMetadata = b.includePayloadMetadata;
    }

    public static EvaluationOptions defaults() {
        return DEFAULT;
    }

    public static Builder builder() {
        return new Builder();
    }

    /**
     * When true, Fireweave delivers one owned exposure on successful evaluate (ruling 20 opt-in).
     * Default {@code false} — side-effect-free evaluate, matching Node/Python/Go.
     */
    public boolean sendExposure() {
        return sendExposure;
    }

    /**
     * When true, decisions expose the variant payload as {@code fireweave.payload} flagMetadata
     * (canonical JSON string; scalar-only metadata contract, orchestrator ruling 8).
     */
    public boolean includePayloadMetadata() {
        return includePayloadMetadata;
    }

    public static final class Builder {
        private boolean sendExposure = false;
        private boolean includePayloadMetadata = false;

        public Builder sendExposure(boolean v) {
            this.sendExposure = v;
            return this;
        }

        public Builder includePayloadMetadata(boolean v) {
            this.includePayloadMetadata = v;
            return this;
        }

        public EvaluationOptions build() {
            return new EvaluationOptions(this);
        }
    }
}
