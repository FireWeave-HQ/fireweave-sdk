package ai.fireweave.sdk;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;

/**
 * Validates evaluation contexts against the ratified bounds and reserved-key rules
 * <em>before</em> any adapter/network call. Violations raise
 * {@link FireweaveException} with kind {@link ErrorKind#InvalidContext} (OpenFeature
 * {@code INVALID_CONTEXT}, or {@code TARGETING_KEY_MISSING} for a missing targeting key),
 * which the runtime converts into a default-valued decision (never a throw to the caller).
 *
 * <p>Messages are fixed, safe strings; attribute values (which may contain PII) are never
 * echoed into error messages.
 */
public final class ContextValidator {

    /** Attribute names that must never appear as ordinary person attributes. */
    public static final String RESERVED_PREFIX = "fireweave.";

    /** Canonical reserved context key carrying PostHog groups (rulings 12–14). */
    public static final String GROUPS_KEY = "fireweave.groups";

    /** Canonical reserved context key carrying PostHog group properties (rulings 12–14). */
    public static final String GROUP_PROPERTIES_KEY = "fireweave.groupProperties";

    /**
     * The ONLY permitted {@code fireweave.*} context keys (ruling 13). Every other
     * {@code fireweave.*} key is rejected as {@code InvalidContext}.
     */
    private static final Set<String> CANONICAL_RESERVED_KEYS = new java.util.HashSet<>(
            java.util.Arrays.asList(GROUPS_KEY, GROUP_PROPERTIES_KEY));

    private ContextValidator() {
    }

    /**
     * Promote the canonical {@code fireweave.groups} / {@code fireweave.groupProperties}
     * context keys (rulings 12–14: the primary cross-language path; the {@code .group()}
     * builder is idiomatic sugar over the same canonical representation) into the context's
     * first-class groups / groupProperties fields. Malformed shapes (non-object values,
     * non-string group keys) raise {@code InvalidContext}. Attribute spellings win over
     * builder-set entries on conflict (later-wins, consistent with merge semantics).
     */
    public static EvaluationContext promoteCanonicalKeys(EvaluationContext context)
            throws FireweaveException {
        Map<String, JsonValue> attrs = context.attributes();
        JsonValue groups = attrs.get(GROUPS_KEY);
        JsonValue groupProps = attrs.get(GROUP_PROPERTIES_KEY);
        if (groups == null && groupProps == null) {
            return context;
        }
        EvaluationContext.Builder b = context.toBuilder();
        if (groups != null) {
            if (groups.kind() != JsonValue.Kind.OBJECT) {
                throw new FireweaveException(ErrorKind.InvalidContext, "invalid evaluation context");
            }
            for (Map.Entry<String, JsonValue> e : groups.asObject().entrySet()) {
                if (e.getValue().kind() != JsonValue.Kind.STRING
                        || e.getValue().asString().isEmpty()) {
                    throw new FireweaveException(ErrorKind.InvalidContext, "invalid evaluation context");
                }
                b.group(e.getKey(), e.getValue().asString());
            }
            b.removeAttribute(GROUPS_KEY);
        }
        if (groupProps != null) {
            if (groupProps.kind() != JsonValue.Kind.OBJECT) {
                throw new FireweaveException(ErrorKind.InvalidContext, "invalid evaluation context");
            }
            for (Map.Entry<String, JsonValue> e : groupProps.asObject().entrySet()) {
                if (e.getValue().kind() != JsonValue.Kind.OBJECT) {
                    throw new FireweaveException(ErrorKind.InvalidContext, "invalid evaluation context");
                }
                for (Map.Entry<String, JsonValue> p : e.getValue().asObject().entrySet()) {
                    b.groupProperty(e.getKey(), p.getKey(), p.getValue());
                }
            }
            b.removeAttribute(GROUP_PROPERTIES_KEY);
        }
        return b.build();
    }

