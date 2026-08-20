package ai.fireweave.sdk.domain;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Fireweave SDK validation — pure, total functions per spec/control-points.md "Validation,
 * before any I/O" and spec/modes.md "Initialisation validation".
 *
 * <p>Every read-path validator here ({@link #validateControlPointKey}, {@link
 * #validateDefaultValue}, {@link #validateContext}, {@link #validateTargetingKey}) returns a
 * {@link Validated} instead of throwing. {@code FireweaveRuntime.evaluate} runs them, in the
 * fixed order the spec names — key, default-vs-type, context, lifecycle — and degrades to the
 * caller's default on the first failure; it NEVER throws (spec/control-points.md "Return
 * discipline — never throw into a read path").
 *
 * <p>{@link #validateInitOptions} is the one named exception (spec/modes.md "Initialisation
 * validation"): its failures are converted to a THROW by the {@code Fireweave.init} composition
 * root. The validator itself still returns a {@link Validated} — the entry point does the
 * throwing, not this class.
 *
 * <p>{@link #validate} and {@link #promoteCanonicalKeys} are throwing bound-check primitives
 * (ported unchanged from the pre-relayer {@code ContextValidator}) that {@link #validateContext}
 * composes into the non-throwing pipeline function the runtime actually calls; both remain
 * independently callable (and independently tested) for direct use.
 */
public final class Validation {

    private Validation() {
    }

    /** Result of a pure validator: success carries the validated value, failure the canonical error. */
    public static final class Validated<T> {
        private final boolean ok;
        private final T value;
        private final FireweaveException error;

        private Validated(boolean ok, T value, FireweaveException error) {
            this.ok = ok;
            this.value = value;
            this.error = error;
        }

        static <T> Validated<T> ok(T value) {
            return new Validated<>(true, value, null);
        }

        static <T> Validated<T> fail(FireweaveException error) {
            return new Validated<>(false, null, error);
        }

        public boolean isOk() {
            return ok;
        }

        /** The validated value on success; null on failure. */
        public T value() {
            return value;
        }

        /** The canonical error on failure; null on success. */
        public FireweaveException error() {
            return error;
        }
    }

    // ------------------------------------------------------------------------------------------
    // Rule 1 — validateControlPointKey (spec/control-points.md "Validation, before any I/O":
    // "key — non-empty, <=256 characters, no control characters")
    // ------------------------------------------------------------------------------------------

    /** C0 + C1 control characters (U+0000-U+001F, U+007F-U+009F). */
    private static final Pattern CONTROL_CHARACTERS = Pattern.compile("[\\x00-\\x1f\\x7f-\\x9f]");

    private static final int MAX_CONTROL_POINT_KEY_LENGTH = 256;

    /**
     * key — non-empty, &lt;=256 characters, no control characters (spec/control-points.md rule
     * 1, the first check in the fixed order).
     *
     * <p>No taxonomy kind names "malformed key" explicitly (the return-discipline table's
     * closest row is "key unknown to the backend" -&gt; FlagNotFound): a key that can never
     * identify a flag is treated the same as one the backend doesn't recognise, so this maps to
     * FlagNotFound too — the node reference implementation's ruled mapping (Task 3 review),
     * carried forward unchanged so every language SDK copying node as the reference agrees.
     */
    public static Validated<String> validateControlPointKey(String key) {
        if (key == null || key.isEmpty()) {
            return Validated.fail(new FireweaveException(
                    ErrorKind.FlagNotFound, "control point key must be a non-empty string"));
        }
        if (key.length() > MAX_CONTROL_POINT_KEY_LENGTH) {
            return Validated.fail(new FireweaveException(
                    ErrorKind.FlagNotFound, "control point key exceeds maximum length"));
        }
        if (CONTROL_CHARACTERS.matcher(key).find()) {
            return Validated.fail(new FireweaveException(
                    ErrorKind.FlagNotFound, "control point key contains control characters"));
        }
        return Validated.ok(key);
    }

    // ------------------------------------------------------------------------------------------
    // Rule 2 — validateDefaultValue (spec/control-points.md rule 2: "default vs type —
    // getBooleanValue with a non-boolean default is TypeMismatch")
    // ------------------------------------------------------------------------------------------

    /**
     * Whether {@code value} matches the shape {@code expected} names. Shared by {@link
     * #validateDefaultValue} (the caller's default, before any I/O) and any post-resolve check
     * an adapter chooses to run on the backend's resolved value — same predicate, two different
     * inputs. {@code OBJECT} accepts both a JSON object and a JSON array (an array is still
     * "an object, not a boolean/string/number" in the sense the surface's {@code getObjectValue}
     * cares about).
     */
    public static boolean matchesExpectedType(JsonValue value, FlagType expected) {
        if (value == null) {
            return false;
        }
        switch (expected) {
            case BOOLEAN:
                return value.kind() == JsonValue.Kind.BOOLEAN;
            case STRING:
                return value.kind() == JsonValue.Kind.STRING;
            case NUMBER:
                return value.kind() == JsonValue.Kind.NUMBER;
            case OBJECT:
                return value.kind() == JsonValue.Kind.OBJECT || value.kind() == JsonValue.Kind.ARRAY;
            default:
                return false;
        }
    }

    /**
     * default vs type — e.g. {@code getBooleanValue} with a non-boolean default is TypeMismatch
     * (spec/control-points.md rule 2, checked before any I/O).
     */
    public static Validated<JsonValue> validateDefaultValue(FlagType expectedType, JsonValue defaultValue) {
        if (!matchesExpectedType(defaultValue, expectedType)) {
            return Validated.fail(new FireweaveException(ErrorKind.TypeMismatch));
        }
        return Validated.ok(defaultValue);
    }

    // ------------------------------------------------------------------------------------------
    // validateTargetingKey (spec/control-points.md "Context": targetingKey)
    // ------------------------------------------------------------------------------------------

    /**
     * targetingKey: "An SDK MUST NOT invent one: a missing targeting key is InvalidContext where
     * the evaluation needs it, never a generated anonymous id" (spec/control-points.md
     * "Context"). {@code required} is call-site policy — the remote adapter always requires one
     * for evaluate/registerTarget (spec/remote-protocol.md "Two identity paths"); the generic
     * context pipeline ({@link #validateContext}) only does when the caller opts in.
     */
    public static Validated<String> validateTargetingKey(String targetingKey, boolean required) {
        if (required && (targetingKey == null || targetingKey.isEmpty())) {
            return Validated.fail(FireweaveException.targetingKeyMissing());
        }
        return Validated.ok(targetingKey);
    }

    // ------------------------------------------------------------------------------------------
    // Rule 3 — validateContext (spec/control-points.md rule 3: "context — depth, key count,
    // value size, reserved keys (evaluation-context.schema.json)")
    // ------------------------------------------------------------------------------------------

    /** Attribute names that must never appear as ordinary person attributes. */
    public static final String RESERVED_PREFIX = "fireweave.";

    /** Canonical reserved context key carrying group memberships (rulings 12-14). */
    public static final String GROUPS_KEY = "fireweave.groups";

    /** Canonical reserved context key carrying group properties (rulings 12-14). */
    public static final String GROUP_PROPERTIES_KEY = "fireweave.groupProperties";

    /**
     * The ONLY permitted {@code fireweave.*} context keys (ruling 13). Every other
     * {@code fireweave.*} key is rejected as {@code InvalidContext}.
     */
    private static final Set<String> CANONICAL_RESERVED_KEYS =
            new java.util.HashSet<>(java.util.Arrays.asList(GROUPS_KEY, GROUP_PROPERTIES_KEY));

    /**
     * Promote the canonical {@code fireweave.groups} / {@code fireweave.groupProperties} context
     * keys (rulings 12-14: the primary cross-language path; the {@code .group()} builder is
     * idiomatic sugar over the same canonical representation) into the context's first-class
     * groups / groupProperties fields. Malformed shapes (non-object values, non-string group
     * keys) raise {@code InvalidContext}. Attribute spellings win over builder-set entries on
     * conflict (later-wins, consistent with merge semantics).
     */
    public static EvaluationContext promoteCanonicalKeys(EvaluationContext context) throws FireweaveException {
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
                if (e.getValue().kind() != JsonValue.Kind.STRING || e.getValue().asString().isEmpty()) {
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

    /**
     * Bound checks only (attribute count / key size / value size / nesting depth / serialized
     * size / reserved keys) against an ALREADY-promoted-or-tolerated context. Direct callers
     * (e.g. tests) may pass a context whose {@code fireweave.groups}/{@code
     * fireweave.groupProperties} attributes have not been promoted by {@link
     * #promoteCanonicalKeys} — the two canonical keys are tolerated here too, so this function
     * does not require the promotion step as a precondition. Does NOT check {@link
     * EvaluationContext#hadCyclicInput()} — that is {@link #validateContext}'s job, run first.
     *
     * <p>Throws {@link FireweaveException} with kind {@link ErrorKind#InvalidContext} (or {@code
     * TARGETING_KEY_MISSING} for a missing targeting key). Messages are fixed, safe strings;
     * attribute values (which may contain PII) are never echoed into error messages.
     */
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

    /**
     * The full pre-I/O context pipeline (spec/control-points.md rule 3): checks {@link
     * EvaluationContext#hadCyclicInput()} FIRST — a cyclic context fails closed as {@code
     * InvalidContext} before any other rule runs, matching node's {@code validateContext}
     * ordering and python's ratified fix (Task 7 review round) — then promotes the canonical
     * {@code fireweave.groups}/{@code fireweave.groupProperties} keys ({@link
     * #promoteCanonicalKeys}), then runs the bound checks ({@link #validate}). This is what
     * {@code FireweaveRuntime.evaluate} calls; it never throws.
     */
    public static Validated<EvaluationContext> validateContext(EvaluationContext merged,
                                                                boolean requireTargetingKey,
                                                                ContextLimits limits,
                                                                Set<String> reservedAttributeKeys) {
        if (merged.hadCyclicInput()) {
            return Validated.fail(new FireweaveException(
                    ErrorKind.InvalidContext, "context contains a circular reference"));
        }
        EvaluationContext promoted;
        try {
            promoted = promoteCanonicalKeys(merged);
        } catch (FireweaveException e) {
            return Validated.fail(e);
        }
        try {
            validate(promoted, requireTargetingKey, limits, reservedAttributeKeys);
        } catch (FireweaveException e) {
            return Validated.fail(e);
        }
        return Validated.ok(promoted);
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

    // ------------------------------------------------------------------------------------------
    // validateInitOptions (spec/modes.md "Initialisation validation")
    // ------------------------------------------------------------------------------------------

    /** "missing" and "blank" collapse to one check: not a non-empty, non-whitespace string. */
    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    /**
     * Initialisation-validation table (spec/modes.md), the three rows representable at this
     * layer:
     * <ul>
     *   <li>{@code mode} absent (the Java analogue of "absent or unrecognised" — an enum-typed
     *       field cannot hold an out-of-range value, so "unrecognised" cannot occur)</li>
     *   <li>{@code mode == REMOTE} with {@code apiKey} or {@code apiUrl} missing/blank</li>
     *   <li>{@code mode == LOCAL} with credentials supplied (a config half-migrated from remote
     *       to local reads as neither, silently — reject it instead)</li>
     * </ul>
     *
     * <p>The table's fourth row ("apiUrl fails the host allowlist") is intentionally NOT checked
     * here — that check runs downstream, when the remote adapter's own {@code initialize()}
     * brings it up (mirrors node's {@code validateInitOptions} module doc for the same reason:
     * host-allowlist checking belongs to infrastructure, which this domain-layer function must
     * not depend on).
     */
    public static Validated<Boolean> validateInitOptions(Mode mode, String apiKey, String apiUrl) {
        if (mode == null) {
            return Validated.fail(new FireweaveException(
                    ErrorKind.Configuration, "mode is required and must be LOCAL or REMOTE"));
        }
        if (mode == Mode.REMOTE) {
            if (isBlank(apiKey) || isBlank(apiUrl)) {
                return Validated.fail(new FireweaveException(
                        ErrorKind.Configuration, "mode REMOTE requires apiKey and apiUrl"));
            }
            return Validated.ok(Boolean.TRUE);
        }
        if (!isBlank(apiKey) || !isBlank(apiUrl)) {
            return Validated.fail(new FireweaveException(ErrorKind.Configuration,
                    "mode LOCAL must not be combined with apiKey/apiUrl — the caller means one or the other"));
        }
        return Validated.ok(Boolean.TRUE);
    }
}
