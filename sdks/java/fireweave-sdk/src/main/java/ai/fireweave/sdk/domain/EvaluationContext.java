package ai.fireweave.sdk.domain;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Canonical, immutable Fireweave evaluation context (mirrors
 * {@code spec/evaluation-context.schema.json}).
 *
 * <ul>
 *   <li>{@code targetingKey} is the stable cohort/identity key. It is required at evaluation
 *       time when the runtime is configured with {@code requireTargetingKey} (opt-in; defaults
 *       to {@code false}) and is never auto-generated.</li>
 *   <li>Non-reserved attributes map to backend person properties.</li>
 *   <li>Reserved extensions (groups, group properties) are modeled as first-class fields; phase
 *       one permits exactly {@code fireweave.groups} and {@code fireweave.groupProperties}
 *       (rulings 12-14).</li>
 * </ul>
 *
 * <p>Thread-safety: deeply immutable; safe to share and reuse across threads. Merge order:
 * global -&gt; client -&gt; invocation (later wins); {@link #merge(EvaluationContext)}
 * implements that later-wins semantics one layer at a time.
 */
public final class EvaluationContext {

    private static final EvaluationContext EMPTY = builder().build();

    private final String targetingKey;
    private final Map<String, JsonValue> attributes;
    private final Map<String, String> groups;
    private final Map<String, Map<String, JsonValue>> groupProperties;
    private final boolean hadCyclicInput;

    private EvaluationContext(Builder b) {
        this.targetingKey = b.targetingKey;
        this.attributes = Collections.unmodifiableMap(new LinkedHashMap<>(b.attributes));
        this.groups = Collections.unmodifiableMap(new LinkedHashMap<>(b.groups));
        Map<String, Map<String, JsonValue>> gp = new LinkedHashMap<>();
        for (Map.Entry<String, Map<String, JsonValue>> e : b.groupProperties.entrySet()) {
            gp.put(e.getKey(), Collections.unmodifiableMap(new LinkedHashMap<>(e.getValue())));
        }
        this.groupProperties = Collections.unmodifiableMap(gp);
        this.hadCyclicInput = b.hadCyclicInput;
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

    /**
     * True when building this context (or a layer merged into it) broke a reference cycle in a
     * raw {@code Object} attribute value ({@link Builder#attribute(String, Object)}).
     *
     * <p>Construction itself never throws or overflows the stack on a cyclic input — a cycle is
     * detected via identity and the cyclic branch is replaced with {@code null} instead of being
     * recursed into (see {@link Builder#convert}) — but "did not crash" is a different claim from
     * "is valid". {@code Validation.validateContext} reads this flag FIRST, before any other
     * rule, and fails closed as {@code InvalidContext} (spec/control-points.md "Validation,
     * before any I/O"), mirroring node's {@code validateContext} (WeakSet-based cycle detection)
     * and python's ratified {@code _had_cyclic_input} fix (Task 7 review round).
     */
    public boolean hadCyclicInput() {
        return hadCyclicInput;
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
        // Propagated, not recomputed: a layer's own cycle was already broken to null by its
        // own construction, so the flag is the only surviving evidence it happened (see
        // hadCyclicInput()). Without this, evaluate()'s global->client->invocation merge would
        // never see a cyclic invocation context as cyclic.
        b.hadCyclicInput = this.hadCyclicInput || other.hadCyclicInput;
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
        b.hadCyclicInput = hadCyclicInput;
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
        private boolean hadCyclicInput;

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

        /**
         * Convenience overload accepting a raw Java object graph (null / Boolean / Number /
         * String / List&lt;?&gt; / Map&lt;?,?&gt; / JsonValue, arbitrarily nested) — the natural
         * shape of e.g. a JSON-deserialized attribute value, which the {@code JsonValue}-only
         * overloads above force a caller to hand-convert one level at a time.
         *
         * <p>Ordinary {@code java.util.Map}/{@code java.util.List} CAN be self-referential
         * ({@code Map<String,Object> m = new HashMap<>(); m.put("self", m);}), unlike this SDK's
         * immutable, copy-on-construct {@link JsonValue} tree, which cannot represent a cycle at
         * all through its own builder. This overload is therefore the one reachable place a
         * genuinely cyclic evaluation-context input can enter the Java SDK. A cycle is detected
         * by identity (a container already on the current recursion path — a real cycle, not
         * merely the same object shared by two sibling branches, which backtracking correctly
         * copies without a false positive) and the cyclic branch is replaced with {@code null}
         * instead of being recursed into, so construction itself never throws or blows the
         * stack. The context is instead marked via {@link #hadCyclicInput} (see
         * {@link EvaluationContext#hadCyclicInput()}), which the validation pipeline fails
         * closed on.
         *
         * @throws IllegalArgumentException for a value of an unsupported type (a genuine
         *     caller bug, not a data-driven failure — distinct from the cyclic-input case above).
         */
        public Builder attribute(String key, Object rawValue) {
            Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<>());
            boolean[] cyclic = {false};
            JsonValue converted = convert(rawValue, seen, cyclic);
            if (cyclic[0]) {
                this.hadCyclicInput = true;
            }
            return attribute(key, converted);
        }

        private static JsonValue convert(Object v, Set<Object> seen, boolean[] cyclic) {
            if (v == null) {
                return JsonValue.ofNull();
            }
            if (v instanceof JsonValue) {
                return (JsonValue) v;
            }
            if (v instanceof Boolean) {
                return JsonValue.of((Boolean) v);
            }
            if (v instanceof Number) {
                return JsonValue.of((Number) v);
            }
            if (v instanceof String) {
                return JsonValue.of((String) v);
            }
            if (v instanceof Map) {
                if (!seen.add(v)) {
                    cyclic[0] = true;
                    return JsonValue.ofNull();
                }
                try {
                    Map<String, JsonValue> out = new LinkedHashMap<>();
                    for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                        out.put(String.valueOf(e.getKey()), convert(e.getValue(), seen, cyclic));
                    }
                    return JsonValue.ofObject(out);
                } finally {
                    seen.remove(v); // backtrack: a sibling may legitimately share this reference
                }
            }
            if (v instanceof List) {
                if (!seen.add(v)) {
                    cyclic[0] = true;
                    return JsonValue.ofNull();
                }
                try {
                    List<JsonValue> out = new ArrayList<>();
                    for (Object item : (List<?>) v) {
                        out.add(convert(item, seen, cyclic));
                    }
                    return JsonValue.ofArray(out);
                } finally {
                    seen.remove(v);
                }
            }
            throw new IllegalArgumentException(
                    "unsupported evaluation context attribute value type: " + v.getClass().getName());
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