    public static void validate(EvaluationContext context,
                                boolean requireTargetingKey,
                                ContextLimits limits,
                                Set<String> reservedAttributeKeys) throws FireweaveException {
        if (requireTargetingKey && (context.targetingKey() == null || context.targetingKey().isEmpty())) {
            throw FireweaveException.targetingKeyMissing();
        }
        if (context.targetingKey() != null && context.targetingKey().length() > 512) {
            throw new FireweaveException(ErrorKind.InvalidContext, "targeting key exceeds maximum size");
        }

        Map<String, JsonValue> attrs = context.attributes();

        for (String key : attrs.keySet()) {
            // Ruling 13 carve-out: fireweave.groups / fireweave.groupProperties are the only
            // permitted fireweave.* keys (normally promoted to first-class fields before
            // validation; tolerated here for direct validate() callers).
            if (key.startsWith(RESERVED_PREFIX) && !CANONICAL_RESERVED_KEYS.contains(key)) {
                throw new FireweaveException(ErrorKind.InvalidContext, "invalid evaluation context");
            }
            if (reservedAttributeKeys != null && reservedAttributeKeys.contains(key)) {
                throw new FireweaveException(ErrorKind.InvalidContext, "invalid evaluation context");
            }
        }

        if (attrs.size() > limits.maxAttributeCount()) {
            throw new FireweaveException(ErrorKind.InvalidContext, "context exceeds maximum attribute count");
        }

        for (Map.Entry<String, JsonValue> e : attrs.entrySet()) {
            if (utf8Size(e.getKey()) > limits.maxKeyBytes()) {
                throw new FireweaveException(ErrorKind.InvalidContext, "context key exceeds maximum size");
            }
            checkValue(e.getValue(), limits);
        }

        // Depth: the attributes object itself is depth 1; nested containers add levels.
        if (!attrs.isEmpty() && 1 + depthOfContainers(attrs) > limits.maxNestingDepth()) {
            throw new FireweaveException(ErrorKind.InvalidContext, "context exceeds maximum nesting depth");
        }

        if (context.toJsonValue().canonicalUtf8Size() > limits.maxSerializedBytes()) {
            throw new FireweaveException(ErrorKind.InvalidContext, "serialized context exceeds maximum size");
        }
    }

    /** Max container-nesting contributed by attribute values (scalar value = 0). */
    private static int depthOfContainers(Map<String, JsonValue> attrs) {
        int max = 0;
        for (JsonValue v : attrs.values()) {
            max = Math.max(max, containerDepth(v));
        }
        return max;
    }

    private static int containerDepth(JsonValue v) {
        switch (v.kind()) {
            case ARRAY: {
                int max = 0;
                for (JsonValue child : v.asArray()) {
                    max = Math.max(max, containerDepth(child));
                }
                return 1 + max;
            }
            case OBJECT: {
                int max = 0;
                for (JsonValue child : v.asObject().values()) {
                    max = Math.max(max, containerDepth(child));
                }
                return 1 + max;
            }
            default:
                return 0;
        }
    }

    private static void checkValue(JsonValue v, ContextLimits limits) throws FireweaveException {
        switch (v.kind()) {
            case STRING:
                if (utf8Size(v.asString()) > limits.maxValueBytes()) {
                    throw new FireweaveException(ErrorKind.InvalidContext, "context value exceeds maximum size");
                }
                break;
            case ARRAY:
                for (JsonValue child : v.asArray()) {
                    checkValue(child, limits);
                }
                break;
            case OBJECT:
                for (Map.Entry<String, JsonValue> e : v.asObject().entrySet()) {
                    if (utf8Size(e.getKey()) > limits.maxKeyBytes()) {
                        throw new FireweaveException(ErrorKind.InvalidContext, "context key exceeds maximum size");
                    }
                    checkValue(e.getValue(), limits);
                }
                break;
            default:
                break;
        }
    }

    private static int utf8Size(String s) {
        return s.getBytes(StandardCharsets.UTF_8).length;
    }
}
