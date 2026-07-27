package ai.fireweave.adapter.posthog;

import ai.fireweave.sdk.JsonValue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Immutable snapshot of a /flags?v=2 response (or a local-eval pass) for one subject.
 * {@code ageMs} is the freshness of the underlying data — nonzero when the vendor SDK served a
 * cached per-user result (its remote cache holds entries up to 5 minutes) or last-good local
 * definitions; the adapter surfaces this as STALE instead of silently serving it as fresh.
 */
public final class PostHogFlagsSnapshot {

    /** Per-flag vendor result (Fireweave-owned DTO, mirrors the wire shape). */
    public static final class FlagResult {
        private final String key;
        private final boolean enabled;
        private final String variant;
        private final JsonValue value;
        private final JsonValue payload;
        private final String reasonCode;
        private final Integer conditionIndex;
        private final Number flagId;
        private final Number version;

        public FlagResult(String key, boolean enabled, String variant, JsonValue value,
                          JsonValue payload, String reasonCode, Integer conditionIndex,
                          Number flagId, Number version) {
            this.key = key;
            this.enabled = enabled;
            this.variant = variant;
            this.value = value;
            this.payload = payload;
            this.reasonCode = reasonCode;
            this.conditionIndex = conditionIndex;
            this.flagId = flagId;
            this.version = version;
        }

        public String key() {
            return key;
        }

        public boolean enabled() {
            return enabled;
        }

        public String variant() {
            return variant;
        }

        /** Typed value when the flag carries one; null for plain boolean/variant flags. */
        public JsonValue value() {
            return value;
        }

        public JsonValue payload() {
            return payload;
        }

        public String reasonCode() {
            return reasonCode;
        }

        public Integer conditionIndex() {
            return conditionIndex;
        }

        public Number flagId() {
            return flagId;
        }

        public Number version() {
            return version;
        }
    }

    private final Map<String, FlagResult> flags;
    private final List<String> quotaLimited;
    private final boolean errorsWhileComputingFlags;
    private final long ageMs;

    public PostHogFlagsSnapshot(Map<String, FlagResult> flags,
                                List<String> quotaLimited,
                                boolean errorsWhileComputingFlags,
                                long ageMs) {
        this.flags = Collections.unmodifiableMap(new LinkedHashMap<>(flags));
        this.quotaLimited = Collections.unmodifiableList(
                new ArrayList<>(quotaLimited == null ? Collections.emptyList() : quotaLimited));
        this.errorsWhileComputingFlags = errorsWhileComputingFlags;
        this.ageMs = ageMs;
    }

    public Map<String, FlagResult> flags() {
        return flags;
    }

    public List<String> quotaLimited() {
        return quotaLimited;
    }

    public boolean errorsWhileComputingFlags() {
        return errorsWhileComputingFlags;
    }

    public long ageMs() {
        return ageMs;
    }
}
