package ai.fireweave.sdk;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Canonical, immutable Fireweave evaluation context (mirrors
 * {@code spec/evaluation-context.schema.json}).
 *
 * <ul>
 *   <li>{@code targetingKey} is the stable cohort/identity key and maps 1:1 to PostHog
 *       {@code distinct_id}. It is required at evaluation time when the runtime is configured
 *       with {@code requireTargetingKey} (opt-in; defaults to {@code false}) and is never
 *       auto-generated.</li>
 *   <li>Non-reserved attributes map to backend person properties.</li>
 *   <li>Reserved extensions (groups, group properties) are modeled as first-class fields; the
 *       OpenFeature provider maps flattened {@code fireweave.*} keys into them. Phase one
 *       permits exactly {@code fireweave.groups} and {@code fireweave.groupProperties}
 *       (rulings 12–14); unratified evaluation-context tags are not part of this API.</li>
 * </ul>
 *
 * <p>Thread-safety: deeply immutable; safe to share and reuse across threads.
 * Merge order is owned by the OpenFeature SDK (API/global -&gt; transaction -&gt; client -&gt;
 * invocation; later wins). {@link #merge(EvaluationContext)} implements the same later-wins
 * semantics for direct FireweaveClient use (global -&gt; client -&gt; invocation).
 */
public final class EvaluationContext {

    private static final EvaluationContext EMPTY = builder().build();

    private final String targetingKey;
    private final Map<String, JsonValue> attributes;
    private final Map<String, String> groups;
    private final Map<String, Map<String, JsonValue>> groupProperties;

    private EvaluationContext(Builder b) {
        this.targetingKey = b.targetingKey;
        this.attributes = Collections.unmodifiableMap(new LinkedHashMap<>(b.attributes));
        this.groups = Collections.unmodifiableMap(new LinkedHashMap<>(b.groups));
        Map<String, Map<String, JsonValue>> gp = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, JsonValue>> e : b.groupProperties.entrySet()) {
            gp.put(e.getKey(), Collections.unmodifiableMap(new LinkedHashMap<>(e.getValue())));
        }
        this.groupProperties = Collections.unmodifiableMap(gp);
    }

    public static EvaluationContext empty() {
        return EMPTY;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Targeting key, or null when absent (validation rejects absence when required). */
    public String targetingKey() {
        return targetingKey;
    }

    public Map<String, JsonValue> attributes() {
        return attributes;
    }

    public Map<String, String> groups() {
        return groups;
    }

    public Map<String, Map<String, JsonValue>> groupProperties() {
        return groupProperties;
    }

    /** Later-wins merge: {@code other} overrides this context on key conflicts. */
    public EvaluationContext merge(EvaluationContext other) {
        if (other == null) {
            return this;
        }
        Builder b = toBuilder();
        if (other.targetingKey != null) {
            b.targetingKey(other.targetingKey);
        }
        other.attributes.forEach(b::attribute);
        other.groups.forEach(b::group);
        for (Map.Entry<String, Map<String, JsonValue>> e : other.groupProperties.entrySet()) {
            for (Map.Entry<String, JsonValue> p : e.getValue().entrySet()) {
                b.groupProperty(e.getKey(), p.getKey(), p.getValue());
            }
        }
        return b.build();
    }

    public Builder toBuilder() {
        Builder b = new Builder();
        b.targetingKey = targetingKey;
        b.attributes.putAll(attributes);
        b.groups.putAll(groups);
        for (Map.Entry<String, Map<String, JsonValue>> e : groupProperties.entrySet()) {
            b.groupProperties.put(e.getKey(), new LinkedHashMap<>(e.getValue()));
        }
        return b;
    }

    /** Canonical JSON of the whole context (used for the 64 KiB serialized-size bound). */
    public JsonValue toJsonValue() {
        Map<String, JsonValue> root = new LinkedHashMap<>();
        if (targetingKey != null) {
            root.put("targetingKey", JsonValue.of(targetingKey));
        }
        if (!attributes.isEmpty()) {
            root.put("attributes", JsonValue.ofObject(attributes));
        }
        Map<String, JsonValue> reserved = new LinkedHashMap<>();
        if (!groups.isEmpty()) {
            Map<String, JsonValue> g = new LinkedHashMap<>();
            groups.forEach((k, v) -> g.put(k, JsonValue.of(v)));
            reserved.put("groups", JsonValue.ofObject(g));
        }
        if (!groupProperties.isEmpty()) {
            Map<String, JsonValue> gp = new LinkedHashMap<>();
            groupProperties.forEach((k, v) -> gp.put(k, JsonValue.ofObject(v)));
            reserved.put("groupProperties", JsonValue.ofObject(gp));
        }
        if (!reserved.isEmpty()) {
            root.put("reserved", JsonValue.ofObject(reserved));
        }
        return JsonValue.ofObject(root);
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) {
            return true;
        }
        if (!(o instanceof EvaluationContext)) {
            return false;
        }
        EvaluationContext c = (EvaluationContext) o;
        return java.util.Objects.equals(targetingKey, c.targetingKey)
                && attributes.equals(c.attributes)
                && groups.equals(c.groups)
                && groupProperties.equals(c.groupProperties);
    }

    @Override
    public int hashCode() {
        return java.util.Objects.hash(targetingKey, attributes, groups, groupProperties);
    }

    @Override
    public String toString() {
        // Do not dump attributes (may contain PII); identity-level info only.
        return "EvaluationContext{targetingKey=" + targetingKey
                + ", attributes=" + attributes.size()
                + ", groups=" + groups.size() + "}";
    }

    public static final class Builder {
        private String targetingKey;
        private final Map<String, JsonValue> attributes = new LinkedHashMap<>();
        private final Map<String, String> groups = new LinkedHashMap<>();
        private final Map<String, Map<String, JsonValue>> groupProperties = new LinkedHashMap<>();

        public Builder targetingKey(String targetingKey) {
            this.targetingKey = targetingKey;
            return this;
        }

        public Builder attribute(String key, JsonValue value) {
            attributes.put(key, value == null ? JsonValue.ofNull() : value);
            return this;
        }

        public Builder attribute(String key, String value) {
            return attribute(key, value == null ? JsonValue.ofNull() : JsonValue.of(value));
        }

        public Builder attribute(String key, Number value) {
            return attribute(key, value == null ? JsonValue.ofNull() : JsonValue.of(value));
        }

        public Builder attribute(String key, boolean value) {
            return attribute(key, JsonValue.of(value));
        }

        /** Remove a plain attribute (used when promoting canonical fireweave.* keys). */
        public Builder removeAttribute(String key) {
            attributes.remove(key);
            return this;
        }

        public Builder group(String groupType, String groupKey) {
            groups.put(groupType, groupKey);
            return this;
        }

        public Builder groupProperty(String groupType, String key, JsonValue value) {
            groupProperties.computeIfAbsent(groupType, k -> new LinkedHashMap<>())
                    .put(key, value == null ? JsonValue.ofNull() : value);
            return this;
        }

        public EvaluationContext build() {
            return new EvaluationContext(this);
        }
    }
}
