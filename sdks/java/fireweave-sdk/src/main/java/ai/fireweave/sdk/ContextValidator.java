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

    private ContextValidator() {
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
            if (key.startsWith(RESERVED_PREFIX)
                    || (reservedAttributeKeys != null && reservedAttributeKeys.contains(key))) {
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
