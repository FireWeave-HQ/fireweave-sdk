package ai.fireweave.sdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Immutable release / rollout context (spec {@code release-context.schema.json}).
 * {@code stampIds} is required (1..64 unique typed ULIDs, {@code stmp_...}).
 */
public final class ReleaseContext {

    private final List<String> stampIds;
    private final String rolloutId;
    private final String changeId;
    private final Map<String, Object> metadata;

    private ReleaseContext(Builder b) {
        if (b.stampIds.isEmpty()) {
            throw new IllegalArgumentException("stampIds requires at least one entry");
        }
        this.stampIds = Collections.unmodifiableList(new ArrayList<>(b.stampIds));
        this.rolloutId = b.rolloutId;
        this.changeId = b.changeId;
        this.metadata = Collections.unmodifiableMap(new LinkedHashMap<>(b.metadata));
    }

    public static Builder builder() {
        return new Builder();
    }

    public List<String> stampIds() {
        return stampIds;
    }

    public String rolloutId() {
        return rolloutId;
    }

    public String changeId() {
        return changeId;
    }

    /** Scalar-only metadata (string/number/boolean values). */
    public Map<String, Object> metadata() {
        return metadata;
    }

    public static final class Builder {
        private final List<String> stampIds = new ArrayList<>();
        private String rolloutId;
        private String changeId;
        private final Map<String, Object> metadata = new LinkedHashMap<>();

        public Builder stampId(String stampId) {
            if (!stampIds.contains(stampId)) {
                stampIds.add(stampId);
            }
            return this;
        }

        public Builder stampIds(List<String> ids) {
            ids.forEach(this::stampId);
            return this;
        }

        public Builder rolloutId(String rolloutId) {
            this.rolloutId = rolloutId;
            return this;
        }

        public Builder changeId(String changeId) {
            this.changeId = changeId;
            return this;
        }

        public Builder metadata(String key, Object value) {
            if (value != null) {
                if (!(value instanceof Boolean || value instanceof String || value instanceof Number)) {
                    throw new IllegalArgumentException("release metadata values must be scalar");
                }
                metadata.put(key, value);
            }
            return this;
        }

        public ReleaseContext build() {
            return new ReleaseContext(this);
        }
    }
}
