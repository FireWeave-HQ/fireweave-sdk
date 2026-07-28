package ai.fireweave.sdk;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Immutable release / rollout context (spec {@code release-context.schema.json}).
 *
 * <p>Construction is permissive so invalid contexts can be represented and rejected at the
 * boundary: {@code releases.setContext} calls {@link #validate()}, which enforces exactly the
 * spec's required fields and shapes (ruling 15) — {@code rolloutId} required (1..128 chars),
 * {@code stampIds} required (1..64 unique typed ULIDs, {@code stmp_<26-char Crockford>}),
 * {@code changeId} optional but pattern-checked when present.
 */
public final class ReleaseContext {

    private static final java.util.regex.Pattern STAMP_ID_PATTERN =
            java.util.regex.Pattern.compile("^stmp_[0-9A-HJKMNP-TV-Z]{26}$");
    private static final java.util.regex.Pattern CHANGE_ID_PATTERN =
            java.util.regex.Pattern.compile("^chg_[0-9A-HJKMNP-TV-Z]{26}$");
    private static final int MAX_STAMP_IDS = 64;
    private static final int MAX_ROLLOUT_ID_LENGTH = 128;

    private final List<String> stampIds;
    private final String rolloutId;
    private final String changeId;
    private final Map<String, Object> metadata;

    private ReleaseContext(Builder b) {
        this.stampIds = Collections.unmodifiableList(new ArrayList<>(b.stampIds));
        this.rolloutId = b.rolloutId;
        this.changeId = b.changeId;
        this.metadata = Collections.unmodifiableMap(new LinkedHashMap<>(b.metadata));
    }

    /**
     * Validate against {@code spec/release-context.schema.json} (ruling 15). Fixed, value-free
     * message — IDs and metadata never echo into errors.
     */
    void validate() throws FireweaveException {
        if (rolloutId == null || rolloutId.isEmpty() || rolloutId.length() > MAX_ROLLOUT_ID_LENGTH) {
            throw new FireweaveException(ErrorKind.InvalidContext, "invalid release context");
        }
        if (stampIds.isEmpty() || stampIds.size() > MAX_STAMP_IDS) {
            throw new FireweaveException(ErrorKind.InvalidContext, "invalid release context");
        }
        for (String stampId : stampIds) {
            if (stampId == null || !STAMP_ID_PATTERN.matcher(stampId).matches()) {
                throw new FireweaveException(ErrorKind.InvalidContext, "invalid release context");
            }
        }
        if (changeId != null && !CHANGE_ID_PATTERN.matcher(changeId).matches()) {
            throw new FireweaveException(ErrorKind.InvalidContext, "invalid release context");
        }
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
