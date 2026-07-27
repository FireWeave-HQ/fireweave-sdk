package ai.fireweave.sdk;

/**
 * Ratified context bounds (orchestrator arbitration, Phase 2 exit; see
 * {@code spec/evaluation-context.schema.json} and {@code contracts/README.md}).
 * Immutable; defaults are the canonical values. Overrides exist for conformance tooling only.
 */
public final class ContextLimits {

    public static final int DEFAULT_MAX_ATTRIBUTE_COUNT = 128;
    public static final int DEFAULT_MAX_KEY_BYTES = 256;
    public static final int DEFAULT_MAX_VALUE_BYTES = 4096;
    public static final int DEFAULT_MAX_NESTING_DEPTH = 6;
    public static final int DEFAULT_MAX_SERIALIZED_BYTES = 65536;

    private static final ContextLimits CANONICAL = builder().build();

    private final int maxAttributeCount;
    private final int maxKeyBytes;
    private final int maxValueBytes;
    private final int maxNestingDepth;
    private final int maxSerializedBytes;

    private ContextLimits(Builder b) {
        this.maxAttributeCount = b.maxAttributeCount;
        this.maxKeyBytes = b.maxKeyBytes;
        this.maxValueBytes = b.maxValueBytes;
        this.maxNestingDepth = b.maxNestingDepth;
        this.maxSerializedBytes = b.maxSerializedBytes;
    }

    public static ContextLimits canonical() {
        return CANONICAL;
    }

    public static Builder builder() {
        return new Builder();
    }

    public int maxAttributeCount() {
        return maxAttributeCount;
    }

    public int maxKeyBytes() {
        return maxKeyBytes;
    }

    public int maxValueBytes() {
        return maxValueBytes;
    }

    public int maxNestingDepth() {
        return maxNestingDepth;
    }

    public int maxSerializedBytes() {
        return maxSerializedBytes;
    }

    public static final class Builder {
        private int maxAttributeCount = DEFAULT_MAX_ATTRIBUTE_COUNT;
        private int maxKeyBytes = DEFAULT_MAX_KEY_BYTES;
        private int maxValueBytes = DEFAULT_MAX_VALUE_BYTES;
        private int maxNestingDepth = DEFAULT_MAX_NESTING_DEPTH;
        private int maxSerializedBytes = DEFAULT_MAX_SERIALIZED_BYTES;

        public Builder maxAttributeCount(int v) {
            this.maxAttributeCount = v;
            return this;
        }

        public Builder maxKeyBytes(int v) {
            this.maxKeyBytes = v;
            return this;
        }

        public Builder maxValueBytes(int v) {
            this.maxValueBytes = v;
            return this;
        }

        public Builder maxNestingDepth(int v) {
            this.maxNestingDepth = v;
            return this;
        }

        public Builder maxSerializedBytes(int v) {
            this.maxSerializedBytes = v;
            return this;
        }

        public ContextLimits build() {
            return new ContextLimits(this);
        }
    }
}
